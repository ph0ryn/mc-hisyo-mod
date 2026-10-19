import { EventEmitter } from "node:events";
import { beforeEach, expect, onTestFinished, test, vi } from "vite-plus/test";
import type { AttachedSession, BridgeServer } from "../bridge/bridgeServer.js";
import type { StoredEvent } from "../storage/eventLog.js";
import type { Hook } from "../storage/hookStore.js";
import type { PiRunResult } from "../pi/piRpcClient.js";
import type { SessionBinding } from "../protocol/bridge.js";
import { encodePiJsonLine } from "../pi/piFraming.js";
import { RpcError } from "../transport/rpcPeer.js";
import type { RunRequest } from "./runQueue.js";
import { RunQueueFullError } from "./runQueue.js";
import { RunScheduler, type RunSchedulerOptions } from "./runScheduler.js";
import { startPiProcess } from "./piProcess.js";

vi.mock("./piProcess.js", () => ({ startPiProcess: vi.fn() }));

const world: SessionBinding = {
  worldId: "world-a",
  playerId: "player-a",
  sessionId: "session-a",
};
type PiProcess = Awaited<ReturnType<typeof startPiProcess>>;
type Intake = Parameters<BridgeServer["handlePlayerMessages"]>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Only dependency ports are stubbed: no sockets, SQLite, files or child processes.
class BridgeStub extends EventEmitter {
  readySession: AttachedSession | undefined;
  intake: Intake | undefined;
  readonly handlePlayerMessages = vi.fn<BridgeServer["handlePlayerMessages"]>((accept) => {
    this.intake = accept;
    return () => {
      this.intake = undefined;
    };
  });

  attach(binding = world, paused = false) {
    this.readySession = { binding, language: "ja_jp", supportedEvents: ["block_broken"], paused };
    this.emit("attach", this.readySession);
  }

  detach() {
    const binding = this.readySession!.binding;
    this.readySession = undefined;
    this.emit("detach", binding);
  }

  pause(paused: boolean) {
    this.readySession = { ...this.readySession!, paused };
    this.emit("status", this.readySession);
  }

  message(text: string, binding = this.readySession!.binding) {
    if (!this.intake) throw new RpcError(-32003, "No player-message intake");
    return this.intake(binding, text);
  }
}

class ProcessStub extends EventEmitter<{ fault: [error: Error] }> {
  readonly pending: ReturnType<typeof deferred<PiRunResult>>[] = [];
  termination: Promise<void> = Promise.resolve();
  onClose: (() => void) | undefined;
  #shutdown: Promise<void> | undefined;
  readonly run = vi.fn<PiProcess["run"]>(() => {
    const flight = deferred<PiRunResult>();
    this.pending.push(flight);
    return flight.promise;
  });
  readonly close = vi.fn<PiProcess["close"]>(() => {
    if (!this.#shutdown) {
      this.#shutdown = this.termination.then(() => {
        for (const flight of this.pending) flight.resolve({ status: "settled", aborted: true });
      });
      this.onClose?.();
    }
    return this.#shutdown;
  });

  batches() {
    return this.run.mock.calls.map(([message]) => JSON.parse(message) as RunRequest);
  }

  settle(result: PiRunResult = { status: "settled", aborted: false }) {
    this.pending.at(-1)!.resolve(result);
  }
}

beforeEach(() => vi.mocked(startPiProcess).mockReset());

