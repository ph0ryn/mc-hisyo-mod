import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, onTestFinished, test, vi } from "vite-plus/test";
import type { DirectorBridge } from "../bridge/directorBridge.js";
import { startPiRpcClient } from "../pi/piRpcClient.js";
import { refreshPiOAuth } from "./piOAuth.js";
import { startPiSession } from "./piSession.js";
import { JudgmentScheduler } from "./judgmentScheduler.js";
import { HistoryWorker } from "./historyWorker.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute }),
}));
vi.mock("../pi/piRpcClient.js", async (original) => ({
  ...(await original<typeof import("../pi/piRpcClient.js")>()),
  startPiRpcClient: vi.fn(),
}));
const directory = mkdtempSync(join(tmpdir(), "director-oauth-"));
const authPath = join(directory, "auth.json");
afterEach(() => {
  execute.mockReset();
  rmSync(authPath, { force: true });
});
// Only the owned mkdtemp directory is removed after this file's tests finish.
afterAll(() => rmSync(directory, { recursive: true }));

test("refreshes private OAuth credentials for each judgment", async () => {
  const world = { worldId: "w", playerId: "p", worldSessionId: "s" };
  const hash = createHash("sha256")
    .update(JSON.stringify([world.worldId, world.playerId]))
    .digest("hex");
  const scope = join(directory, "state", "pi", hash);
  mkdirSync(scope, { recursive: true, mode: 0o700 });
  const legacy = join(scope, "session.jsonl");
  writeFileSync(legacy, "old hidden-world transcript", { mode: 0o600 });
  const bridge = Object.assign(new EventEmitter(), {
    isAgentReady: false,
    currentWorld: { binding: world, language: "ja_jp" },
    readyWorld: { binding: world, status: { worldState: { ready: true } } },
    beginRun: vi.fn(async () => ({ ...world, runId: "run" })),
    finishRun: vi.fn(),
    invalidateRun: vi.fn(),
  });
  let privateAuth = "";
  const seen: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    run: vi.fn(async () => {
      seen.push(JSON.parse(readFileSync(privateAuth, "utf8")).openai.key);
      return { status: "settled" as const, aborted: false };
    }),
  });
  vi.mocked(startPiRpcClient).mockImplementationOnce(async (launch) => {
    privateAuth = join(launch.env.PI_CODING_AGENT_DIR!, "auth.json");
    expect(JSON.parse(readFileSync(privateAuth, "utf8")).openai.key).toBe("startup-token");
    expect(launch.env.MC_HISYO_MODEL_API_KEY).toBeUndefined();
    const sessionPath = launch.args![launch.args!.indexOf("--session") + 1]!;
    expect(sessionPath).toBe(join(realpathSync(scope), "session-observable-v1.jsonl"));
    expect(readFileSync(legacy, "utf8")).toBe("old hidden-world transcript");
    expect(
      JSON.parse(readFileSync(join(launch.env.PI_CODING_AGENT_DIR!, "models.json"), "utf8")),
    ).toEqual({ providers: {} });
    bridge.isAgentReady = true;
    bridge.emit("agentReady");
    return client as unknown as Awaited<ReturnType<typeof startPiRpcClient>>;
  });
  execute.mockResolvedValueOnce({ stdout: "startup-token" });
  const session = await startPiSession({
    dataDirectory: join(directory, "state"),
    world,
    bridge: bridge as unknown as DirectorBridge,
    connection: { protocolVersion: 1, host: "127.0.0.1", port: 1, token: "bridge-token", pid: 1 },
    executable: "/trusted/pi",
    bundledExtension: "/trusted/extension.mjs",
    model: { provider: "openai", id: "gpt-6-luna", apiKey: "expired-token" },
    oauthAgentDirectory: "/original/agent",
  });
  try {
    for (const token of ["judgment-A", "judgment-B"]) {
      execute.mockResolvedValueOnce({ stdout: token });
      await expect(session.judge("prompt")).resolves.toEqual({
        status: "settled",
        aborted: false,
      });
    }
    expect(seen).toEqual(["judgment-A", "judgment-B"]);
    execute.mockRejectedValueOnce(new Error("refresh-secret"));
    await expect(session.judge("blocked")).rejects.toThrow(
      "Unable to refresh ChatGPT authentication through Pi.",
    );
    expect(bridge.beginRun).toHaveBeenCalledTimes(2);
    expect(client.run).toHaveBeenCalledTimes(2);
    let persist!: (value: { stdout: string }) => void;
    execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          persist = resolve;
        }),
    );
    const judgment = session.judge("cancelled during refresh");
    const closing = session.close();
    await Promise.resolve();
    expect(() => readFileSync(privateAuth)).not.toThrow();
    persist({ stdout: "unused-fresh-token" });
    await expect(judgment).resolves.toEqual({ status: "not_started" });
    await closing;
    expect(client.run).toHaveBeenCalledTimes(2);
  } finally {
    await session.close();
  }
  expect(client.close).toHaveBeenCalledOnce();
  expect(() => readFileSync(privateAuth)).toThrow();
});

