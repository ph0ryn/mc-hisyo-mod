import { EventEmitter } from "node:events";
import { beforeEach, expect, onTestFinished, test, vi } from "vite-plus/test";
import type { AttachedWorld, DirectorBridge } from "../bridge/directorBridge.js";
import type { StoredEvent } from "../events/eventLog.js";
import type { ResponseHook } from "../hooks/responseHooks.js";
import type { PiJudgment } from "../pi/piRpcClient.js";
import type { WorldBinding } from "../protocol/bridge.js";
import { encodePiJsonLine } from "../pi/piFraming.js";
import { RpcError } from "../transport/rpcPeer.js";
import type { JudgmentBatch } from "./judgmentQueue.js";
import { JudgmentQueueFullError } from "./judgmentQueue.js";
import { JudgmentScheduler, type JudgmentSchedulerOptions } from "./judgmentScheduler.js";
import { startPiSession } from "./piSession.js";

vi.mock("./piSession.js", () => ({ startPiSession: vi.fn() }));

const world: WorldBinding = {
  worldId: "world-a",
  playerId: "player-a",
  worldSessionId: "session-a",
};
type Session = Awaited<ReturnType<typeof startPiSession>>;
type Intake = Parameters<DirectorBridge["handlePlayerMessages"]>[0];

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
  readyWorld: AttachedWorld | undefined;
  intake: Intake | undefined;
  readonly handlePlayerMessages = vi.fn<DirectorBridge["handlePlayerMessages"]>((accept) => {
    this.intake = accept;
    return () => {
      this.intake = undefined;
    };
  });

  attach(binding = world, paused = false) {
    this.readyWorld = { binding, supportedEvents: ["block_broken"], paused };
    this.emit("attach", this.readyWorld);
  }

  detach() {
    const binding = this.readyWorld!.binding;
    this.readyWorld = undefined;
    this.emit("detach", binding);
  }

  pause(paused: boolean) {
    this.readyWorld = { ...this.readyWorld!, paused };
    this.emit("status", this.readyWorld);
  }

  message(text: string, binding = this.readyWorld!.binding) {
    if (!this.intake) throw new RpcError(-32003, "No player-message intake");
    return this.intake(binding, text);
  }
}

class SessionStub extends EventEmitter<{ fault: [error: Error] }> {
  readonly pending: ReturnType<typeof deferred<PiJudgment>>[] = [];
  termination: Promise<void> = Promise.resolve();
  onClose: (() => void) | undefined;
  #shutdown: Promise<void> | undefined;
  readonly judge = vi.fn<Session["judge"]>(() => {
    const flight = deferred<PiJudgment>();
    this.pending.push(flight);
    return flight.promise;
  });
  readonly close = vi.fn<Session["close"]>(() => {
    if (!this.#shutdown) {
      this.#shutdown = this.termination.then(() => {
        for (const flight of this.pending) flight.resolve({ status: "settled", aborted: true });
      });
      this.onClose?.();
    }
    return this.#shutdown;
  });

  batches() {
    return this.judge.mock.calls.map(([message]) => JSON.parse(message) as JudgmentBatch);
  }

  settle(result: PiJudgment = { status: "settled", aborted: false }) {
    this.pending.at(-1)!.resolve(result);
  }
}

beforeEach(() => vi.mocked(startPiSession).mockReset());

