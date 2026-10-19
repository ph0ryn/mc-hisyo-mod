import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Model } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Conversation } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import type { AttachedSession, BridgeServer } from "../bridge/bridgeServer.js";
import type { StoredEvent } from "../storage/eventLog.js";
import { runRequestActivities } from "../events/activity.js";
import { initializeActivityDatabase } from "../storage/activityDatabase.js";
import { ActivityLog } from "../storage/activityLog.js";
import type { Hook } from "../storage/hookStore.js";
import type { SessionBinding } from "../protocol/bridge.js";
import { RpcError } from "../transport/rpcPeer.js";
import type { RunRequest } from "./runQueue.js";
import { RunQueueFullError } from "./runQueue.js";
import { RunInbox } from "./runInbox.js";
import { RunScheduler, type RunAgent, type RunSchedulerOptions } from "./runScheduler.js";

type RunResult = Awaited<ReturnType<RunAgent["run"]>>;

const world: SessionBinding = {
  worldId: "world-a",
  playerId: "player-a",
  sessionId: "session-a",
};
type Intake = Parameters<BridgeServer["handlePlayerMessages"]>[0];
type ObservationIntake = Parameters<BridgeServer["handleObservations"]>[0];
const model: Model<"openai-responses"> = {
  provider: "openai",
  id: "gpt-6-luna",
  name: "unrequested test model",
  api: "openai-responses",
  baseUrl: "https://fake.invalid",
  reasoning: true,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Stub the game and agent ports, but exercise real Durable transactions and documents.
class BridgeStub extends EventEmitter {
  readySession: AttachedSession | undefined;
  intake: Intake | undefined;
  observationIntake: ObservationIntake | undefined;
  readonly invalidateRun = vi.fn<BridgeServer["invalidateRun"]>();
  readonly handlePlayerMessages = vi.fn<BridgeServer["handlePlayerMessages"]>((accept) => {
    this.intake = accept;
    return () => {
      this.intake = undefined;
    };
  });
  readonly handleObservations = vi.fn<BridgeServer["handleObservations"]>((accept) => {
    this.observationIntake = accept;
    return () => {
      this.observationIntake = undefined;
    };
  });

  async observe(stored: StoredEvent, hooks: Hook[] = []) {
    await this.observationIntake?.(stored, hooks);
  }

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

  async message(text: string, binding = this.readySession!.binding) {
    if (!this.intake) throw new RpcError(-32003, "No player-message intake");
    await this.intake(binding, text);
  }
}

class AgentStub extends EventEmitter<{ fault: [error: Error] }> implements RunAgent {
  readonly pending: ReturnType<typeof deferred<RunResult>>[] = [];
  termination: Promise<void> = Promise.resolve();
  onClose: (() => void) | undefined;
  #shutdown: Promise<void> | undefined;
  constructor(readonly conversation: Conversation) {
    super();
  }
  readonly run = vi.fn<RunAgent["run"]>(() => {
    const flight = deferred<RunResult>();
    this.pending.push(flight);
    return flight.promise;
  });
  readonly summarize = vi.fn<RunAgent["summarize"]>(async () => "independent summary");
  readonly abort = vi.fn<RunAgent["abort"]>(async () => {
    for (const flight of this.pending) flight.resolve({ status: "settled", aborted: true });
  });
  readonly close = vi.fn<RunAgent["close"]>(() => {
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

  settle(result: RunResult = { status: "settled", aborted: false }) {
    this.pending.at(-1)!.resolve(result);
  }
}

async function fixture(
  config: { ready?: boolean; paused?: boolean; maxPendingBytes?: number } = {},
) {
  let now = 0;
  const bridge = new BridgeStub();
  if (config.ready !== false) bridge.attach(world, config.paused);
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const harnesses: Harness[] = [];
  const agents: AgentStub[] = [];
  async function createAgent(conversation?: Conversation) {
    if (!conversation) {
      const harness = await Harness.open(
        new MemoryStorage(),
        { models, registry: createRegistry() },
        BACKGROUND_CONTEXT,
      );
      harnesses.push(harness);
      conversation = await harness.root(BACKGROUND_CONTEXT);
    }
    const agent = new AgentStub(conversation);
    agents.push(agent);
    return agent;
  }
  const startAgent = vi.fn<NonNullable<RunSchedulerOptions["startAgent"]>>(async () =>
    createAgent(),
  );
  const options: RunSchedulerOptions = {
    bridge: bridge as unknown as BridgeServer,
    dataDirectory: "/unused",
    monotonicNow: () => now,
    modelAccess: { models, model },
    startAgent,
    ...(config.maxPendingBytes === undefined ? {} : { maxPendingBytes: config.maxPendingBytes }),
  };
  const scheduler = new RunScheduler(options);
  const faults: Error[] = [];
  scheduler.on("fault", (error) => faults.push(error));
  const releases: (() => void)[] = [];
  const f = {
    bridge,
    agents,
    createAgent,
    startAgent,
    scheduler,
    options,
    faults,
    expectedCloseError: undefined as Error | undefined,
    at(value: number) {
      now = value;
    },
    get agent() {
      return agents[0]!;
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
    for (const harness of harnesses) await harness.close(BACKGROUND_CONTEXT);
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

test("starts once for an already-ready world with SDK model access and no executable transport", async () => {
  const f = await fixture();
  await tick();
  f.bridge.emit("attach", f.bridge.readySession);
  await tick();
  expect(f.startAgent).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ session: world, modelAccess: f.options.modelAccess }),
  );
  const supplied = f.startAgent.mock.calls[0]![0];
  for (const obsolete of ["executable", "connection", "bundledExtension", "prefixArgs", "apiKey"])
    expect(supplied).not.toHaveProperty(obsolete);
  expect(f.agent.batches()).toEqual([
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
  const f = await fixture({ ready: false });
  await tick();
  expect(f.startAgent).not.toHaveBeenCalled();
  await expect(f.bridge.message("early", world)).rejects.toMatchObject(
    expect.objectContaining({ code: -32003 }),
  );
  f.bridge.attach();
  await tick();
  expect(f.agent.run).toHaveBeenCalledTimes(1);
  await expect(f.bridge.message("stale", { ...world, sessionId: "old" })).rejects.toMatchObject(
    expect.objectContaining({ code: -32003 }),
  );
});

test("preserves ordered duplicate chats in one subsequent run", async () => {
  const f = await fixture();
  await tick();
  for (const text of ["first", "same", "same"])
    await expect(f.bridge.message(text)).resolves.toBeUndefined();
  expect(f.agent.run).toHaveBeenCalledTimes(1);
  f.agent.settle();
  await tick();
  expect(f.agent.batches()[1]).toMatchObject({
    initial: false,
    playerMessages: ["first", "same", "same"],
  });
  f.agent.settle();
  await tick();
  expect(f.agent.run).toHaveBeenCalledTimes(2);
});

test.each([false, true])(
  "notifies advancement unlocks without hooks (paused=%s)",
  async (paused) => {
    const f = await fixture();
    await tick();
    f.agent.settle();
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
      await f.bridge.observe({ ...completed, observation }, []);
    await tick();
    expect(f.agent.run).toHaveBeenCalledTimes(1);

    f.bridge.pause(paused);
    await f.bridge.observe(completed, []);
    await tick();
    if (paused) {
      expect(f.agent.run).toHaveBeenCalledTimes(1);
      f.bridge.pause(false);
      await tick();
      await tick();
    }
    expect(f.agent.batches()[1]).toMatchObject({ hooks: [], observations: [completed] });

    const next = { ...completed, id: 2, observation: { ...completed.observation, seq: 2 } };
    const matched = {
      ...hook("advancement", "react to the unlock"),
      event: "advancement_completed",
    };
    await f.bridge.observe(next, [matched]);
    await tick();
    expect(f.agent.run).toHaveBeenCalledTimes(2);
    f.agent.settle();
    await tick();
    expect(f.agent.batches()[2]).toMatchObject({
      hooks: [{ id: matched.id, instruction: matched.instruction, eventIds: [next.id] }],
      observations: [next],
    });
    f.agent.settle();
    await tick();
    expect(f.agent.run).toHaveBeenCalledTimes(3);
    expect(f.faults).toEqual([]);
  },
);

test("starts an initially paused owner but waits for play before sending start and chat", async () => {
  const f = await fixture({ paused: true });
  await tick();
  expect(f.startAgent).toHaveBeenCalledTimes(1);
  expect(f.agent.run).not.toHaveBeenCalled();
  await f.bridge.message("while paused");
  f.bridge.pause(false);
  await tick();
  expect(f.agent.batches()).toEqual([
    expect.objectContaining({ initial: true, playerMessages: ["while paused"] }),
  ]);
});

test("resume before settlement cannot overlap the occupied run", async () => {
  const f = await fixture();
  await tick();
  f.bridge.pause(true);
  await f.bridge.message("next");
  f.bridge.pause(false);
  await tick();
  expect(f.agent.run).toHaveBeenCalledTimes(1);
  f.agent.settle({ status: "settled", aborted: true });
  await tick();
  expect(f.agent.batches()[1]).toMatchObject({ initial: false, playerMessages: ["next"] });
});

test("not_started retains its batch separately from newly admitted input", async () => {
  const f = await fixture();
  await tick();
  f.bridge.pause(true);
  await f.bridge.message("next batch");
  f.agent.settle({ status: "not_started" });
  await tick();
  expect(f.agent.run).toHaveBeenCalledTimes(1);
  f.bridge.pause(false);
  await tick();
  expect(f.agent.batches()[1]).toEqual(f.agent.batches()[0]);
  expect(f.agent.run.mock.calls[1]![2]).toBe(f.agent.run.mock.calls[0]![2]);
  f.agent.settle();
  await tick();
  expect(f.agent.batches()[2]).toMatchObject({
    initial: false,
    playerMessages: ["next batch"],
  });
});

test("takes only matching observations and firing-time hooks into the next batch", async () => {
  const f = await fixture();
  await tick();
  const first = hook("removed", "original instruction");
  const second = hook("retained");
  const one = stored(1);
  const three = stored(3, 5);
  await f.bridge.observe(one, [first, second]);
  first.instruction = "changed after admission";
  await f.bridge.observe(stored(2), []);
  await f.bridge.observe(three, [second]);
  f.agent.settle();
  await tick();
  expect(f.agent.batches()[1]).toMatchObject({
    hooks: [
      { id: "removed", instruction: "original instruction", eventIds: [1] },
      { id: "retained", instruction: "retained", eventIds: [1, 3] },
    ],
    observations: [one, three],
  });
});

test("ordinary observations do not start a main run or become chat prompt contents", async () => {
  const f = await fixture();
  await tick();
  f.agent.settle();
  await tick();
  await f.bridge.observe(stored(1), []);
  await tick();
  expect(f.agent.run).toHaveBeenCalledTimes(1);
  await f.bridge.message("chat");
  await tick();
  expect(f.agent.batches()[1]).toMatchObject({ playerMessages: ["chat"], observations: [] });
});

test("chat overflow requests owner retirement before fault and refuses future worlds", async () => {
  const f = await fixture({ maxPendingBytes: 1024 });
  await tick();
  const closeCallsAtFault: number[] = [];
  f.scheduler.on("fault", () => closeCallsAtFault.push(f.agent.close.mock.calls.length));
  await f.bridge.message("x".repeat(700));
  await expect(f.bridge.message("x".repeat(700))).rejects.toMatchObject(
    expect.objectContaining({ code: -32004 }),
  );
  expect(f.faults).toEqual([expect.any(RunQueueFullError)]);
  expect(closeCallsAtFault[0]).toBeGreaterThan(0);
  f.bridge.detach();
  f.bridge.attach({ ...world, sessionId: "later" });
  await tick();
  expect(f.startAgent).toHaveBeenCalledTimes(1);
  await expect(f.bridge.message("later")).rejects.toMatchObject(
    expect.objectContaining({ code: -32004 }),
  );
});

test("hook overflow reports a fault without throwing out of the stored-observation callback", async () => {
  const f = await fixture({ maxPendingBytes: 1024 });
  await tick();
  await expect(
    f.bridge.observe(stored(1), [hook("large", "x".repeat(1500))]),
  ).resolves.toBeUndefined();
  await f.bridge.observe(stored(2), [hook("large")]);
  expect(f.faults).toEqual([expect.any(RunQueueFullError)]);
  expect(f.agent.close).toHaveBeenCalled();
});

test("replacement waits for confirmed owner close and clears explicitly detached durable input", async () => {
  const f = await fixture();
  await tick();
  const old = f.agent;
  const exit = f.hold<void>(undefined);
  old.termination = exit.promise;
  await f.bridge.message("old pending");
  f.bridge.detach();
  f.bridge.attach({ ...world, sessionId: "replacement" });
  old.emit("fault", new Error("retired owner"));
  await tick();
  expect(f.startAgent).toHaveBeenCalledTimes(1);
  expect(f.faults).toEqual([]);
  exit.resolve();
  await tick();
  expect(f.startAgent).toHaveBeenCalledTimes(2);
  expect(f.agents[1]!.batches()).toEqual([
    expect.objectContaining({
      binding: { ...world, sessionId: "replacement" },
      initial: true,
      playerMessages: [],
    }),
  ]);
  expect(old.listenerCount("fault")).toBe(0);
});

test("replacement during startup waits for the returned owner's cleanup", async () => {
  const f = await fixture({ ready: false });
  const old = await f.createAgent();
  const startup = f.hold<RunAgent>(old as RunAgent);
  const exit = f.hold<void>(undefined);
  old.termination = exit.promise;
  f.startAgent.mockImplementationOnce(() => startup.promise);
  f.bridge.attach();
  await tick();
  f.bridge.detach();
  f.bridge.attach({ ...world, sessionId: "replacement" });
  startup.resolve(old as RunAgent);
  await tick();
  expect(old.run).not.toHaveBeenCalled();
  expect(old.close).toHaveBeenCalled();
  expect(f.startAgent).toHaveBeenCalledTimes(1);
  exit.resolve();
  await tick();
  expect(f.startAgent).toHaveBeenCalledTimes(2);
  expect(f.faults).toEqual([]);
});

test("close during startup disposes intake and waits for startup cleanup", async () => {
  const f = await fixture({ ready: false });
  const owner = await f.createAgent();
  const startup = f.hold<RunAgent>(owner as RunAgent);
  const exit = f.hold<void>(undefined);
  owner.termination = exit.promise;
  f.startAgent.mockImplementationOnce(() => startup.promise);
  f.bridge.attach();
  await tick();
  let closed = false;
  const closing = f.scheduler.close();
  void closing.then(() => {
    closed = true;
  });
  expect(f.scheduler.close()).toBe(closing);
  expect(f.bridge.intake).toBeUndefined();
  startup.resolve(owner as RunAgent);
  await tick();
  expect(owner.run).not.toHaveBeenCalled();
  expect(closed).toBe(false);
  exit.resolve();
  await closing;
  expect(closed).toBe(true);
  expect(f.bridge.eventNames()).toEqual([]);
  expect(f.faults).toEqual([]);
});

test("oversized replacement admission fails only after predecessor termination and never dispatches", async () => {
  const f = await fixture({ maxPendingBytes: 250 });
  await tick();
  const exit = f.hold<void>(undefined);
  f.agent.termination = exit.promise;
  f.bridge.detach();
  f.bridge.attach({ ...world, worldId: "x".repeat(128), sessionId: "replacement" });
  await tick();
  expect(f.startAgent).toHaveBeenCalledTimes(1);
  expect(f.faults).toEqual([]);
  exit.resolve();
  await tick();
  expect(f.startAgent).toHaveBeenCalledTimes(2);
  expect(f.faults).toEqual([expect.any(RunQueueFullError)]);
  f.expectedCloseError = f.faults[0];
  expect(f.agents[1]!.run).not.toHaveBeenCalled();
});

test("closing before replacement admission still waits for predecessor termination", async () => {
  const f = await fixture({ maxPendingBytes: 250 });
  await tick();
  const exit = f.hold<void>(undefined);
  f.agent.termination = exit.promise;
  f.bridge.detach();
  f.bridge.attach({ ...world, worldId: "x".repeat(128), sessionId: "replacement" });
  let closed = false;
  const closing = f.scheduler.close();
  void closing.then(() => {
    closed = true;
  });
  await tick();
  // The replacement cannot inspect or admit its inbox before predecessor termination.
  expect(f.faults).toEqual([]);
  expect(closed).toBe(false);
  expect(f.startAgent).toHaveBeenCalledTimes(1);
  exit.resolve();
  await closing;
  expect(closed).toBe(true);
});

test("an ambiguous run rejection stops admission and never automatically replays pending reasons", async () => {
  const f = await fixture();
  await tick();
  const error = new Error("prompt acknowledgment lost");
  await f.bridge.message("not replayable");
  f.agent.pending[0]!.reject(error);
  await tick();
  expect(f.faults).toEqual([error]);
  expect(f.agent.close).toHaveBeenCalled();
  f.bridge.detach();
  f.bridge.attach({ ...world, sessionId: "replacement" });
  await tick();
  expect(f.startAgent).toHaveBeenCalledTimes(1);
  await expect(f.bridge.message("refused")).rejects.toMatchObject(
    expect.objectContaining({ code: -32004 }),
  );
});

test("startup failure does not restart automatically on a later ready world", async () => {
  const f = await fixture({ ready: false });
  const error = new Error("not ready");
  f.expectedCloseError = error;
  f.startAgent.mockRejectedValueOnce(error);
  f.bridge.attach();
  await tick();
  f.bridge.detach();
  f.bridge.attach({ ...world, sessionId: "replacement" });
  await tick();
  expect(f.faults).toEqual([error]);
  expect(f.startAgent).toHaveBeenCalledTimes(1);
});

test("cleanup rejection keeps replacement and close failed", async () => {
  const f = await fixture();
  await tick();
  const exit = f.hold<void>(undefined);
  const error = new Error("termination unconfirmed");
  f.agent.termination = exit.promise;
  f.expectedCloseError = error;
  f.bridge.detach();
  f.bridge.attach({ ...world, sessionId: "replacement" });
  exit.reject(error);
  await tick();
  expect(f.startAgent).toHaveBeenCalledTimes(1);
  expect(f.faults).toEqual([error]);
  await expect(f.scheduler.close()).rejects.toBe(error);
});

test("owner fault retires the current world before notifying the caller", async () => {
  const f = await fixture();
  await tick();
  const error = new Error("agent fault");
  f.agent.emit("fault", error);
  expect(f.agent.close).toHaveBeenCalled();
  expect(f.faults).toEqual([error]);
  await expect(f.bridge.message("refused")).rejects.toMatchObject(
    expect.objectContaining({ code: -32004 }),
  );
});

test("close publishes its identity before an owner callback can reenter", async () => {
  const f = await fixture();
  await tick();
  let reentrant: Promise<void> | undefined;
  f.agent.onClose = () => {
    reentrant = f.scheduler.close();
  };
  const closing = f.scheduler.close();
  expect(reentrant).toBe(closing);
  expect(f.scheduler.close()).toBe(closing);
  await closing;
});

test.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid byte budget %s",
  async (maxPendingBytes) => {
    await expect(fixture({ maxPendingBytes })).rejects.toThrow("Invalid run queue byte budget");
  },
);

test("reports an undersized initial batch after the caller can subscribe without dispatching", async () => {
  const f = await fixture({ maxPendingBytes: 1 });
  await tick();
  expect(f.faults).toEqual([expect.any(RunQueueFullError)]);
  f.expectedCloseError = f.faults[0];
  expect(f.agent.run).not.toHaveBeenCalled();
});

test("poll waits for active 60 seconds and does not replay missed intervals", async () => {
  const f = await fixture();
  await tick();
  f.agent.settle();
  await tick();
  f.at(59_999);
  expect(f.scheduler.poll(world)).toBe(false);
  f.at(60_000);
  expect(f.scheduler.poll(world)).toBe(true);
  await tick();
  expect(f.agent.batches()[1]).toMatchObject({ initial: false, poll: true });
  f.agent.settle();
  await tick();
  f.at(270_000);
  expect(f.scheduler.poll(world)).toBe(true);
  await tick();
  expect(f.scheduler.poll(world)).toBe(false);
  f.agent.settle();
  await tick();
  expect(f.agent.run).toHaveBeenCalledTimes(3);
});

test.each([false, true])(
  "hook settlement clears queued polls and restarts 60 active seconds (paused: %s)",
  async (paused) => {
    const f = await fixture();
    await tick();
    f.agent.settle();
    await tick();
    f.at(59_000);
    await f.bridge.observe(stored(1), [hook("important")]);
    f.at(60_000);
    expect(f.scheduler.poll(world)).toBe(true);
    await tick();
    await f.bridge.message("keep this input");
    if (paused) f.bridge.pause(true);
    f.at(70_000);
    f.agent.settle({ status: "settled", aborted: paused });
    await tick();
    const resumedAt = paused ? 1_000_000 : 70_000;
    f.at(resumedAt);
    if (paused) f.bridge.pause(false);
    await tick();
    expect(f.agent.batches()[2]).toMatchObject({
      poll: false,
      playerMessages: ["keep this input"],
    });
    f.agent.settle();
    await tick();
    f.at(resumedAt + 59_999);
    expect(f.scheduler.poll(world)).toBe(false);
    f.at(resumedAt + 60_000);
    expect(f.scheduler.poll(world)).toBe(true);
    await tick();
    expect(f.agent.batches()[3]).toMatchObject({ poll: true });
    expect(f.faults).toEqual([]);
  },
);

test("busy polling coalesces with all pending player and hook reasons", async () => {
  const f = await fixture();
  await tick();
  f.at(60_000);
  expect(f.scheduler.poll(world)).toBe(true);
  await tick();
  await f.bridge.message("player first");
  await f.bridge.observe(stored(1), [hook("important")]);
  f.at(120_000);
  expect(f.scheduler.poll(world)).toBe(true);
  await tick();
  expect(f.agent.run).toHaveBeenCalledTimes(1);
  f.agent.settle();
  await tick();
  expect(f.agent.batches()[1]).toMatchObject({
    poll: true,
    playerMessages: ["player first"],
    hooks: [{ id: "important", eventIds: [1] }],
  });
  f.agent.settle();
  await tick();
  expect(f.agent.run).toHaveBeenCalledTimes(2);
});

test("paused time is excluded and pending poll waits for occupied settlement on resume", async () => {
  const f = await fixture();
  await tick();
  f.at(25_000);
  f.bridge.pause(true);
  f.at(1_000_000);
  expect(f.scheduler.poll(world)).toBe(false);
  f.bridge.pause(false);
  await tick();
  f.at(1_034_999);
  expect(f.scheduler.poll(world)).toBe(false);
  f.at(1_035_000);
  expect(f.scheduler.poll(world)).toBe(true);
  await tick();
  f.bridge.pause(true);
  f.agent.settle({ status: "settled", aborted: true });
  await tick();
  expect(f.agent.run).toHaveBeenCalledTimes(1);
  f.at(2_000_000);
  f.bridge.pause(false);
  await tick();
  expect(f.agent.batches()[1]).toMatchObject({ poll: true });
});

test("initial pause and duplicate attach do not count paused time or reset active time", async () => {
  const f = await fixture({ paused: true });
  await tick();
  f.at(600_000);
  expect(f.scheduler.poll(world)).toBe(false);
  f.bridge.pause(false);
  await tick();
  f.at(630_000);
  f.bridge.emit("attach", f.bridge.readySession);
  f.at(660_000);
  expect(f.scheduler.poll(world)).toBe(true);
  await tick();
  f.agent.settle();
  await tick();
  expect(f.agent.batches()[1]).toMatchObject({ poll: true });
});

test("replacement resets elapsed and refuses late poll and status from the old binding", async () => {
  const f = await fixture();
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
  await tick();
  f.agents[1]!.settle();
  await tick();
  expect(f.agents[1]!.batches()[1]).toMatchObject({ binding: replacement, poll: true });
});

test("late observation callbacks from a detached native session cannot fault the replacement owner", async () => {
  const f = await fixture();
  await tick();
  f.bridge.detach();
  const replacement = { ...world, sessionId: "replacement" };
  f.bridge.attach(replacement);
  await tick();
  const current = f.agents[1]!;
  current.settle();
  await tick();
  // An already-stored old batch may still be awaiting its next async callback.
  await f.bridge.observe(stored(1), [hook("old-session")]);
  await tick();
  expect(f.faults).toEqual([]);
  expect(current.run).toHaveBeenCalledTimes(1);
  expect(current.close).not.toHaveBeenCalled();
  await f.bridge.message("new session remains live");
  await tick();
  expect(current.batches()[1]).toMatchObject({
    binding: replacement,
    playerMessages: ["new session remains live"],
    hooks: [],
    observations: [],
  });
});

test("player-message admission snapshots its binding before awaiting Durable startup", async () => {
  const f = await fixture({ ready: false });
  const agent = await f.createAgent();
  const startup = f.hold<RunAgent>(agent);
  f.startAgent.mockImplementationOnce(() => startup.promise);
  f.bridge.attach(world, true);
  const binding = { ...world };
  const admission = f.bridge.message("captured input", binding);
  const acknowledged = expect(admission).resolves.toBeUndefined();
  binding.sessionId = "caller-mutated-after-admission";
  startup.resolve(agent);
  await acknowledged;
  expect(f.faults).toEqual([]);
  const persisted = await new RunInbox(agent.conversation, world).take();
  expect(persisted?.batch).toMatchObject({ binding: world, playerMessages: ["captured input"] });
});

test("poll before ready, after fault or after close cannot admit late work", async () => {
  const f = await fixture({ ready: false });
  f.at(60_000);
  expect(f.scheduler.poll(world)).toBe(false);
  f.bridge.attach();
  await tick();
  f.at(120_000);
  expect(f.scheduler.poll(world)).toBe(true);
  await tick();
  f.agent.emit("fault", new Error("failed owner"));
  f.at(180_000);
  expect(f.scheduler.poll(world)).toBe(false);
  await f.scheduler.close();
  expect(f.scheduler.poll(world)).toBe(false);
  expect(f.agent.run).toHaveBeenCalledTimes(1);
});

test("host close preserves admitted pending poll but rejects subsequent timer callbacks", async () => {
  const f = await fixture();
  await tick();
  f.at(60_000);
  expect(f.scheduler.poll(world)).toBe(true);
  await tick();
  const closing = f.scheduler.close();
  f.at(120_000);
  expect(f.scheduler.poll(world)).toBe(false);
  await closing;
  expect(f.agent.run).toHaveBeenCalledTimes(1);
  const inbox = new RunInbox(f.agent.conversation, world);
  const active = await inbox.take();
  expect(active?.batch.initial).toBe(true);
  await inbox.complete(active!.requestId);
  expect((await inbox.take())?.batch).toMatchObject({ initial: false, poll: true });
});

test("invalid monotonic time fails scheduling explicitly and prevents new polls", async () => {
  const f = await fixture();
  await tick();
  f.at(-1);
  expect(f.scheduler.poll(world)).toBe(false);
  expect(f.faults).toEqual([expect.objectContaining({ message: "Invalid monotonic time" })]);
  f.at(60_000);
  expect(f.scheduler.poll(world)).toBe(false);
  expect(f.agent.close).toHaveBeenCalled();
});

test("the in-process run budget preserves admitted quote-heavy messages exactly", async () => {
  const f = await fixture();
  await tick();
  const messages = Array<string>(17).fill('"'.repeat(16_000));
  for (const text of messages) await expect(f.bridge.message(text)).resolves.toBeUndefined();
  f.agent.settle();
  await tick();
  const message = f.agent.run.mock.calls[1]![0];
  expect(f.agent.batches()[1]!.playerMessages).toEqual(messages);
  expect(Buffer.byteLength(message)).toBeLessThanOrEqual(1024 * 1024);
  expect(f.agent.run.mock.calls[1]![2]).toEqual(expect.any(String));
});

test("chat acknowledgment waits for startup and a real Durable inbox commit while paused", async () => {
  const f = await fixture({ ready: false });
  const agent = await f.createAgent();
  const startup = f.hold<RunAgent>(agent);
  f.startAgent.mockImplementationOnce(() => startup.promise);
  f.bridge.attach(world, true);
  const accepted = vi.fn();
  const admission = f.bridge.message("durable before ACK").then(accepted);
  await tick();
  expect(accepted).not.toHaveBeenCalled();
  expect(agent.run).not.toHaveBeenCalled();
  startup.resolve(agent);
  await admission;
  expect(accepted).toHaveBeenCalledOnce();
  expect(agent.run).not.toHaveBeenCalled();
  const persisted = await new RunInbox(agent.conversation, world).take();
  expect(persisted?.batch).toMatchObject({ initial: true, playerMessages: ["durable before ACK"] });
});

test("host close preserves dispatch request ID and duplicate chats for the next scheduler owner", async () => {
  const f = await fixture();
  await tick();
  const firstRequestId = f.agent.run.mock.calls[0]![2];
  await f.bridge.message("same");
  await f.bridge.message("same");
  f.at(60_000);
  expect(f.scheduler.poll(world)).toBe(true);
  await tick();
  await f.scheduler.close();
  expect(f.agent.abort).not.toHaveBeenCalled();
  expect(f.bridge.invalidateRun).toHaveBeenLastCalledWith("runtime_closed");
  const next = { ...world, sessionId: "new-native-session" };
  f.bridge.detach();
  f.bridge.attach(next);
  const reopened = new RunScheduler({
    ...f.options,
    startAgent: async () => f.createAgent(f.agent.conversation),
  });
  try {
    await tick();
    const nextAgent = f.agents[1]!;
    expect(nextAgent.batches()[0]).toMatchObject({ binding: next, initial: true });
    expect(nextAgent.run.mock.calls[0]![2]).toBe(firstRequestId);
    nextAgent.settle();
    await tick();
    expect(nextAgent.batches()[1]).toMatchObject({
      binding: next,
      poll: true,
      playerMessages: ["same", "same"],
    });
    expect(nextAgent.run.mock.calls[1]![2]).not.toBe(firstRequestId);
  } finally {
    await reopened.close();
  }
});

test("explicit native detach aborts the owner and clears both durable dispatch and pending input", async () => {
  const f = await fixture();
  await tick();
  await f.bridge.message("withdrawn pending");
  f.bridge.detach();
  await tick();
  expect(f.agent.abort).toHaveBeenCalledOnce();
  expect(f.agent.close).toHaveBeenCalled();
  expect(f.bridge.invalidateRun).toHaveBeenLastCalledWith("game_detached");
  expect(await new RunInbox(f.agent.conversation, world).take()).toBeUndefined();
  expect(f.faults).toEqual([]);
});

test("summary awaits owner startup and remains independent of paused main admission", async () => {
  const f = await fixture({ ready: false });
  const agent = await f.createAgent();
  const startup = f.hold<RunAgent>(agent);
  f.startAgent.mockImplementationOnce(() => startup.promise);
  f.bridge.attach(world, true);
  const controller = new AbortController();
  const summary = f.scheduler.summarize(world, "observations", controller.signal);
  await tick();
  expect(agent.summarize).not.toHaveBeenCalled();
  startup.resolve(agent);
  await expect(summary).resolves.toBe("independent summary");
  expect(agent.summarize).toHaveBeenCalledExactlyOnceWith("observations", controller.signal);
  expect(agent.run).not.toHaveBeenCalled();
  await expect(
    f.scheduler.summarize({ ...world, sessionId: "stale" }, "late", controller.signal),
  ).rejects.toThrow(/not available/);
});

test("summary canceled during startup never reaches the model owner", async () => {
  const f = await fixture({ ready: false });
  const agent = await f.createAgent();
  const startup = f.hold<RunAgent>(agent);
  f.startAgent.mockImplementationOnce(() => startup.promise);
  f.bridge.attach(world, true);
  const controller = new AbortController();
  const summary = f.scheduler.summarize(world, "observations", controller.signal);
  const rejected = expect(summary).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  startup.resolve(agent);
  await rejected;
  expect(agent.summarize).not.toHaveBeenCalled();
  expect(f.faults).toEqual([]);
});

test.each([false, true])(
  "SQLite request reasons commit before main dispatch or prevent it on failure: %s",
  async (fails) => {
    const f = await fixture({ ready: false });
    const database = new DatabaseSync(":memory:");
    initializeActivityDatabase(database);
    const activities = new ActivityLog(database);
    if (fails)
      database.exec(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT,'audit failed'); END",
      );
    const order: string[] = [];
    const agent = await f.createAgent();
    const invoke = agent.run.getMockImplementation()!;
    agent.run.mockImplementation((...args) => {
      order.push("run");
      return invoke(...args);
    });
    f.startAgent.mockResolvedValueOnce(agent);
    f.bridge.on("runRequested", (batch: RunRequest) => {
      activities.appendActivities(runRequestActivities(batch, 100, "request"));
      order.push("activity log");
    });
    try {
      f.bridge.attach();
      await tick();
      expect(order).toEqual(fails ? [] : ["activity log", "run"]);
      expect(f.faults).toHaveLength(fails ? 1 : 0);
      if (fails) {
        expect(f.faults[0]?.message).toContain("audit failed");
        expect(agent.run).not.toHaveBeenCalled();
      }
      const facts = activities.search({ worldId: world.worldId, playerId: world.playerId }).events;
      expect(facts.map(({ activity }) => activity.event)).toEqual(
        fails ? [] : ["hisyo.run_requested_initial"],
      );
    } finally {
      await f.scheduler.close();
      database.close();
    }
  },
);
