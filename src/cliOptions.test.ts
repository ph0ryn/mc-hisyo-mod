import { expect, test } from "vite-plus/test";
import { cliErrorMessage, parseOptions, usage } from "./cliOptions.js";

test("parses the existing modes and only the authorized Pi flags", () => {
  expect(parseOptions([])).toEqual({ help: false, bridgeOnly: false, executable: "pi" });
  expect(parseOptions(["--help"]).help).toBe(true);
  expect(parseOptions(["--bridge-only", "--data-dir", "/state"]).bridgeOnly).toBe(true);
  expect(
    parseOptions([
      "--pi",
      "/bin/pi",
      "--provider",
      "p",
      "--model",
      "m",
      "--pi-agent-dir",
      "/input",
      "--api-key-env",
      "KEY",
    ]),
  ).toEqual({
    help: false,
    bridgeOnly: false,
    executable: "/bin/pi",
    provider: "p",
    model: "m",
    agentDirectory: "/input",
    apiKeyEnv: "KEY",
  });
  expect(usage).not.toContain("not available");
});

test.each(["--pi", "--provider", "--model", "--pi-agent-dir", "--api-key-env"])(
  "bridge-only rejects explicit %s",
  (flag) => {
    expect(() => parseOptions(["--bridge-only", flag, "value"])).toThrow();
  },
);

test.each(
  [
    ["--unknown=SECRET_SENTINEL"],
    ["SECRET_SENTINEL"],
    ["--pi"],
    ["--pi", ""],
    ["--data-dir", ""],
    ["--provider", "p"],
    ["--model", "m"],
    ["--provider", "", "--model", "m"],
    ["--api-key-env", "BAD-NAME"],
  ].map((args) => ({ args })),
)("rejects invalid arguments without reflecting input: $args", ({ args }) => {
  try {
    parseOptions(args);
    throw new Error("unexpected success");
  } catch (error) {
    expect(cliErrorMessage(error)).not.toContain("SECRET_SENTINEL");
    expect(cliErrorMessage(error)).not.toBe("Director operation failed.");
  }
});

test("operational errors, causes and aggregate members are never printed", () => {
  const secret = new Error("SECRET_SENTINEL", { cause: "SECRET_SENTINEL" });
  expect(cliErrorMessage(secret)).toBe("Director operation failed.");
  expect(cliErrorMessage(new AggregateError([secret], "SECRET_SENTINEL"))).toBe(
    "Director operation failed.",
  );
});
