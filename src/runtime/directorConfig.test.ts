import { expect, test } from "vite-plus/test";
import { parseOptions, cliErrorMessage } from "../cliOptions.js";
import { resolveTrustedConfig } from "./directorConfig.js";

const key = " SECRET_SENTINEL ";
function input(files: Record<string, string> = {}, env: Record<string, string> = {}) {
  const reads: string[] = [];
  const variables: string[] = [];
  return {
    reads,
    variables,
    homeDirectory: "/home/unit",
    readText(path: string) {
      reads.push(path);
      if (!(path in files)) throw Object.assign(new Error("SECRET_SENTINEL"), { code: "ENOENT" });
      return files[path]!;
    },
    readEnv(name: string) {
      variables.push(name);
      return env[name];
    },
  };
}
const pair = ["--provider", "p", "--model", "m"];
const auth = (value: unknown) => ({ "/home/unit/.pi/agent/auth.json": JSON.stringify(value) });
const models = (value: unknown) => ({ "/home/unit/.pi/agent/models.json": JSON.stringify(value) });

test("snapshots explicit selector/key and skips settings and unused auth", () => {
  const source = input(
    {
      ...auth({ p: { type: "oauth" } }),
      ...models({ providers: { p: { apiKey: "!unused" }, other: { models: "ignored" } } }),
    },
    { KEY: key },
  );
  const resolved = resolveTrustedConfig(parseOptions([...pair, "--api-key-env", "KEY"]), source);
  expect(resolved.model).toEqual({ provider: "p", id: "m", apiKey: key });
  expect(Object.isFrozen(resolved)).toBe(true);
  expect(Object.isFrozen(resolved.model)).toBe(true);
  expect(source.reads).toEqual(["/home/unit/.pi/agent/models.json"]);
  expect(source.variables).not.toContain("unused");
});

test("global pair and stored key take precedence over unused models credential", () => {
  const source = input(
    {
      "/home/unit/.pi/agent/settings.json": '{"defaultProvider":"p","defaultModel":"m"}',
      ...auth({ p: { type: "api_key", key: "${KEY}" }, ignored: { type: "oauth" } }),
      ...models({ providers: { p: { apiKey: "!unused" } } }),
    },
    { KEY: key },
  );
  expect(resolveTrustedConfig(parseOptions([]), source).model.apiKey).toBe(key);
});

test("models credential is the last source and unrelated expressions are never evaluated", () => {
  const source = input(
    models({ providers: { p: { apiKey: key }, other: { apiKey: "!never", models: [] } } }),
  );
  expect(resolveTrustedConfig(parseOptions(pair), source).model.apiKey).toBe(key);
});

test.each([undefined, ""])("explicit missing/empty env has no fallback: %s", (value) => {
  const source = input(
    auth({ p: { type: "api_key", key } }),
    value === undefined ? {} : { KEY: value },
  );
  expect(() =>
    resolveTrustedConfig(parseOptions([...pair, "--api-key-env", "KEY"]), source),
  ).toThrow();
  expect(source.reads).not.toContain("/home/unit/.pi/agent/auth.json");
});

test("input directory precedence and canonical snapshot paths", () => {
  const source = input(
    { "/flag/auth.json": JSON.stringify({ p: { type: "api_key", key } }) },
    { PI_CODING_AGENT_DIR: "/ambient" },
  );
  const resolved = resolveTrustedConfig(
    parseOptions([...pair, "--pi-agent-dir", "/flag", "--data-dir", "/state", "--pi", "/bin/pi"]),
    source,
  );
  expect(resolved).toMatchObject({
    agentDirectory: "/flag",
    dataDirectory: "/state",
    executable: "/bin/pi",
  });
  expect(source.variables).not.toContain("PI_CODING_AGENT_DIR");
  const ambient = input(
    { "/ambient/auth.json": JSON.stringify({ p: { type: "api_key", key } }) },
    { PI_CODING_AGENT_DIR: "/ambient" },
  );
  expect(resolveTrustedConfig(parseOptions(pair), ambient).agentDirectory).toBe("/ambient");
});

