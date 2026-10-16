import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import type { WorldBinding } from "../protocol/bridge.js";
import { piFixture as fixture } from "./fixtures/piHarness.js";

test("isolates launch settings, tools and environment, and scopes the private conversation", async () => {
  const f = await fixture();
  vi.stubEnv("MC_HISYO_AMBIENT_SECRET", "must-not-inherit");
  vi.stubEnv("OPENAI_API_KEY", "must-not-inherit");
  vi.stubEnv("PI_CODING_AGENT_DIR", "/do-not-read");
  const session = await f.start();
  await expect(session.judge("Inspect progress")).resolves.toEqual({
    status: "settled",
    aborted: false,
  });
  const launch = JSON.parse(
    f
      .records()
      .split("\n")
      .find((line) => line.includes('"launch"'))!,
  ).launch;
  expect(launch.keys).not.toContain("MC_HISYO_AMBIENT_SECRET");
  expect(launch.keys).not.toContain("OPENAI_API_KEY");
  expect(launch.args).toContain("--no-builtin-tools");
  expect(launch.args).toContain("--no-context-files");
  expect(launch.args).not.toContain("--api-key");
  expect(launch.settings).toEqual({ compaction: { enabled: false }, cacheWarming: "off" });
  expect(launch.cwd).toContain(f.options.dataDirectory);
  expect(launch.home).not.toBe(process.env.HOME);
  expect(launch.session).toBe(session.sessionPath);
  expect(statSync(session.sessionPath).mode & 0o777).toBe(0o600);
  await session.close();
  expect(existsSync(session.sessionPath)).toBe(true);
  expect(existsSync(launch.cwd)).toBe(true);
  expect(existsSync(launch.home)).toBe(false);
});

test("resumes only the same world/player and retains the scope lease until close", async () => {
  const f = await fixture();
  const first = await f.start();
  await expect(f.start()).rejects.toThrow(/already owned/);
  const other = await fixture();
  await expect(other.start({ dataDirectory: f.options.dataDirectory })).rejects.toThrow(/EEXIST/);
  await first.close();
  const resumed = await other.start({ dataDirectory: f.options.dataDirectory });
  expect(resumed.sessionPath).toBe(first.sessionPath);
  await expect(resumed.judge("Resumed")).resolves.toEqual({ status: "settled", aborted: false });
  await resumed.close();
  await f.game.call("game.detach", f.world);
  const different = (await f.game.call("game.attach", {
    worldId: "world-b",
    playerId: "player-a",
    supportedEvents: [],
    paused: false,
  })) as WorldBinding;
  await f.game.call("game.ready", different);
  const separated = await f.start({ world: different });
  expect(separated.sessionPath).not.toBe(first.sessionPath);
});

test("a different supported physical API cannot replace the configured API", async () => {
  const substituted = { provider: "local", id: "director", api: "anthropic-messages" };
  const f = await fixture({ models: [substituted], state: { model: substituted } });
  const session = await f.start();
  await expect(session.judge("Must not submit")).rejects.toMatchObject({ mayHaveStarted: false });
  expect(f.records()).not.toContain('"type":"prompt"');
  await session.close();
});

test("caller mutations during startup do not change the owned world binding", async () => {
  const f = await fixture();
  const world = { ...f.world };
  const starting = f.start({ world });
  world.worldId = "mutated-after-launch";
  const session = await starting;
  await expect(session.judge("Original binding")).resolves.toEqual({
    status: "settled",
    aborted: false,
  });
});

test("scope lease remains exclusive while an ignored shutdown is awaiting child exit", async () => {
  const f = await fixture({ mode: "ignore-stop" });
  const other = await fixture();
  const session = await f.start();
  const closing = session.close();
  await expect(other.start({ dataDirectory: f.options.dataDirectory })).rejects.toThrow(/EEXIST/);
  await closing;
  const replacement = await other.start({ dataDirectory: f.options.dataDirectory });
  await expect(replacement.judge("After confirmed exit")).resolves.toEqual({
    status: "settled",
    aborted: false,
  });
});