async function pausedHistoryFixture() {
  let now = 0;
  let privateAuth = "";
  let tokenNumber = 0;
  const expiry = new Map<string, number>();
  const world = { worldId: "paused-world", playerId: "player", worldSessionId: "session" };
  const attached = { binding: world, language: "ja_jp", paused: true, supportedEvents: [] };
  const save = vi.fn();
  const bridge = Object.assign(new EventEmitter(), {
    currentWorld: attached as DirectorBridge["currentWorld"],
    readyWorld: attached as DirectorBridge["readyWorld"],
    isAgentReady: false,
    handlePlayerMessages: vi.fn(() => () => {}),
    beginRun: vi.fn(),
    finishRun: vi.fn(),
    invalidateRun: vi.fn(),
    history: {
      next: vi.fn(() => ({
        source: {
          after: save.mock.calls.length,
          through: save.mock.calls.length + 1,
          sourceSessionId: "older-session",
          sourceCount: 1,
          firstObservedAt: 1,
          lastObservedAt: 1,
          input: "observed block_broken",
        },
        backlog: true,
      })),
      save,
    },
    summarizeHistory: vi.fn(async () => {
      const credentials = JSON.parse(readFileSync(privateAuth, "utf8"));
      expect(credentials.openai.type).toBe("api_key");
      if ((expiry.get(credentials.openai.key) ?? 0) <= now)
        throw new Error("Expired copied access token");
      return "paused memory";
    }),
  });
  execute.mockImplementation(async () => {
    const token = `access-${++tokenNumber}`;
    expiry.set(token, now + 600_000);
    return { stdout: token };
  });
  const client = Object.assign(new EventEmitter(), {
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    run: vi.fn(),
  });
  vi.mocked(startPiRpcClient).mockImplementationOnce(async (launch) => {
    privateAuth = join(launch.env.PI_CODING_AGENT_DIR!, "auth.json");
    bridge.isAgentReady = true;
    bridge.emit("agentReady");
    return client as unknown as Awaited<ReturnType<typeof startPiRpcClient>>;
  });
  const scheduler = new JudgmentScheduler({
    dataDirectory: mkdtempSync(join(directory, "paused-state-")),
    bridge: bridge as unknown as DirectorBridge,
    connection: { protocolVersion: 1, host: "127.0.0.1", port: 1, token: "unused", pid: 1 },
    executable: "/trusted/pi",
    bundledExtension: "/trusted/extension.mjs",
    model: { provider: "openai", id: "gpt-6-luna", apiKey: "unused" },
    oauthAgentDirectory: "/original/agent",
    monotonicNow: () => now,
  });
  const worker = new HistoryWorker({
    bridge: bridge as unknown as DirectorBridge,
    summarizeHistory: (...args) => scheduler.summarizeHistory(...args),
    now: () => now,
  });
  const fault = vi.fn();
  scheduler.on("fault", fault);
  worker.on("fault", fault);
  const close = async () => {
    await Promise.all([worker.close(), scheduler.close()]);
  };
  const releases: (() => void)[] = [];
  onTestFinished(async () => {
    for (const release of releases) release();
    await close();
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    bridge,
    world,
    worker,
    scheduler,
    client,
    detach: () => {
      bridge.currentWorld = undefined;
      bridge.readyWorld = undefined;
      bridge.emit("detach", world);
    },
    save,
    fault,
    close,
    holdRefresh: () => {
      let persist!: (value: { stdout: string }) => void;
      const pending = new Promise<{ stdout: string }>((resolve) => {
        persist = resolve;
      });
      execute.mockReturnValueOnce(pending);
      releases.push(() => persist({ stdout: "unused-token" }));
      return persist;
    },
    at: (time: number) => {
      now = time;
    },
    readAuth: () => JSON.parse(readFileSync(privateAuth, "utf8")),
    poll: () => worker.poll(world),
    drain: () => new Promise<void>((resolve) => setImmediate(resolve)),
  };
}

test("independent history refreshes expired OAuth during repeated long pauses without main runs", async () => {
  const f = await pausedHistoryFixture();
  expect(f.readAuth().openai.key).toBe("access-1");
  for (const hour of [1, 2]) {
    f.at(hour * 3_600_000);
    expect(f.poll()).toBe(true);
    await f.drain();
    expect(f.save).toHaveBeenCalledTimes(hour);
    expect(f.readAuth().openai.key).toBe(`access-${hour + 1}`);
  }
  expect(execute).toHaveBeenCalledTimes(3);
  expect(f.bridge.summarizeHistory).toHaveBeenCalledTimes(2);
  expect(f.bridge.beginRun).not.toHaveBeenCalled();
  expect(f.client.run).not.toHaveBeenCalled();
  expect(f.fault).not.toHaveBeenCalled();
});

test("paused history auth failure faults once without dispatch, cursor advancement or fallback", async () => {
  const f = await pausedHistoryFixture();
  execute.mockRejectedValueOnce(new Error("private-refresh-secret"));
  f.at(3_600_000);
  expect(f.poll()).toBe(true);
  await f.drain();
  expect(f.fault).toHaveBeenCalledExactlyOnceWith(
    new Error("Unable to refresh ChatGPT authentication through Pi."),
  );
  expect(f.bridge.summarizeHistory).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
  expect(f.bridge.beginRun).not.toHaveBeenCalled();
  f.at(7_200_000);
  expect(f.poll()).toBe(false);
  expect(execute).toHaveBeenCalledTimes(2);
});

test.each(["shutdown", "detach"])(
  "%s during history auth waits for native grant persistence and never dispatches a cancelled batch",
  async (reason) => {
    const f = await pausedHistoryFixture();
    const persist = f.holdRefresh();
    f.at(3_600_000);
    expect(f.poll()).toBe(true);
    await f.drain();
    expect(execute).toHaveBeenCalledTimes(2);
    if (reason === "detach") f.detach();
    let closed = false;
    const closing = f.close().then(() => {
      closed = true;
    });
    await f.drain();
    expect(closed).toBe(false);
    expect(f.readAuth().openai.key).toBe("access-1");
    persist({ stdout: "unused-token" });
    await closing;
    expect(() => f.readAuth()).toThrow();
    expect(f.bridge.summarizeHistory).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.fault).not.toHaveBeenCalled();
  },
);