test.each([
  { type: "oauth", key },
  { type: "api_key", key, env: {} },
  { type: "api_key", key: "!SECRET_SENTINEL" },
  { type: "api_key", key: "prefix${KEY}" },
  { type: "api_key", key: "${BAD-NAME}" },
  { type: "api_key", key: "${KEY" },
  { type: "api_key", key: "" },
  { type: "api_key", key: 1 },
  null,
])("selected unsupported/malformed credentials fail redacted: %j", (credential) => {
  try {
    resolveTrustedConfig(parseOptions(pair), input(auth({ p: credential })));
    throw new Error("unexpected success");
  } catch (error) {
    expect(cliErrorMessage(error)).not.toContain("SECRET_SENTINEL");
    expect(cliErrorMessage(error)).not.toBe("Director operation failed.");
  }
});

test.each([
  "models",
  "modelOverrides",
  "baseUrl",
  "baseURL",
  "headers",
  "compat",
  "api",
  "oauth",
  "authHeader",
])("selected %s override is rejected even with explicit key", (field) => {
  const source = input(models({ providers: { p: { apiKey: "!unused", [field]: {} } } }), {
    KEY: key,
  });
  expect(() =>
    resolveTrustedConfig(parseOptions([...pair, "--api-key-env", "KEY"]), source),
  ).toThrow();
});

test.each([
  "{SECRET_SENTINEL",
  "// JSONC\n{}",
  "[]",
  "null",
  '{"defaultProvider":"p"}',
  '{"defaultProvider":"","defaultModel":"m"}',
  '{"defaultProvider":1,"defaultModel":"m"}',
])("invalid settings do not become empty defaults: %s", (text) => {
  try {
    resolveTrustedConfig(parseOptions([]), input({ "/home/unit/.pi/agent/settings.json": text }));
    throw new Error("unexpected success");
  } catch (error) {
    expect(cliErrorMessage(error)).not.toContain("SECRET_SENTINEL");
    expect(cliErrorMessage(error)).not.toBe("Director operation failed.");
  }
});

test.each(["auth.json", "models.json"])(
  "invalid %s is retained as a redacted config failure",
  (file) => {
    const source = input({ [`/home/unit/.pi/agent/${file}`]: "SECRET_SENTINEL" });
    expect(() => resolveTrustedConfig(parseOptions(pair), source)).toThrow();
  },
);

test("only actual ENOENT is optional; read failures retain a fixed config diagnostic", () => {
  for (const code of ["EACCES", "EIO", undefined]) {
    const source = {
      ...input(),
      readText() {
        throw Object.assign(new Error("SECRET_SENTINEL"), { code });
      },
    };
    try {
      resolveTrustedConfig(parseOptions([...pair, "--api-key-env", "KEY"]), source);
      throw new Error("unexpected success");
    } catch (error) {
      expect(cliErrorMessage(error)).toContain("read");
      expect(cliErrorMessage(error)).not.toContain("SECRET_SENTINEL");
    }
  }
});

test("models accepts whole env references and preserves literal/environment key bytes", () => {
  const source = input(models({ providers: { p: { apiKey: "${KEY}" } } }), {
    KEY: " !SECRET_SENTINEL${not_recursive} ",
  });
  expect(resolveTrustedConfig(parseOptions(pair), source).model.apiKey).toBe(
    " !SECRET_SENTINEL${not_recursive} ",
  );
  expect(source.variables).not.toContain("not_recursive");
  expect(
    resolveTrustedConfig(
      parseOptions(pair),
      input(auth({ p: { type: "api_key", key: "literal}key" } })),
    ).model.apiKey,
  ).toBe("literal}key");
});

test("selected models credential type is validated without resolving unused expressions", () => {
  for (const apiKey of [null, 123, {}]) {
    const source = input(models({ providers: { p: { apiKey } } }), { KEY: key });
    expect(() =>
      resolveTrustedConfig(parseOptions([...pair, "--api-key-env", "KEY"]), source),
    ).toThrow();
  }
});

test("missing credentials and provider-prefixed model never fall back", () => {
  expect(() => resolveTrustedConfig(parseOptions(pair), input())).toThrow();
  expect(() =>
    resolveTrustedConfig(
      parseOptions(["--provider", "p", "--model", "p/m", "--api-key-env", "KEY"]),
      input({}, { KEY: key }),
    ),
  ).toThrow();
});