function fixture(config: { ready?: boolean; paused?: boolean; maxPendingBytes?: number } = {}) {
  let now = 0;
  const bridge = new BridgeStub();
  if (config.ready !== false) bridge.attach(world, config.paused);
  const processes: ProcessStub[] = [];
  function createProcess() {
    const process = new ProcessStub();
    processes.push(process);
    return process;
  }
  vi.mocked(startPiProcess).mockImplementation(async () => createProcess() as unknown as PiProcess);
  const options: RunSchedulerOptions = {
    // Nominal concrete dependencies are never constructed by these unit tests.
    bridge: bridge as unknown as BridgeServer,
    dataDirectory: "/unused",
    monotonicNow: () => now,
    executable: "never-launched",
    bundledExtension: "/unused/piExtension.mjs",
    prefixArgs: ["original"],
    connection: { protocolVersion: 2, host: "127.0.0.1", port: 1, token: "unused", pid: 1 },
    model: {
      provider: "test-provider",
      id: "test-model",
      apiKey: "unused",
    },
    ...(config.maxPendingBytes === undefined ? {} : { maxPendingBytes: config.maxPendingBytes }),
  };
  const scheduler = new RunScheduler(options);
  const faults: Error[] = [];
  scheduler.on("fault", (error) => faults.push(error));
  const releases: (() => void)[] = [];
  const f = {
    bridge,
    processes,
    createProcess,
    scheduler,
    options,
    faults,
    expectedCloseError: undefined as Error | undefined,
    at(value: number) {
      now = value;
    },
    get process() {
      return processes[0]!;
    },
    hold<T>(fallback: T) {
      const gate = deferred<T>();
      releases.push(() => gate.resolve(fallback));
      return gate;
    },
  };
  onTestFinished(async () => {
    for (const release of releases) release();
    if (f.expectedCloseError) await expect(scheduler.close()).rejects.toBe(f.expectedCloseError);
    else await scheduler.close();
  });
  return f;
}

// Drain promise continuations without elapsed-time assertions or arbitrary sleeps.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function stored(id: number, seq = id): StoredEvent {
  return {
    id,
    observation: {
      ...world,
      seq,
      tick: seq,
      observedAt: 1000 + seq,
      event: "block_broken",
      dimension: "minecraft:overworld",
      position: [0, 64, 0],
      data: { blockId: "minecraft:stone", position: [1, 64, 0] },
    },
  };
}

function hook(id: string, instruction = id): Hook {
  return { id, event: "block_broken", filter: {}, instruction };
}

test("starts once for an already-ready world and snapshots the owner configuration", async () => {
  const f = fixture();
  f.options.model.id = "changed";
  f.options.connection.port = 99;
  f.options.prefixArgs = ["changed"];
  await tick();
  f.bridge.emit("attach", f.bridge.readySession);
  await tick();
  expect(startPiProcess).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      session: world,
      model: expect.objectContaining({ id: "test-model" }),
      connection: expect.objectContaining({ port: 1 }),
      prefixArgs: ["original"],
    }),
  );
  expect(f.process.batches()).toEqual([
    {
      binding: world,
      initial: true,
      poll: false,
      playerMessages: [],
      hooks: [],
      observations: [],
    },
  ]);
});

test("does not start or accept input before ready", async () => {
  const f = fixture({ ready: false });
  await tick();
  expect(startPiProcess).not.toHaveBeenCalled();
  expect(() => f.bridge.message("early", world)).toThrowError(
    expect.objectContaining({ code: -32003 }),
  );
  f.bridge.attach();
  await tick();
  expect(f.process.run).toHaveBeenCalledTimes(1);
  expect(() => f.bridge.message("stale", { ...world, sessionId: "old" })).toThrowError(
    expect.objectContaining({ code: -32003 }),
  );
});

test("preserves ordered duplicate chats in one subsequent run", async () => {
  const f = fixture();
  await tick();
  for (const text of ["first", "same", "same"]) expect(f.bridge.message(text)).toBeUndefined();
  expect(f.process.run).toHaveBeenCalledTimes(1);
  f.process.settle();
  await tick();
  expect(f.process.batches()[1]).toMatchObject({
    initial: false,
    playerMessages: ["first", "same", "same"],
  });
  f.process.settle();
  await tick();
  expect(f.process.run).toHaveBeenCalledTimes(2);
});