test("history cancellation and overlap cannot bypass refresh or retire the paused owner", async () => {
  const f = await pausedHistoryFixture();
  const stop = new AbortController();
  const persist = f.holdRefresh();
  const pending = f.scheduler.summarizeHistory(f.world, "observations", stop.signal);
  const rejected = expect(pending).rejects.toThrow(
    "Unable to refresh ChatGPT authentication through Pi.",
  );
  await f.drain();
  await expect(
    f.scheduler.summarizeHistory(f.world, "overlap", new AbortController().signal),
  ).rejects.toThrow("History session is not available");
  expect(execute).toHaveBeenCalledTimes(2);
  stop.abort();
  persist({ stdout: "unused-token" });
  await rejected;
  expect(f.readAuth().openai.key).toBe("access-1");
  expect(f.bridge.summarizeHistory).not.toHaveBeenCalled();
  f.at(3_600_000);
  expect(f.poll()).toBe(true);
  await f.drain();
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.bridge.beginRun).not.toHaveBeenCalled();
  expect(f.client.close).not.toHaveBeenCalled();
  expect(f.fault).not.toHaveBeenCalled();
});

test("stale world history and pre-aborted requests never touch the original credential store", async () => {
  const f = await pausedHistoryFixture();
  await expect(
    f.scheduler.summarizeHistory(
      { ...f.world, worldSessionId: "stale" },
      "observations",
      new AbortController().signal,
    ),
  ).rejects.toThrow("History session is not available");
  await expect(
    f.scheduler.summarizeHistory(f.world, "observations", AbortSignal.abort()),
  ).rejects.toThrow();
  expect(execute).toHaveBeenCalledOnce();
  expect(f.bridge.summarizeHistory).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
});

