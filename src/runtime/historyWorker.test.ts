import { EventEmitter } from "node:events";
import { expect, test, vi } from "vite-plus/test";
import { HistoryWorker, type HistoryWorkerOptions } from "./historyWorker.js";
import type { AttachedWorld } from "../bridge/directorBridge.js";
import type { HistorySource } from "../events/compactHistory.js";

const binding = { worldId: "world", playerId: "player", worldSessionId: "session" };
const source: HistorySource = {
  after: 0,
  through: 10,
  sourceSessionId: "older-session",
  sourceCount: 10,
  firstObservedAt: 1,
  lastObservedAt: 100,
  input: "observed block_broken ×3",
};
function fixture(paused = false) {
  let now = 0;
  const pending: {
    signal: AbortSignal;
    resolve: (text: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  const bridge = Object.assign(new EventEmitter(), {
    readyWorld: { binding, paused, supportedEvents: [], language: "ja_jp" } as AttachedWorld,
    isAgentReady: true,
    history: {
      next: vi.fn<() => { source: HistorySource; backlog: boolean } | undefined>(() => ({
        source,
        backlog: false,
      })),
      save: vi.fn(),
    },
    summarizeHistory: vi.fn(
      (_binding: typeof binding, _input: string, signal: AbortSignal) =>
        new Promise<string>((resolve, reject) => pending.push({ signal, resolve, reject })),
    ),
  });
  const worker = new HistoryWorker({
    bridge: bridge as unknown as HistoryWorkerOptions["bridge"],
    now: () => now,
    wallNow: () => 200,
  });
  const fault = vi.fn();
  worker.on("fault", fault);
  return {
    worker,
    bridge,
    pending,
    fault,
    at: (value: number) => {
      now = value;
    },
    pause: (paused: boolean) => {
      // DirectorBridge emits a structuredClone through currentWorld, not its mutable internal state.
      bridge.readyWorld = { ...bridge.readyWorld, paused };
      bridge.emit("status", bridge.readyWorld);
    },
    settle: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("one independent elapsed minute reserves one bounded prefix and stores its result", async () => {
  const f = fixture();
  f.at(59_999);
  expect(f.worker.poll(binding)).toBe(false);
  f.bridge.emit("judgmentRequested", {}); // Main/hook activity must not reset the memory clock.
  f.at(60_000);
  expect(f.worker.poll(binding)).toBe(true);
  expect(f.bridge.history.next).toHaveBeenCalledWith({ worldId: "world", playerId: "player" });
  expect(f.bridge.summarizeHistory).toHaveBeenCalledWith(
    binding,
    source.input,
    expect.any(AbortSignal),
  );
  f.pending[0]!.resolve("木を集めた。");
  await f.settle();
  expect(f.bridge.history.save).toHaveBeenCalledExactlyOnceWith(
    { worldId: "world", playerId: "player" },
    source,
    "木を集めた。",
    200,
  );
  expect(f.fault).not.toHaveBeenCalled();
  await f.worker.close();
});

test.each([false, true])(
  "paused history keeps its cadence across startup and status changes; initiallyPaused=%s",
  async (initiallyPaused) => {
    const f = fixture(initiallyPaused);
    f.at(30_000);
    f.pause(true);
    f.at(59_999);
    expect(f.worker.poll(binding)).toBe(false);
    f.at(60_000);
    expect(f.worker.poll(binding)).toBe(true);
    f.pending[0]!.resolve("first paused summary");
    await f.settle();
    f.at(120_000);
    expect(f.worker.poll(binding)).toBe(true);
    f.pending[1]!.resolve("second paused summary");
    await f.settle();
    f.at(150_000);
    f.pause(false);
    f.at(160_000);
    f.pause(true);
    f.at(179_999);
    expect(f.worker.poll(binding)).toBe(false);
    f.at(180_000);
    expect(f.worker.poll(binding)).toBe(true);
    f.pending[2]!.resolve("third paused summary");
    await f.settle();
    expect(f.bridge.history.save.mock.calls.map((call) => call[2])).toEqual([
      "first paused summary",
      "second paused summary",
      "third paused summary",
    ]);
    expect(f.fault).not.toHaveBeenCalled();
    await f.worker.close();
  },
);

test.each([false, true])("an empty delta never calls the model; paused=%s", async (paused) => {
  const f = fixture(paused);
  f.bridge.history.next.mockReturnValue(undefined);
  f.at(60_000);
  expect(f.worker.poll(binding)).toBe(false);
  expect(f.bridge.history.next).toHaveBeenCalledOnce();
  expect(f.bridge.summarizeHistory).not.toHaveBeenCalled();
  await f.worker.close();
});

test("delayed ticks never burst or overlap and pause preserves in-flight completion", async () => {
  const f = fixture();
  f.at(300_000);
  expect(f.worker.poll(binding)).toBe(true);
  f.at(600_000);
  expect(f.worker.poll(binding)).toBe(false);
  expect(f.pending).toHaveLength(1);
  f.pause(true);
  expect(f.pending[0]!.signal.aborted).toBe(false);
  f.pause(false);
  f.at(660_000);
  expect(f.worker.poll(binding)).toBe(false);
  f.pending[0]!.resolve("completed");
  await f.settle();
  expect(f.bridge.history.save).toHaveBeenCalledTimes(1);
  f.at(720_000);
  expect(f.worker.poll(binding)).toBe(true);
  f.pending[1]!.resolve("fresh");
  await f.settle();
  expect(f.bridge.history.save).toHaveBeenCalledTimes(2);
  await f.worker.close();
});

test("detach and replacement invalidate the old prefix without flushing it", async () => {
  const f = fixture();
  f.at(60_000);
  f.worker.poll(binding);
  f.bridge.emit("detach", binding);
  const next = { ...binding, worldSessionId: "reconnected" };
  f.bridge.readyWorld = { ...f.bridge.readyWorld, binding: next };
  f.bridge.emit("attach", f.bridge.readyWorld);
  f.pending[0]!.resolve("old");
  await f.settle();
  expect(f.bridge.history.save).not.toHaveBeenCalled();
  f.at(120_000);
  expect(f.worker.poll(next)).toBe(true);
  expect(f.bridge.history.next).toHaveBeenCalledTimes(2); // Persistence owns the unchanged cursor.
  f.pending[1]!.resolve("resumed");
  await f.settle();
  expect(f.bridge.history.save).toHaveBeenCalledTimes(1);
  await f.worker.close();
});

test("failure reports once and never advances or silently retries the cursor", async () => {
  const f = fixture();
  f.at(60_000);
  f.worker.poll(binding);
  const failure = new Error("summary failed");
  f.pending[0]!.reject(failure);
  await f.settle();
  expect(f.fault).toHaveBeenCalledExactlyOnceWith(failure);
  expect(f.bridge.history.save).not.toHaveBeenCalled();
  f.at(120_000);
  expect(f.worker.poll(binding)).toBe(false);
  await f.worker.close();
});

test("close invalidates synchronously, awaits pending work and is idempotent", async () => {
  const f = fixture();
  f.at(60_000);
  f.worker.poll(binding);
  let closed = false;
  const closing = f.worker.close();
  void closing.then(() => {
    closed = true;
  });
  expect(f.worker.close()).toBe(closing);
  expect(f.pending[0]!.signal.aborted).toBe(true);
  await f.settle();
  expect(closed).toBe(false);
  f.pending[0]!.resolve("late");
  await closing;
  expect(f.bridge.history.save).not.toHaveBeenCalled();
  expect(f.bridge.listenerCount("attach")).toBe(0);
  expect(f.bridge.listenerCount("status")).toBe(0);
  expect(f.bridge.listenerCount("detach")).toBe(0);
});