test("pause invalidates before abort and keeps the reservation until real settlement", async () => {
  const f = await fixture({ mode: "manual" });
  const session = await f.start();
  const first = session.judge("First");
  await expect.poll(f.records).toContain('"type":"prompt"');
  await f.game.call("game.status", { ...f.world, paused: true });
  await expect.poll(f.records).toContain('"type":"abort"');
  await expect(session.judge("Must not overlap")).rejects.toThrow(/settled/);
  f.send("settle");
  await expect(first).resolves.toEqual({ status: "settled", aborted: true });
  await f.game.call("game.status", { ...f.world, paused: false });
  const second = session.judge("Second");
  await expect.poll(() => f.records().match(/"type":"prompt"/g)?.length).toBe(2);
  f.send("settle");
  await expect(second).resolves.toEqual({ status: "settled", aborted: false });
});

test("cancellation while a bind ACK is pending sends no prompt and releases the slot", async () => {
  const f = await fixture();
  const session = await f.start();
  let release!: (value: unknown) => void;
  let observed!: () => void;
  const received = new Promise<void>((resolve) => {
    observed = resolve;
  });
  f.setBind((params) => {
    observed();
    return new Promise((resolve) => {
      release = () => resolve(params);
    });
  });
  const judgment = session.judge("Must not submit");
  await received;
  await f.game.call("game.status", { ...f.world, paused: true });
  release(undefined);
  await expect(judgment).resolves.toEqual({ status: "not_started" });
  expect(f.records()).not.toContain('"type":"prompt"');
  f.setBind((params) => params);
  await f.game.call("game.status", { ...f.world, paused: false });
  await expect(session.judge("Next")).resolves.toEqual({ status: "settled", aborted: false });
});

test("pause during agent bind ACK sends no prompt and permits a fresh binding", async () => {
  const f = await fixture({ delayBind: true });
  const session = await f.start();
  const first = session.judge("Cancelled during second bind");
  await expect.poll(f.records).toContain('"method":"director.run.bind"');
  await f.game.call("game.status", { ...f.world, paused: true });
  f.send("release-bind");
  await expect(first).resolves.toEqual({ status: "not_started" });
  expect(f.records()).not.toContain('"type":"prompt"');
  await f.game.call("game.status", { ...f.world, paused: false });
  const second = session.judge("After both bind ACKs");
  await expect.poll(() => f.records().match(/"method":"director.run.bind"/g)?.length).toBe(2);
  f.send("release-bind");
  await expect(second).resolves.toEqual({ status: "settled", aborted: false });
});

test("successful binding cancelled during metadata still runs finishRun", async () => {
  const f = await fixture({ mode: "delay-state" });
  const session = await f.start();
  const abort = new AbortController();
  const first = session.judge("Cancelled", abort.signal);
  await expect.poll(f.records).toContain('"type":"get_state"');
  abort.abort();
  f.send("release-state");
  await expect(first).resolves.toEqual({ status: "not_started" });
  expect(f.records()).not.toContain('"type":"prompt"');
  const second = session.judge("After cancellation");
  await expect.poll(() => f.records().match(/"type":"get_state"/g)?.length).toBe(2);
  f.send("release-state");
  await expect.poll(f.records).toContain('"type":"prompt"');
  f.send("settle");
  await expect(second).resolves.toEqual({ status: "settled", aborted: false });
});

test("an already-aborted request does not bind or retire the session", async () => {
  const f = await fixture();
  const session = await f.start();
  await expect(session.judge("Cancelled", AbortSignal.abort())).resolves.toEqual({
    status: "not_started",
  });
  expect(f.records()).not.toContain('"type":"prompt"');
  await expect(session.judge("Still usable")).resolves.toEqual({
    status: "settled",
    aborted: false,
  });
});

test("idle agent loss retires the child and allows a new owner only after cleanup", async () => {
  const f = await fixture();
  const session = await f.start();
  f.send("disconnect-agent");
  await expect.poll(() => session.isRetired).toBe(true);
  await session.close();
  expect(f.bridge.isAgentReady).toBe(false);
  const next = await f.start();
  await expect(next.judge("Fresh owner")).resolves.toEqual({ status: "settled", aborted: false });
});

