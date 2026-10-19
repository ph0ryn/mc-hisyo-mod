import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.mjs");

async function fixture(t) {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, "hisyo-cli-smoke-"));
  t.after(async () => {
    // Only remove this fixture's exact, canonical temporary directory.
    assert.equal(dirname(directory), parent);
    assert.ok(directory.startsWith(join(parent, "hisyo-cli-smoke-")));
    assert.equal(await realpath(directory), directory);
    await rm(directory, { recursive: true });
  });
  return directory;
}

function run(args, directory, stopWhenReady = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      // No inherited model keys, login store, executable lookup, or Node hooks.
      env: {
        PATH: "/no-pi-on-path",
        HOME: join(directory, "unused-home"),
        HISYO_SMOKE_KEY: "SMOKE_CREDENTIAL_SENTINEL",
      },
      stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(10_000),
    });
    let stdout = "";
    let stderr = "";
    let stopped = false;
    child.stdout.setEncoding("utf8").on("data", (text) => {
      stdout += text;
      if (stopWhenReady && !stopped && stdout.includes("Bridge ready at 127.0.0.1:")) {
        stopped = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.setEncoding("utf8").on("data", (text) => {
      stderr += text;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

test("built help needs no Pi executable, credentials, or state", async (t) => {
  const directory = await fixture(t);
  const result = await run(["--help"], directory);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Usage: hisyo/);
  assert.doesNotMatch(result.stdout, /--pi PATH|--provider|--model ID/);
  assert.deepEqual(await readdir(directory), []);
});

test("built normal CLI starts and closes with no Pi on PATH", async (t) => {
  const directory = await fixture(t);
  const state = join(directory, "state");
  const result = await run(
    ["--data-dir", state, "--api-key-env", "HISYO_SMOKE_KEY"],
    directory,
    true,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /Bridge ready at 127\.0\.0\.1:/);
  assert.doesNotMatch(result.stdout + result.stderr, /SMOKE_CREDENTIAL_SENTINEL/);
  assert.deepEqual((await readdir(state)).toSorted(), [
    "activityLog.sqlite",
    "eventLog.sqlite",
    "summary.sqlite",
  ]);
});

test("built CLI rejects removed executable flags without creating state", async (t) => {
  const directory = await fixture(t);
  const result = await run(
    ["--pi", "/unused/pi", "--data-dir", join(directory, "state")],
    directory,
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Invalid arguments/);
  assert.doesNotMatch(result.stdout + result.stderr, /SMOKE_CREDENTIAL_SENTINEL/);
  assert.deepEqual(await readdir(directory), []);
});