function fixture(config: { ready?: boolean; paused?: boolean; maxPendingBytes?: number } = {}) {
  const bridge = new BridgeStub();
  if (config.ready !== false) bridge.attach(world, config.paused);
  const sessions: SessionStub[] = [];
  function createSession() {
    const session = new SessionStub();
    sessions.push(session);
    return session;
  }
  vi.mocked(startPiSession).mockImplementation(async () => createSession() as unknown as Session);
  const options: JudgmentSchedulerOptions = {
    // Nominal concrete dependencies are never constructed by these unit tests.
    bridge: bridge as unknown as DirectorBridge,
    dataDirectory: "/unused",
    executable: "never-launched",
    bundledExtension: "/unused/directorBridge.mjs",
    prefixArgs: ["original"],
    connection: { protocolVersion: 1, host: "127.0.0.1", port: 1, token: "unused", pid: 1 },
    model: {
      provider: "test-provider",
      id: "test-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "unused",
      definition: {
        name: "Test",
        reasoning: true,
        input: ["text"],
        contextWindow: 10_000,
        maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    },
    ...(config.maxPendingBytes === undefined ? {} : { maxPendingBytes: config.maxPendingBytes }),
  };
  const scheduler = new JudgmentScheduler(options);
  const faults: Error[] = [];
  scheduler.on("fault", (error) => faults.push(error));
  const releases: (() => void)[] = [];
  const f = {
    bridge,
    sessions,
    createSession,
    scheduler,
    options,
    faults,
    expectedCloseError: undefined as Error | undefined,
    get session() {
      return sessions[0]!;
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

function hook(id: string, instruction = id): ResponseHook {
  return { id, event: "block_broken", filter: {}, instruction };
}

test("starts once for an already-ready world and snapshots the owner configuration", async () => {
  const f = fixture();
  f.options.model.id = "changed";
  f.options.connection.port = 99;
  f.options.prefixArgs = ["changed"];
  await tick();
  f.bridge.emit("attach", f.bridge.readyWorld);
  await tick();
  expect(startPiSession).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      world,
      model: expect.objectContaining({ id: "test-model" }),
      connection: expect.objectContaining({ port: 1 }),
      prefixArgs: ["original"],
    }),
  );
  expect(f.session.batches()).toEqual([
    {
      binding: world,
      worldStart: true,
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
  expect(startPiSession).not.toHaveBeenCalled();
  expect(() => f.bridge.message("early", world)).toThrowError(
    expect.objectContaining({ code: -32003 }),
  );
  f.bridge.attach();
  await tick();
  expect(f.session.judge).toHaveBeenCalledTimes(1);
  expect(() => f.bridge.message("stale", { ...world, worldSessionId: "old" })).toThrowError(
    expect.objectContaining({ code: -32003 }),
  );
});

test("preserves ordered duplicate chats in one subsequent judgment", async () => {
  const f = fixture();
  await tick();
  for (const text of ["first", "same", "same"]) expect(f.bridge.message(text)).toBeUndefined();
  expect(f.session.judge).toHaveBeenCalledTimes(1);
  f.session.settle();
  await tick();
  expect(f.session.batches()[1]).toMatchObject({
    worldStart: false,
    playerMessages: ["first", "same", "same"],
  });
  f.session.settle();
  await tick();
  expect(f.session.judge).toHaveBeenCalledTimes(2);
});

test("starts an initially paused owner but waits for play before sending start and chat", async () => {
  const f = fixture({ paused: true });
  await tick();
  expect(startPiSession).toHaveBeenCalledTimes(1);
  expect(f.session.judge).not.toHaveBeenCalled();
  f.bridge.message("while paused");
  f.bridge.pause(false);
  await tick();
  expect(f.session.batches()).toEqual([
    expect.objectContaining({ worldStart: true, playerMessages: ["while paused"] }),
  ]);
});

test("resume before settlement cannot overlap the occupied judgment", async () => {
  const f = fixture();
  await tick();
  f.bridge.pause(true);
  f.bridge.message("next");
  f.bridge.pause(false);
  expect(f.session.judge).toHaveBeenCalledTimes(1);
  f.session.settle({ status: "settled", aborted: true });
  await tick();
  expect(f.session.batches()[1]).toMatchObject({ worldStart: false, playerMessages: ["next"] });
});

test("not_started retains its batch separately from newly admitted input", async () => {
  const f = fixture();
  await tick();
  f.bridge.pause(true);
  f.bridge.message("next batch");
  f.session.settle({ status: "not_started" });
  await tick();
  expect(f.session.judge).toHaveBeenCalledTimes(1);
  f.bridge.pause(false);
  await tick();
  expect(f.session.batches()[1]).toEqual(f.session.batches()[0]);
  f.session.settle();
  await tick();
  expect(f.session.batches()[2]).toMatchObject({
    worldStart: false,
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
  f.session.settle();
  await tick();
  expect(f.session.batches()[1]).toMatchObject({
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
  f.session.settle();
  await tick();
  f.bridge.emit("observation", stored(1), []);
  await tick();
  expect(f.session.judge).toHaveBeenCalledTimes(1);
  f.bridge.message("chat");
  expect(f.session.batches()[1]).toMatchObject({ playerMessages: ["chat"], observations: [] });
});

test("chat overflow requests owner retirement before fault and refuses future worlds", async () => {
  const f = fixture({ maxPendingBytes: 1024 });
  await tick();
  const closeCallsAtFault: number[] = [];
  f.scheduler.on("fault", () => closeCallsAtFault.push(f.session.close.mock.calls.length));
  f.bridge.message("x".repeat(700));
  expect(() => f.bridge.message("x".repeat(700))).toThrowError(
    expect.objectContaining({ code: -32004 }),
  );
  expect(f.faults).toEqual([expect.any(JudgmentQueueFullError)]);
  expect(closeCallsAtFault[0]).toBeGreaterThan(0);
  f.bridge.detach();
  f.bridge.attach({ ...world, worldSessionId: "later" });
  await tick();
  expect(startPiSession).toHaveBeenCalledTimes(1);
  expect(() => f.bridge.message("later")).toThrowError(expect.objectContaining({ code: -32004 }));
});

test("hook overflow reports a fault without throwing out of the stored-observation callback", async () => {
  const f = fixture({ maxPendingBytes: 1024 });
  await tick();
  expect(() =>
    f.bridge.emit("observation", stored(1), [hook("large", "x".repeat(1500))]),
  ).not.toThrow();
  f.bridge.emit("observation", stored(2), [hook("large")]);
  expect(f.faults).toEqual([expect.any(JudgmentQueueFullError)]);
  expect(f.session.close).toHaveBeenCalled();
});

test("replacement waits for confirmed owner close and drops the old volatile input", async () => {
  const f = fixture();
  await tick();
  const old = f.session;
  const exit = f.hold<void>(undefined);
  old.termination = exit.promise;
  f.bridge.message("old pending");
  f.bridge.detach();
  f.bridge.attach({ ...world, worldSessionId: "replacement" });
  old.emit("fault", new Error("retired owner"));
  await tick();
  expect(startPiSession).toHaveBeenCalledTimes(1);
  expect(f.faults).toEqual([]);
  exit.resolve();
  await tick();
  expect(startPiSession).toHaveBeenCalledTimes(2);
  expect(f.sessions[1]!.batches()).toEqual([
    expect.objectContaining({
      binding: { ...world, worldSessionId: "replacement" },
      worldStart: true,
      playerMessages: [],
    }),
  ]);
  expect(old.listenerCount("fault")).toBe(0);
});

test("replacement during startup waits for the returned owner's cleanup", async () => {
  const f = fixture({ ready: false });
  const old = f.createSession();
  const startup = f.hold<Session>(old as unknown as Session);
  const exit = f.hold<void>(undefined);
  old.termination = exit.promise;
  vi.mocked(startPiSession).mockImplementationOnce(() => startup.promise);
  f.bridge.attach();
  await tick();
  f.bridge.detach();
  f.bridge.attach({ ...world, worldSessionId: "replacement" });
  startup.resolve(old as unknown as Session);
  await tick();
  expect(old.judge).not.toHaveBeenCalled();
  expect(old.close).toHaveBeenCalled();
  expect(startPiSession).toHaveBeenCalledTimes(1);
  exit.resolve();
  await tick();
  expect(startPiSession).toHaveBeenCalledTimes(2);
  expect(f.faults).toEqual([]);
});

test("close during startup disposes intake and waits for startup cleanup", async () => {
  const f = fixture({ ready: false });
  const owner = f.createSession();
  const startup = f.hold<Session>(owner as unknown as Session);
  const exit = f.hold<void>(undefined);
  owner.termination = exit.promise;
  vi.mocked(startPiSession).mockImplementationOnce(() => startup.promise);
  f.bridge.attach();
  await tick();
  let closed = false;
  const closing = f.scheduler.close();
  void closing.then(() => {
    closed = true;
  });
  expect(f.scheduler.close()).toBe(closing);
  expect(f.bridge.intake).toBeUndefined();
  startup.resolve(owner as unknown as Session);
  await tick();
  expect(owner.judge).not.toHaveBeenCalled();
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
  f.session.termination = exit.promise;
  f.bridge.detach();
  f.bridge.attach({ ...world, worldId: "x".repeat(128), worldSessionId: "replacement" });
  let closed = false;
  const closing = f.scheduler.close();
  void closing.then(() => {
    closed = true;
  });
  await tick();
  expect(f.faults).toEqual([expect.any(JudgmentQueueFullError)]);
  expect(closed).toBe(false);
  expect(startPiSession).toHaveBeenCalledTimes(1);
  exit.resolve();
  await closing;
  expect(closed).toBe(true);
});

test("an ambiguous judgment rejection stops admission and never replays pending reasons", async () => {
  const f = fixture();
  await tick();
  const error = new Error("prompt acknowledgment lost");
  f.bridge.message("not replayable");
  f.session.pending[0]!.reject(error);
  await tick();
  expect(f.faults).toEqual([error]);
  expect(f.session.close).toHaveBeenCalled();
  f.bridge.detach();
  f.bridge.attach({ ...world, worldSessionId: "replacement" });
  await tick();
  expect(startPiSession).toHaveBeenCalledTimes(1);
  expect(() => f.bridge.message("refused")).toThrowError(expect.objectContaining({ code: -32004 }));
});

test("startup failure does not restart automatically on a later ready world", async () => {
  const f = fixture({ ready: false });
  const error = new Error("not ready");
  vi.mocked(startPiSession).mockRejectedValueOnce(error);
  f.bridge.attach();
  await tick();
  f.bridge.detach();
  f.bridge.attach({ ...world, worldSessionId: "replacement" });
  await tick();
  expect(f.faults).toEqual([error]);
  expect(startPiSession).toHaveBeenCalledTimes(1);
});

test("cleanup rejection keeps replacement and close failed", async () => {
  const f = fixture();
  await tick();
  const exit = f.hold<void>(undefined);
  const error = new Error("termination unconfirmed");
  f.session.termination = exit.promise;
  f.expectedCloseError = error;
  f.bridge.detach();
  f.bridge.attach({ ...world, worldSessionId: "replacement" });
  exit.reject(error);
  await tick();
  expect(startPiSession).toHaveBeenCalledTimes(1);
  expect(f.faults).toEqual([error]);
  await expect(f.scheduler.close()).rejects.toBe(error);
});

test("owner fault retires the current world before notifying the caller", async () => {
  const f = fixture();
  await tick();
  const error = new Error("Pi disconnected");
  f.session.emit("fault", error);
  expect(f.session.close).toHaveBeenCalled();
  expect(f.faults).toEqual([error]);
  expect(() => f.bridge.message("refused")).toThrowError(expect.objectContaining({ code: -32004 }));
});

test("close publishes its identity before an owner callback can reenter", async () => {
  const f = fixture();
  await tick();
  let reentrant: Promise<void> | undefined;
  f.session.onClose = () => {
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
    expect(() => fixture({ maxPendingBytes })).toThrow("Invalid judgment queue byte budget");
    expect(startPiSession).not.toHaveBeenCalled();
  },
);

test("reports an undersized initial batch after the caller can subscribe", async () => {
  const f = fixture({ maxPendingBytes: 1 });
  await tick();
  expect(f.faults).toEqual([expect.any(JudgmentQueueFullError)]);
  expect(startPiSession).not.toHaveBeenCalled();
});

test("the Pi envelope budget accommodates an admitted quote-heavy judgment", async () => {
  const f = fixture();
  await tick();
  const messages = Array<string>(17).fill('"'.repeat(16_000));
  for (const text of messages) expect(f.bridge.message(text)).toBeUndefined();
  f.session.settle();
  await tick();
  const message = f.session.judge.mock.calls[1]![0];
  expect(f.session.batches()[1]!.playerMessages).toEqual(messages);
  expect(Buffer.byteLength(message)).toBeLessThanOrEqual(1024 * 1024);
  // Exercise the same Pi-only framing used by the production stdio driver.
  expect(() => encodePiJsonLine({ id: "1", type: "prompt", message })).not.toThrow();
});