test("detach closes the child without settlement and close is idempotent", async () => {
  const f = await fixture({ mode: "manual" });
  const session = await f.start();
  const judgment = session.judge("Pending");
  const failure = expect(judgment).rejects.toMatchObject({ mayHaveStarted: true });
  await expect.poll(f.records).toContain('"type":"prompt"');
  await f.game.call("game.detach", f.world);
  const closing = session.close();
  expect(session.close()).toBe(closing);
  await closing;
  await failure;
  expect(session.isRetired).toBe(true);
  await expect(session.judge("Refused")).rejects.toThrow(/retired/);
});

test("synchronous close reentry shares one shutdown and cleans the lease once", async () => {
  const f = await fixture({ mode: "manual" });
  const session = await f.start();
  const failure = expect(session.judge("Pending")).rejects.toMatchObject({ mayHaveStarted: true });
  await expect.poll(f.records).toContain('"type":"prompt"');
  let reentered: Promise<void> | undefined;
  f.bridge.once("runInvalidated", () => {
    reentered = session.close();
    void reentered.catch(() => {});
  });
  const closing = session.close();
  await Promise.allSettled([closing, reentered]);
  await failure;
  expect(reentered).toBe(closing);
  await closing;
  f.configure({ mode: "auto" });
  await expect((await f.start()).judge("After one cleanup")).resolves.toEqual({
    status: "settled",
    aborted: false,
  });
});

test("unknown-started Pi failure retires and terminates before reservation reuse", async () => {
  const f = await fixture({ mode: "exit" });
  const session = await f.start();
  await expect(session.judge("Exits after starting")).rejects.toMatchObject({
    mayHaveStarted: true,
  });
  await session.close();
  f.configure({ mode: "auto" });
  const next = await f.start();
  await expect(next.judge("After confirmed exit")).resolves.toEqual({
    status: "settled",
    aborted: false,
  });
});

for (const config of [{ bridge: "missing" }, { version: "1.2.1" }]) {
  test(`startup failure cleans its exclusive lease: ${JSON.stringify(config)}`, async () => {
    const f = await fixture(config);
    await expect(f.start({ readyTimeoutMs: 150 })).rejects.toThrow();
    expect(f.bridge.isAgentReady).toBe(false);
    f.configure({});
    const session = await f.start();
    await expect(session.judge("Recovered startup")).resolves.toEqual({
      status: "settled",
      aborted: false,
    });
  });
}

for (const unsafe of ["permissions", "symlink", "hardlink", "foreign-cwd"] as const) {
  test(`refuses unsafe retained session ${unsafe} without a second child`, async () => {
    const f = await fixture();
    const session = await f.start();
    await session.close();
    if (unsafe === "permissions") chmodSync(session.sessionPath, 0o644);
    if (unsafe === "hardlink") linkSync(session.sessionPath, join(f.directory, "linked.jsonl"));
    if (unsafe === "foreign-cwd")
      writeFileSync(
        session.sessionPath,
        JSON.stringify({ type: "session", cwd: "/must-not-read", id: "foreign" }) + "\n",
      );
    if (unsafe === "symlink") {
      expect(session.sessionPath).toContain(f.directory);
      unlinkSync(session.sessionPath);
      const target = join(f.directory, "foreign.jsonl");
      writeFileSync(target, "untouched");
      symlinkSync(target, session.sessionPath);
    }
    await expect(f.start()).rejects.toThrow();
    expect(f.records().match(/"launch"/g)).toHaveLength(1);
    if (unsafe === "permissions") expect(statSync(session.sessionPath).mode & 0o777).toBe(0o644);
    if (unsafe === "symlink")
      expect(readFileSync(join(f.directory, "foreign.jsonl"), "utf8")).toBe("untouched");
  });
}

test("refuses a symlink data directory instead of repairing or following it", async () => {
  const f = await fixture();
  const target = join(f.directory, "target");
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, f.options.dataDirectory);
  await expect(f.start()).rejects.toThrow(/real, owned 0700/);
  expect(f.records()).toBe("");
});
