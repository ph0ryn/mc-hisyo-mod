import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { createModelAccess } from "./modelAccess.js";

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "hisyo-model-access-")));
  onTestFinished(() => rmSync(directory, { recursive: true }));
  return {
    directory,
    config: { dataDirectory: join(directory, "state"), agentDirectory: directory },
  };
}

test("native SDK selection pins Luna and never loads global models/settings or requires PATH", async () => {
  const f = fixture();
  vi.stubEnv("PATH", "");
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
  onTestFinished(() => {
    vi.unstubAllEnvs();
    fetch.mockRestore();
  });
  writeFileSync(
    join(f.directory, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "stored-key" } }),
  );
  writeFileSync(join(f.directory, "models.json"), "malformed SECRET_SENTINEL !command");
  writeFileSync(join(f.directory, "settings.json"), "malformed SECRET_SENTINEL !command");
  const access = await createModelAccess(f.config, { readEnv: () => undefined });
  expect(access.model).toMatchObject({
    provider: "openai",
    id: "gpt-6-luna",
    api: "openai-responses",
  });
  expect(access.models.getProviders().map((provider) => provider.id)).toEqual(["openai"]);
  expect((await access.models.getAuth(access.model))?.auth.apiKey).toBe("stored-key");
  expect(JSON.stringify(access.model)).not.toContain("stored-key");
  expect(fetch).not.toHaveBeenCalled();
  await access.close();
  expect(() => access.models.getAuth(access.model)).toThrow("Unable to access");
});

test("explicit API-key environment source touches no stored credential or global files", async () => {
  const f = fixture();
  writeFileSync(join(f.directory, "auth.json"), "unreadable SECRET_SENTINEL");
  const variables: string[] = [];
  const access = await createModelAccess(
    { ...f.config, apiKeyEnv: "KEY" },
    {
      readEnv: (name) => {
        variables.push(name);
        return name === "KEY" ? " !literal${value} " : "ambient-must-not-win";
      },
    },
  );
  expect((await access.models.getAuth(access.model))?.auth.apiKey).toBe(" !literal${value} ");
  expect(variables).toEqual(["KEY"]);
  expect(readdirSync(f.directory)).toEqual(["auth.json"]);
});

test("native SDK refresh uses the issued client and shares rotation with another model owner", async () => {
  const f = fixture();
  const path = join(f.directory, "auth.json");
  writeFileSync(
    path,
    JSON.stringify({
      openai: {
        type: "oauth",
        access: "old-access",
        refresh: "original-refresh",
        expires: 1,
        clientId: "issued-client",
        scopes: ["chatgpt.tokens.use.direct"],
      },
      unrelated: { type: "api_key", key: "!never" },
    }),
  );
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(url).toBe("https://auth.openai.com/api/accounts/oauth/token");
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    const body = init!.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("original-refresh");
    expect(body.get("client_id")).toBe("issued-client");
    return new Response(
      JSON.stringify({
        access_token: "new-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
        scope: "chatgpt.tokens.use.direct",
      }),
    );
  });
  onTestFinished(() => fetch.mockRestore());
  const first = await createModelAccess(f.config);
  const second = await createModelAccess(f.config);
  const results = await Promise.all([
    first.models.getAuth(first.model),
    second.models.getAuth(second.model),
  ]);
  expect(results.map((value) => value?.auth.apiKey)).toEqual(["new-access", "new-access"]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    openai: {
      refresh: "rotated-refresh",
      clientId: "issued-client",
      scopes: ["chatgpt.tokens.use.direct"],
    },
    unrelated: { key: "!never" },
  });
  await Promise.all([first.close(), second.close()]);
});

test("native refresh failure exposes neither response secrets nor nested causes", async () => {
  const f = fixture();
  writeFileSync(
    join(f.directory, "auth.json"),
    JSON.stringify({
      openai: {
        type: "oauth",
        access: "old-access",
        refresh: "old-refresh",
        expires: 1,
        clientId: "issued-client",
      },
    }),
  );
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("SECRET_SENTINEL", { status: 401 }));
  onTestFinished(() => fetch.mockRestore());
  const access = await createModelAccess(f.config);
  const error = await access.models.getAuth(access.model).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain("SECRET_SENTINEL");
  expect((error as Error).cause).toBeUndefined();
  await expect(access.close()).rejects.toThrow("Unable to access");
});

test.each([undefined, "", " "])(
  "missing explicit environment credential never falls back: %s",
  async (key) => {
    const f = fixture();
    writeFileSync(
      join(f.directory, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "stored-key" } }),
    );
    await expect(
      createModelAccess({ ...f.config, apiKeyEnv: "KEY" }, { readEnv: () => key }),
    ).rejects.toThrow("No credential");
  },
);

test("a missing stored credential does not use ambient OPENAI_API_KEY", async () => {
  const f = fixture();
  writeFileSync(join(f.directory, "auth.json"), "{}");
  await expect(
    createModelAccess(f.config, { readEnv: () => "ambient-must-not-win" }),
  ).rejects.toThrow("No credential");
});
