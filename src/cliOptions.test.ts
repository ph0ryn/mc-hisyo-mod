import { expect, test } from "vite-plus/test";
import { cliErrorMessage, parseOptions, usage } from "./cliOptions.js";

test("parses only modes, state directory, and explicit credential sources", () => {
  expect(parseOptions([])).toEqual({ help: false, bridgeOnly: false });
  expect(parseOptions(["--help"]).help).toBe(true);
  expect(parseOptions(["--bridge-only", "--data-dir", "/state"]).bridgeOnly).toBe(true);
  expect(parseOptions(["--pi-agent-dir", "/input", "--api-key-env", "KEY"])).toEqual({
    help: false,
    bridgeOnly: false,
    agentDirectory: "/input",
    apiKeyEnv: "KEY",
  });
  expect(usage).toContain("openai/gpt-6-luna");
  expect(usage).not.toContain("Pi executable");
  expect(usage).not.toContain("--provider");
  expect(usage).not.toContain("--model");
});

test.each(["--pi-agent-dir", "--api-key-env"])("bridge-only rejects explicit %s", (flag) => {
  expect(() => parseOptions(["--bridge-only", flag, "value"])).toThrow();
});

test.each(
  [
    ["--unknown=SECRET_SENTINEL"],
    ["SECRET_SENTINEL"],
    ["--pi", "/bin/pi"],
    ["--provider", "openai"],
    ["--model", "gpt-6-luna"],
    ["--data-dir", ""],
    ["--pi-agent-dir", ""],
    ["--api-key-env", "BAD-NAME"],
  ].map((args) => ({ args })),
)("rejects obsolete/invalid arguments without reflecting input: $args", ({ args }) => {
  try {
    parseOptions(args);
    throw new Error("unexpected success");
  } catch (error) {
    expect(cliErrorMessage(error)).not.toContain("SECRET_SENTINEL");
    expect(cliErrorMessage(error)).not.toBe("Hisyo operation failed.");
  }
});

test("operational errors, causes and aggregate members are never printed", () => {
  const secret = new Error("SECRET_SENTINEL", { cause: "SECRET_SENTINEL" });
  expect(cliErrorMessage(secret)).toBe("Hisyo operation failed.");
  expect(cliErrorMessage(new AggregateError([secret], "SECRET_SENTINEL"))).toBe(
    "Hisyo operation failed.",
  );
});