const refresh = (signal = new AbortController().signal) =>
  refreshPiOAuth("/trusted/pi", "/original/agent", authPath, 300_000, signal);

test("rotates private access-only credentials and uses Pi's native expiry guarantee", async () => {
  for (const token of ["bearer-A", "bearer-B"]) {
    execute.mockResolvedValueOnce({ stdout: `${token}\n` });
    await refresh();
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      openai: { type: "api_key", key: token },
    });
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  }
  const [command, args, options] = execute.mock.calls[0]!;
  expect(command).toBe("/trusted/pi");
  expect(args).toEqual([
    "auth",
    "print-bearer-token",
    "--provider",
    "openai",
    "--min-expiry",
    "600000ms",
  ]);
  expect(options.env.PI_CODING_AGENT_DIR).toBe("/original/agent");
  expect(options.env.OPENAI_API_KEY).toBeUndefined();
  expect(options.signal).toBeUndefined();
  expect(options.timeout).toBeUndefined();
});

test.each(["", "!command", "${SECRET}", "bearer\nextra"])(
  "rejects unsafe credential output without replacing a working token: %s",
  async (stdout) => {
    execute.mockResolvedValueOnce({ stdout: "working-token" });
    await refresh();
    execute.mockResolvedValueOnce({ stdout });
    await expect(refresh()).rejects.toThrow("Unable to refresh ChatGPT authentication through Pi.");
    expect(JSON.parse(readFileSync(authPath, "utf8")).openai.key).toBe("working-token");
  },
);

test("helper failures redact stdout/stderr and have no nested cause", async () => {
  execute.mockRejectedValueOnce(
    Object.assign(new Error("SECRET_SENTINEL"), {
      stdout: "access-secret",
      stderr: "refresh-secret",
    }),
  );
  const error = await refresh().catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("Unable to refresh ChatGPT authentication through Pi.");
  expect((error as Error).cause).toBeUndefined();
  expect(() => readFileSync(authPath)).toThrow();
});

test("cancellation waits for native grant persistence, then suppresses the private handoff", async () => {
  let complete!: (value: { stdout: string }) => void;
  execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const stop = new AbortController();
  let settled = false;
  const pending = refresh(stop.signal).catch(() => {
    settled = true;
  });
  stop.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  complete({ stdout: "fresh-token" });
  await pending;
  expect(settled).toBe(true);
  expect(() => readFileSync(authPath)).toThrow();
});