test.each([false, true])(
  "notifies advancement unlocks without hooks (paused=%s)",
  async (paused) => {
    const f = fixture();
    await tick();
    f.process.settle();
    await tick();
    const completed: StoredEvent = {
      ...stored(1),
      observation: {
        ...stored(1).observation,
        event: "advancement_completed",
        data: {
          advancementId: "minecraft:story/mine_stone",
          criterion: "get_cobblestone",
          afterDone: true,
          hasDisplay: true,
        },
      },
    };
    for (const observation of [
      { ...completed.observation, event: "advancement_criterion_granted" },
      { ...completed.observation, data: { ...completed.observation.data, hasDisplay: false } },
      {
        ...completed.observation,
        data: {
          advancementId: "minecraft:story/mine_stone",
          criterion: "get_cobblestone",
          afterDone: true,
        },
      },
    ])
      f.bridge.emit("observation", { ...completed, observation }, []);
    await tick();
    expect(f.process.run).toHaveBeenCalledTimes(1);

    f.bridge.pause(paused);
    f.bridge.emit("observation", completed, []);
    await tick();
    if (paused) {
      expect(f.process.run).toHaveBeenCalledTimes(1);
      f.bridge.pause(false);
      await tick();
    }
    expect(f.process.batches()[1]).toMatchObject({ hooks: [], observations: [completed] });

    const next = { ...completed, id: 2, observation: { ...completed.observation, seq: 2 } };
    const matched = {
      ...hook("advancement", "react to the unlock"),
      event: "advancement_completed",
    };
    f.bridge.emit("observation", next, [matched]);
    await tick();
    expect(f.process.run).toHaveBeenCalledTimes(2);
    f.process.settle();
    await tick();
    expect(f.process.batches()[2]).toMatchObject({
      hooks: [{ id: matched.id, instruction: matched.instruction, eventIds: [next.id] }],
      observations: [next],
    });
    f.process.settle();
    await tick();
    expect(f.process.run).toHaveBeenCalledTimes(3);
    expect(f.faults).toEqual([]);
  },
);

test("starts an initially paused owner but waits for play before sending start and chat", async () => {
  const f = fixture({ paused: true });
  await tick();
  expect(startPiProcess).toHaveBeenCalledTimes(1);
  expect(f.process.run).not.toHaveBeenCalled();
  f.bridge.message("while paused");
  f.bridge.pause(false);
  await tick();
  expect(f.process.batches()).toEqual([
    expect.objectContaining({ initial: true, playerMessages: ["while paused"] }),
  ]);
});

test("resume before settlement cannot overlap the occupied run", async () => {
  const f = fixture();
  await tick();
  f.bridge.pause(true);
  f.bridge.message("next");
  f.bridge.pause(false);
  expect(f.process.run).toHaveBeenCalledTimes(1);
  f.process.settle({ status: "settled", aborted: true });
  await tick();
  expect(f.process.batches()[1]).toMatchObject({ initial: false, playerMessages: ["next"] });
});

test("not_started retains its batch separately from newly admitted input", async () => {
  const f = fixture();
  await tick();
  f.bridge.pause(true);
  f.bridge.message("next batch");
  f.process.settle({ status: "not_started" });
  await tick();
  expect(f.process.run).toHaveBeenCalledTimes(1);
  f.bridge.pause(false);
  await tick();
  expect(f.process.batches()[1]).toEqual(f.process.batches()[0]);
  f.process.settle();
  await tick();
  expect(f.process.batches()[2]).toMatchObject({
    initial: false,
    playerMessages: ["next batch"],
  });
});

test("takes only matching observations and firing-time hooks into the next batch", async () => {
  const f = fixture();
  await tick();
  const first = hook("removed", "original instruction");
  const second = hook("retained");
  const one = stored(1);
  const three = stored(3, 5);
  f.bridge.emit("observation", one, [first, second]);
  first.instruction = "changed after admission";
  f.bridge.emit("observation", stored(2), []);
  f.bridge.emit("observation", three, [second]);
  f.process.settle();
  await tick();
  expect(f.process.batches()[1]).toMatchObject({
    hooks: [
      { id: "removed", instruction: "original instruction", eventIds: [1] },
      { id: "retained", instruction: "retained", eventIds: [1, 3] },
    ],
    observations: [one, three],
  });
});

