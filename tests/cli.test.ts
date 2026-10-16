import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["dist/cli.mjs", ...args], {
    encoding: "utf8",
    timeout: 5_000,
  });
}

describe("packaged CLI", () => {
  it("prints usage without starting Pi or connecting to Minecraft", () => {
    const result = runCli("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: ai-director");
    expect(result.stderr).toBe("");
  });

  it("reports unsupported arguments instead of pretending to run", () => {
    const result = runCli("--unknown");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown option");
  });
});
