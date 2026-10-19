import { expect, test } from "vite-plus/test";
import { parseOptions } from "../cliOptions.js";
import { resolveTrustedConfig } from "./hisyoConfig.js";

function input(env: Record<string, string> = {}) {
  const variables: string[] = [];
  return {
    variables,
    homeDirectory: "/home/unit",
    readEnv(name: string) {
      variables.push(name);
      return env[name];
    },
  };
}

test("configuration selects only state and credential locations, not executable or global models", () => {
  const resolved = resolveTrustedConfig(parseOptions([]), input());
  expect(resolved).toEqual({
    dataDirectory: "/home/unit/.mc-hisyo",
    agentDirectory: "/home/unit/.pi/agent",
  });
  expect(Object.isFrozen(resolved)).toBe(true);
});

test("explicit credential directory overrides ambient Pi directory", () => {
  const source = input({ PI_CODING_AGENT_DIR: "/ambient" });
  const resolved = resolveTrustedConfig(
    parseOptions(["--pi-agent-dir", "/flag", "--data-dir", "/state"]),
    source,
  );
  expect(resolved).toEqual({ dataDirectory: "/state", agentDirectory: "/flag" });
  expect(source.variables).not.toContain("PI_CODING_AGENT_DIR");
  expect(
    resolveTrustedConfig(parseOptions([]), input({ PI_CODING_AGENT_DIR: "/ambient" })),
  ).toHaveProperty("agentDirectory", "/ambient");
});

test("expands home paths and keeps only the selected environment variable name", () => {
  const source = input({ KEY: "SECRET_SENTINEL" });
  const resolved = resolveTrustedConfig(
    parseOptions([
      "--pi-agent-dir",
      "~/credentials",
      "--data-dir",
      "~/state",
      "--api-key-env",
      "KEY",
    ]),
    source,
  );
  expect(resolved).toEqual({
    dataDirectory: "/home/unit/state",
    agentDirectory: "/home/unit/credentials",
    apiKeyEnv: "KEY",
  });
  expect(source.variables).not.toContain("KEY");
  expect(JSON.stringify(resolved)).not.toContain("SECRET_SENTINEL");
});

test("empty ambient credential paths fail rather than selecting another source", () => {
  expect(() => resolveTrustedConfig(parseOptions([]), input({ PI_CODING_AGENT_DIR: " " }))).toThrow(
    "paths must be nonempty",
  );
});