test("ordinary observations do not wake Pi or become chat prompt contents", async () => {
  const f = fixture();
  await tick();
  f.process.settle();
  await tick();
  f.bridge.emit("observation", stored(1), []);
  await tick();
  expect(f.process.run).toHaveBeenCalledTimes(1);
  f.bridge.message("chat");
  expect(f.process.batches()[1]).toMatchObject({ playerMessages: ["chat"], observations: [] });
});

test("chat overflow requests owner retirement before fault and refuses future worlds", async () => {
  const f = fixture({ maxPendingBytes: 1024 });
  await tick();
  const closeCallsAtFault: number[] = [];
  f.scheduler.on("fault", () => closeCallsAtFault.push(f.process.close.mock.calls.length));
  f.bridge.message("x".repeat(700));
  expect(() => f.bridge.message("x".repeat(700))).toThrowError(
    expect.objectContaining({ code: -32004 }),
  );
  expect(f.faults).toEqual([expect.any(RunQueueFullError)]);
  expect(closeCallsAtFault[0]).toBeGreaterThan(0);
  f.bridge.detach();
  f.bridge.attach({ ...world, sessionId: "later" });
  await tick();
  expect(startPiProcess).toHaveBeenCalledTimes(1);
  expect(() => f.bridge.message("later")).toThrowError(expect.objectContaining({ code: -32004 }));
});

test("hook overflow reports a fault without throwing out of the stored-observation callback", async () => {
  const f = fixture({ maxPendingBytes: 1024 });
  await tick();
  expect(() =>
    f.bridge.emit("observation", stored(1), [hook("large", "x".repeat(1500))]),
  ).not.toThrow();
  f.bridge.emit("observation", stored(2), [hook("large")]);
  expect(f.faults).toEqual([expect.any(RunQueueFullError)]);
  expect(f.process.close).toHaveBeenCalled();
});

test("replacement waits for confirmed owner close and drops the old volatile input", async () => {
  const f = fixture();
  await tick();
  const old = f.process;
  const exit = f.hold<void>(undefined);
  old.termination = exit.promise;
  f.bridge.message("old pending");
  f.bridge.detach();
  f.bridge.attach({ ...world, sessionId: "replacement" });
  old.emit("fault", new Error("retired owner"));
  await tick();
  expect(startPiProcess).toHaveBeenCalledTimes(1);
  expect(f.faults).toEqual([]);
  exit.resolve();
  await tick();
  expect(startPiProcess).toHaveBeenCalledTimes(2);
  expect(f.processes[1]!.batches()).toEqual([
    expect.objectContaining({
      binding: { ...world, sessionId: "replacement" },
      initial: true,
      playerMessages: [],
    }),
  ]);
  expect(old.listenerCount("fault")).toBe(0);
});

test("replacement during startup waits for the returned owner's cleanup", async () => {
  const f = fixture({ ready: false });
  const old = f.createProcess();
  const startup = f.hold<PiProcess>(old as unknown as PiProcess);
  const exit = f.hold<void>(undefined);
  old.termination = exit.promise;
  vi.mocked(startPiProcess).mockImplementationOnce(() => startup.promise);
  f.bridge.attach();
  await tick();
  f.bridge.detach();
  f.bridge.attach({ ...world, sessionId: "replacement" });
  startup.resolve(old as unknown as PiProcess);
  await tick();
  expect(old.run).not.toHaveBeenCalled();
  expect(old.close).toHaveBeenCalled();
  expect(startPiProcess).toHaveBeenCalledTimes(1);
  exit.resolve();
  await tick();
  expect(startPiProcess).toHaveBeenCalledTimes(2);
  expect(f.faults).toEqual([]);
});

