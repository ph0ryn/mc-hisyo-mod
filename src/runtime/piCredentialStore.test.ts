import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, type OAuthCredential } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { PiCredentialStore } from "./piCredentialStore.js";

const expired: OAuthCredential = {
  type: "oauth",
  access: "old-access",
  refresh: "old-refresh",
  expires: 1,
};
const rotated: OAuthCredential = {
  type: "oauth",
  access: "new-access",
  refresh: "new-refresh",
  expires: Date.now() + 3_600_000,
};
function fixture(
  credential: unknown = expired,
  readEnv = (_name: string): string | undefined => undefined,
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "hisyo-sdk-auth-")));
  const path = join(directory, "auth.json");
  const unrelated = { type: "api_key", key: "!must-not-execute" };
  writeFileSync(path, JSON.stringify({ openai: credential, unrelated }), { mode: 0o600 });
  onTestFinished(() => rmSync(directory, { recursive: true }));
  const store = () => new PiCredentialStore(path, readEnv);
  const client = (
    refresh: (value: OAuthCredential, signal: AbortSignal) => Promise<OAuthCredential>,
  ) => {
    const fake = fauxProvider({ provider: "openai", models: [{ id: "gpt-6-luna" }] });
    const credentials = store();
    const models = createModels({
      credentials,
      authContext: { env: async () => "ambient-must-not-win", fileExists: async () => false },
    });
    models.setProvider({
      ...fake.provider,
      auth: {
        apiKey: openaiProvider().auth.apiKey!,
        oauth: {
          name: "fake OAuth",
          login: async () => expired,
          refresh,
          toAuth: async (value) => ({ apiKey: value.access }),
        },
      },
    });
    return { models, fake, credentials };
  };
  return {
    path,
    directory,
    store,
    client,
    unrelated,
    read: () => JSON.parse(readFileSync(path, "utf8")),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("two SDK clients serialize refresh and persist the rotated grant in the original store", async () => {
  const f = fixture();
  const refresh = vi.fn(async () => rotated);
  const first = f.client(refresh);
  const second = f.client(refresh);
  const results = await Promise.all([
    first.models.getAuth("openai"),
    second.models.getAuth("openai"),
  ]);
  expect(results.map((value) => value?.auth.apiKey)).toEqual(["new-access", "new-access"]);
  expect(refresh).toHaveBeenCalledOnce();
  expect(f.read()).toEqual({ openai: rotated, unrelated: f.unrelated });
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
});

test("cancellation suppresses dispatch but cannot discard an in-flight refresh token rotation", async () => {
  const f = fixture();
  const entered = deferred<void>();
  const finish = deferred<OAuthCredential>();
  const refresh = vi.fn(async () => {
    entered.resolve();
    return finish.promise;
  });
  const first = f.client(refresh);
  const stop = new AbortController();
  const result = first.models.completeSimple(
    first.fake.getModel(),
    { messages: [{ role: "user", content: "cancel", timestamp: 1 }] },
    { signal: stop.signal },
  );
  await entered.promise;
  stop.abort();
  finish.resolve(rotated);
  const second = f.client(refresh);
  await second.models.getAuth("openai");
  const message = await result;
  expect(["aborted", "error"]).toContain(message.stopReason);
  expect(first.fake.state.callCount).toBe(0);
  expect(refresh).toHaveBeenCalledOnce();
  expect(f.read().openai).toEqual(rotated);
});

test("failed OAuth never falls back to ambient credentials or calls the provider", async () => {
  const f = fixture();
  const client = f.client(async () => {
    throw new Error("private refresh failure");
  });
  const message = await client.models.completeSimple(client.fake.getModel(), { messages: [] });
  expect(message.stopReason).toBe("error");
  expect(message.errorMessage).not.toContain("private refresh failure");
  expect(client.fake.state.callCount).toBe(0);
  expect(f.read().openai).toEqual(expired);
  await expect(client.credentials.close()).rejects.toThrow("Unable to access");
});

test.each([
  { type: "api_key", key: "!echo SECRET_SENTINEL" },
  { type: "api_key", key: "  !echo SECRET_SENTINEL" },
  { type: "api_key", key: "prefix${KEY}" },
  { type: "api_key", key: "${BAD-NAME}" },
  { type: "api_key", key: "" },
  { type: "api_key", key: "literal", env: { OPENAI_BASE_URL: "override" } },
  { type: "oauth", access: "", refresh: "SECRET_SENTINEL", expires: 1 },
  { type: "oauth", access: "SECRET_SENTINEL", refresh: "x", expires: "1" },
  null,
])(
  "selected malformed/command credentials fail redacted before SDK resolution: %j",
  async (credential) => {
    const f = fixture(credential);
    const error = await f
      .store()
      .read("openai")
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("SECRET_SENTINEL");
    expect((error as Error).cause).toBeUndefined();
  },
);

test("whole environment references resolve once without mutating stored credentials", async () => {
  const key = " !literal${not_recursive} ";
  const f = fixture({ type: "api_key", key: "${KEY}" }, (name) =>
    name === "KEY" ? key : undefined,
  );
  expect(await f.store().read("openai")).toEqual({ type: "api_key", key });
  expect(f.read().openai.key).toBe("${KEY}");
});

test("the locked refresh revalidates the current record instead of trusting an earlier snapshot", async () => {
  const f = fixture();
  const store = f.store();
  expect(await store.read("openai")).toEqual(expired);
  writeFileSync(f.path, JSON.stringify({ openai: { type: "api_key", key: "!SECRET_SENTINEL" } }));
  const update = vi.fn(async () => rotated);
  await expect(store.modify("openai", update)).rejects.toThrow("unsupported");
  expect(update).not.toHaveBeenCalled();
});

test("close drains the real SDK mutation after caller cancellation and rejects new work", async () => {
  const f = fixture();
  const store = f.store();
  const entered = deferred<void>();
  const finish = deferred<OAuthCredential>();
  const models = createModels({ credentials: store });
  const fake = fauxProvider({ provider: "openai" });
  models.setProvider({
    ...fake.provider,
    auth: {
      oauth: {
        name: "fake OAuth",
        login: async () => expired,
        refresh: async () => {
          entered.resolve();
          return finish.promise;
        },
        toAuth: async (value) => ({ apiKey: value.access }),
      },
    },
  });
  const stop = new AbortController();
  const request = models.getAuth("openai", { signal: stop.signal });
  const cancelled = expect(request).rejects.toThrow();
  await entered.promise;
  stop.abort();
  await cancelled;
  let closed = false;
  const closing = store.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  await expect(store.read("openai")).rejects.toThrow();
  finish.resolve({ ...rotated, clientId: "original-client", scopes: ["scope"] });
  await closing;
  expect(f.read().openai).toEqual({ ...rotated, clientId: "original-client", scopes: ["scope"] });
});

test.each(["refresh", "save"])(
  "cancelled SDK caller cannot hide a later %s failure from close",
  async (failure) => {
    const f = fixture();
    const store = f.store();
    const entered = deferred<void>();
    const finish = deferred<void>();
    const models = createModels({ credentials: store });
    const fake = fauxProvider({ provider: "openai" });
    models.setProvider({
      ...fake.provider,
      auth: {
        oauth: {
          name: "fake OAuth",
          login: async () => expired,
          refresh: async () => {
            entered.resolve();
            await finish.promise;
            if (failure === "refresh") throw new Error("SECRET_SENTINEL");
            return rotated;
          },
          toAuth: async (value) => ({ apiKey: value.access }),
        },
      },
    });
    const stop = new AbortController();
    const request = models.getAuth("openai", { signal: stop.signal });
    const cancelled = expect(request).rejects.toThrow();
    await entered.promise;
    stop.abort();
    await cancelled;
    if (failure === "save") {
      // Literal fixture I/O failure: preserve the old file and obstruct atomic replacement.
      renameSync(f.path, join(f.directory, "original.json"));
      mkdirSync(f.path);
    }
    const closing = store.close().catch((error: unknown) => error);
    finish.resolve();
    const error = await closing;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("SECRET_SENTINEL");
    expect((error as Error).cause).toBeUndefined();
  },
);

test("a failed update blocks later mutation attempts instead of retrying an uncertain grant", async () => {
  const f = fixture();
  const store = f.store();
  await expect(
    store.modify("openai", async () => {
      throw new Error("SECRET_SENTINEL");
    }),
  ).rejects.toThrow();
  const update = vi.fn(async () => rotated);
  await expect(store.modify("openai", update)).rejects.toThrow();
  expect(update).not.toHaveBeenCalled();
  await expect(store.close()).rejects.toThrow();
});

test("credential aliases are rejected rather than creating another lock domain", async () => {
  const f = fixture();
  const alias = join(f.directory, "alias.json");
  symlinkSync(f.path, alias);
  await expect(new PiCredentialStore(alias).read("openai")).rejects.toThrow("unsupported");
});

test("invalid JSON and I/O failures have fixed diagnostics with no credential cause", async () => {
  const f = fixture();
  writeFileSync(f.path, "SECRET_SENTINEL");
  for (const store of [f.store(), new PiCredentialStore(join(f.path, "not-a-file"))]) {
    const error = await store.read("openai").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("SECRET_SENTINEL");
    expect((error as Error).cause).toBeUndefined();
  }
});