test("close during startup disposes intake and waits for startup cleanup", async () => {
  const f = fixture({ ready: false });
  const owner = f.createProcess();
  const startup = f.hold<PiProcess>(owner as unknown as PiProcess);
  const exit = f.hold<void>(undefined);
  owner.termination = exit.promise;
  vi.mocked(startPiProcess).mockImplementationOnce(() => startup.promise);
  f.bridge.attach();
  await tick();
  let closed = false;
  const closing = f.scheduler.close();
  void closing.then(() => {
    closed = true;
  });
  expect(f.scheduler.close()).toBe(closing);
  expect(f.bridge.intake).toBeUndefined();
  startup.resolve(owner as unknown as PiProcess);
  await tick();
  expect(owner.run).not.toHaveBeenCalled();
  expect(closed).toBe(false);
  exit.resolve();
  await closing;
  expect(closed).toBe(true);
  expect(f.bridge.eventNames()).toEqual([]);
  expect(f.faults).toEqual([]);
});

test("undersized replacement admission still waits for predecessor termination", async () => {
  const f = fixture({ maxPendingBytes: 250 });
  await tick();
  const exit = f.hold<void>(undefined);
  f.process.termination = exit.promise;
  f.bridge.detach();
  f.bridge.attach({ ...world, worldId: "x".repeat(128), sessionId: "replacement" });
  let closed = false;
  const closing = f.scheduler.close();
  void closing.then(() => {
    closed = true;
  });
  await tick();
  expect(f.faults).toEqual([expect.any(RunQueueFullError)]);
  expect(closed).toBe(false);
  expect(startPiProcess).toHaveBeenCalledTimes(1);
  exit.resolve();
  await closing;
  expect(closed).toBe(true);
});

test("an ambiguous run rejection stops admission and never replays pending reasons", async () => {
  const f = fixture();
  await tick();
  const error = new Error("prompt acknowledgment lost");
  f.bridge.message("not replayable");
  f.process.pending[0]!.reject(error);
  await tick();
  expect(f.faults).toEqual([error]);
  expect(f.process.close).toHaveBeenCalled();
  f.bridge.detach();
  f.bridge.attach({ ...world, sessionId: "replacement" });
  await tick();
  expect(startPiProcess).toHaveBeenCalledTimes(1);
  expect(() => f.bridge.message("refused")).toThrowError(expect.objectContaining({ code: -32004 }));
});

test("startup failure does not restart automatically on a later ready world", async () => {
  const f = fixture({ ready: false });
  const error = new Error("not ready");
  vi.mocked(startPiProcess).mockRejectedValueOnce(error);
  f.bridge.attach();
  await tick();
  f.bridge.detach();
  f.bridge.attach({ ...world, sessionId: "replacement" });
  await tick();
  expect(f.faults).toEqual([error]);
  expect(startPiProcess).toHaveBeenCalledTimes(1);
});

test("cleanup rejection keeps replacement and close failed", async () => {
  const f = fixture();
  await tick();
  const exit = f.hold<void>(undefined);
  const error = new Error("termination unconfirmed");
  f.process.termination = exit.promise;
  f.expectedCloseError = error;
  f.bridge.detach();
  f.bridge.attach({ ...world, sessionId: "replacement" });
  exit.reject(error);
  await tick();
  expect(startPiProcess).toHaveBeenCalledTimes(1);
  expect(f.faults).toEqual([error]);
  await expect(f.scheduler.close()).rejects.toBe(error);
});

test("owner fault retires the current world before notifying the caller", async () => {
  const f = fixture();
  await tick();
  const error = new Error("Pi disconnected");
  f.process.emit("fault", error);
  expect(f.process.close).toHaveBeenCalled();
  expect(f.faults).toEqual([error]);
  expect(() => f.bridge.message("refused")).toThrowError(expect.objectContaining({ code: -32004 }));
});

test("close publishes its identity before an owner callback can reenter", async () => {
  const f = fixture();
  await tick();
  let reentrant: Promise<void> | undefined;
  f.process.onClose = () => {
    reentrant = f.scheduler.close();
  };
  const closing = f.scheduler.close();
  expect(reentrant).toBe(closing);
  expect(f.scheduler.close()).toBe(closing);
  await closing;
});

test.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid byte budget %s",
  (maxPendingBytes) => {
    expect(() => fixture({ maxPendingBytes })).toThrow("Invalid run queue byte budget");
    expect(startPiProcess).not.toHaveBeenCalled();
  },
);

test("reports an undersized initial batch after the caller can subscribe", async () => {
  const f = fixture({ maxPendingBytes: 1 });
  await tick();
  expect(f.faults).toEqual([expect.any(RunQueueFullError)]);
  expect(startPiProcess).not.toHaveBeenCalled();
});

test("poll waits for active 60 seconds and does not replay missed intervals", async () => {
  const f = fixture();
  await tick();
  f.process.settle();
  await tick();
  f.at(59_999);
  expect(f.scheduler.poll(world)).toBe(false);
  f.at(60_000);
  expect(f.scheduler.poll(world)).toBe(true);
  expect(f.process.batches()[1]).toMatchObject({ initial: false, poll: true });
  f.process.settle();
  await tick();
  f.at(270_000);
  expect(f.scheduler.poll(world)).toBe(true);
  expect(f.scheduler.poll(world)).toBe(false);
  f.process.settle();
  await tick();
  expect(f.process.run).toHaveBeenCalledTimes(3);
});

test.each([false, true])(
  "hook settlement clears queued polls and restarts 60 active seconds (paused: %s)",
  async (paused) => {
    const f = fixture();
    await tick();
    f.process.settle();
    await tick();
    f.at(59_000);
    f.bridge.emit("observation", stored(1), [hook("important")]);
    f.at(60_000);
    expect(f.scheduler.poll(world)).toBe(true);
    f.bridge.message("keep this input");
    if (paused) f.bridge.pause(true);
    f.at(70_000);
    f.process.settle({ status: "settled", aborted: paused });
    await tick();
    const resumedAt = paused ? 1_000_000 : 70_000;
    f.at(resumedAt);
    if (paused) f.bridge.pause(false);
    expect(f.process.batches()[2]).toMatchObject({
      poll: false,
      playerMessages: ["keep this input"],
    });
    f.process.settle();
    await tick();
    f.at(resumedAt + 59_999);
    expect(f.scheduler.poll(world)).toBe(false);
    f.at(resumedAt + 60_000);
    expect(f.scheduler.poll(world)).toBe(true);
    expect(f.process.batches()[3]).toMatchObject({ poll: true });
    expect(f.faults).toEqual([]);
  },
);

test("busy polling coalesces with all pending player and hook reasons", async () => {
  const f = fixture();
  await tick();
  f.at(60_000);
  expect(f.scheduler.poll(world)).toBe(true);
  f.bridge.message("player first");
  f.bridge.emit("observation", stored(1), [hook("important")]);
  f.at(120_000);
  expect(f.scheduler.poll(world)).toBe(true);
  expect(f.process.run).toHaveBeenCalledTimes(1);
  f.process.settle();
  await tick();
  expect(f.process.batches()[1]).toMatchObject({
    poll: true,
    playerMessages: ["player first"],
    hooks: [{ id: "important", eventIds: [1] }],
  });
  f.process.settle();
  await tick();
  expect(f.process.run).toHaveBeenCalledTimes(2);
});

test("paused time is excluded and pending poll waits for occupied settlement on resume", async () => {
  const f = fixture();
  await tick();
  f.at(25_000);
  f.bridge.pause(true);
  f.at(1_000_000);
  expect(f.scheduler.poll(world)).toBe(false);
  f.bridge.pause(false);
  f.at(1_034_999);
  expect(f.scheduler.poll(world)).toBe(false);
  f.at(1_035_000);
  expect(f.scheduler.poll(world)).toBe(true);
  f.bridge.pause(true);
  f.process.settle({ status: "settled", aborted: true });
  await tick();
  expect(f.process.run).toHaveBeenCalledTimes(1);
  f.at(2_000_000);
  f.bridge.pause(false);
  expect(f.process.batches()[1]).toMatchObject({ poll: true });
});

test("initial pause and duplicate attach do not count paused time or reset active time", async () => {
  const f = fixture({ paused: true });
  await tick();
  f.at(600_000);
  expect(f.scheduler.poll(world)).toBe(false);
  f.bridge.pause(false);
  f.at(630_000);
  f.bridge.emit("attach", f.bridge.readySession);
  f.at(660_000);
  expect(f.scheduler.poll(world)).toBe(true);
  f.process.settle();
  await tick();
  expect(f.process.batches()[1]).toMatchObject({ poll: true });
});

test("replacement resets elapsed and refuses late poll and status from the old binding", async () => {
  const f = fixture();
  await tick();
  f.at(59_000);
  f.bridge.detach();
  expect(f.scheduler.poll(world)).toBe(false);
  const replacement = { ...world, sessionId: "replacement" };
  f.at(1_000_000);
  f.bridge.attach(replacement);
  await tick();
  f.at(1_001_000);
  expect(f.scheduler.poll(world)).toBe(false);
  f.bridge.emit("status", { binding: world, paused: true, supportedEvents: [] });
  expect(f.scheduler.poll(replacement)).toBe(false);
  f.at(1_060_000);
  expect(f.scheduler.poll(replacement)).toBe(true);
  f.processes[1]!.settle();
  await tick();
  expect(f.processes[1]!.batches()[1]).toMatchObject({ binding: replacement, poll: true });
});

test("poll before ready, after fault or after close cannot admit late work", async () => {
  const f = fixture({ ready: false });
  f.at(60_000);
  expect(f.scheduler.poll(world)).toBe(false);
  f.bridge.attach();
  await tick();
  f.at(120_000);
  expect(f.scheduler.poll(world)).toBe(true);
  f.process.emit("fault", new Error("failed owner"));
  f.at(180_000);
  expect(f.scheduler.poll(world)).toBe(false);
  await f.scheduler.close();
  expect(f.scheduler.poll(world)).toBe(false);
  expect(f.process.run).toHaveBeenCalledTimes(1);
});

test("close alone discards pending poll and rejects subsequent timer callbacks", async () => {
  const f = fixture();
  await tick();
  f.at(60_000);
  expect(f.scheduler.poll(world)).toBe(true);
  const closing = f.scheduler.close();
  f.at(120_000);
  expect(f.scheduler.poll(world)).toBe(false);
  await closing;
  expect(f.process.run).toHaveBeenCalledTimes(1);
});

test("invalid monotonic time fails scheduling explicitly and prevents new polls", async () => {
  const f = fixture();
  await tick();
  f.at(-1);
  expect(f.scheduler.poll(world)).toBe(false);
  expect(f.faults).toEqual([expect.objectContaining({ message: "Invalid monotonic time" })]);
  f.at(60_000);
  expect(f.scheduler.poll(world)).toBe(false);
  expect(f.process.close).toHaveBeenCalled();
});

test("the Pi envelope budget accommodates an admitted quote-heavy run", async () => {
  const f = fixture();
  await tick();
  const messages = Array<string>(17).fill('"'.repeat(16_000));
  for (const text of messages) expect(f.bridge.message(text)).toBeUndefined();
  f.process.settle();
  await tick();
  const message = f.process.run.mock.calls[1]![0];
  expect(f.process.batches()[1]!.playerMessages).toEqual(messages);
  expect(Buffer.byteLength(message)).toBeLessThanOrEqual(1024 * 1024);
  // Exercise the same Pi-only framing used by the production stdio driver.
  expect(() => encodePiJsonLine({ id: "1", type: "prompt", message })).not.toThrow();
});
