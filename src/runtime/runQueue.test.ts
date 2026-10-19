import { expect, test } from "vite-plus/test";
import type { StoredEvent } from "../storage/eventLog.js";
import type { Hook } from "../storage/hookStore.js";
import type { SessionBinding } from "../protocol/bridge.js";
import { RunQueue, RunQueueFullError } from "./runQueue.js";

const world: SessionBinding = {
  worldId: "world-a",
  playerId: "player-a",
  sessionId: "session-a",
};

function stored(id: number, blockId = "minecraft:stone"): StoredEvent {
  return {
    id,
    observation: {
      ...world,
      seq: id,
      tick: id,
      observedAt: 1000 + id,
      event: "block_broken",
      dimension: "minecraft:overworld",
      position: [0, 64, 0],
      data: { blockId, position: [1, 64, 0] },
    },
  };
}

function hook(id: string, instruction = "check"): Hook {
  return { id, event: "block_broken", filter: {}, instruction };
}

test("observations without supplied hook matches do not reserve a run", () => {
  const queue = new RunQueue(world);
  expect(queue.take()).toBeUndefined();
  queue.enqueueObservation(stored(1), []);
  expect(queue.take()).toBeUndefined();
});

test("unhooked advancement notifications retain payloads within the same byte budget", () => {
  const completed = stored(1);
  completed.observation.event = "advancement_completed";
  completed.observation.data = {
    advancementId: "minecraft:story/mine_stone",
    criterion: "get_cobblestone",
    afterDone: true,
    hasDisplay: true,
  };
  const probe = new RunQueue(world);
  probe.enqueueObservation(completed, []);
  const batch = probe.take();
  expect(batch).toMatchObject({ hooks: [], observations: [completed] });
  const bytes = Buffer.byteLength(JSON.stringify(batch), "utf8");
  const queue = new RunQueue(world, bytes);
  queue.enqueueObservation(completed, []);
  completed.observation.data.advancementId = "mutated";
  expect(queue.take()).toEqual(batch);
  const short = new RunQueue(world, bytes - 1);
  expect(() => short.enqueueObservation(batch!.observations[0]!, [])).toThrow(RunQueueFullError);
  expect(() => short.take()).toThrow(RunQueueFullError);
});

test("coalesces start and poll but retains every chat in arrival order", () => {
  const queue = new RunQueue(world);
  for (let index = 0; index < 50; index++) {
    queue.enqueueStart();
    queue.enqueuePoll();
  }
  queue.enqueueMessage(world, "first");
  queue.enqueueMessage(world, "same");
  queue.enqueueMessage(world, "same");
  expect(queue.take()).toEqual({
    binding: world,
    initial: true,
    poll: true,
    playerMessages: ["first", "same", "same"],
    hooks: [],
    observations: [],
  });
  expect(queue.take()).toBeUndefined();
  queue.enqueuePoll();
  expect(queue.take()).toMatchObject({ initial: false, poll: true, playerMessages: [] });
});

test("snapshots supplied hook instructions and observations at admission", () => {
  const queue = new RunQueue(world);
  const old = hook("old", "instruction at firing");
  const first = stored(1);
  queue.enqueueObservation(first, [old]);
  old.instruction = "mutated after admission";
  first.observation.data.blockId = "minecraft:air";
  const next = hook("next", "new instruction");
  const second = stored(2);
  queue.enqueueObservation(second, [next]);
  const batch = queue.take()!;
  expect(batch.hooks).toEqual([
    { id: old.id, event: old.event, instruction: "instruction at firing", eventIds: [first.id] },
    { id: next.id, event: next.event, instruction: next.instruction, eventIds: [second.id] },
  ]);
  expect(batch.observations.map(({ observation }) => observation.data.blockId)).toEqual([
    "minecraft:stone",
    "minecraft:stone",
  ]);
});

test("coalesces supplied sparse hook fires without fabricating missing events", () => {
  const queue = new RunQueue(world);
  const matched = hook("stone", "check stone");
  const first = stored(1);
  const third = { ...stored(4), missingSequencesBefore: { from: 3, to: 3 } };
  const fourth = stored(5);
  queue.enqueueObservation(first, [matched]);
  queue.enqueueObservation(stored(2, "minecraft:oak_log"), []);
  queue.enqueueObservation(third, [matched]);
  queue.enqueueObservation(fourth, [matched]);
  const batch = queue.take()!;
  expect(batch.hooks).toEqual([
    {
      id: matched.id,
      event: matched.event,
      instruction: matched.instruction,
      eventIds: [first.id, third.id, fourth.id],
    },
  ]);
  expect(batch.observations).toEqual([first, third, fourth]);
});

test("two supplied hooks share one captured observation payload", () => {
  const queue = new RunQueue(world);
  const observation = stored(1);
  queue.enqueueObservation(observation, [hook("one"), hook("two")]);
  const batch = queue.take()!;
  expect(batch.observations).toEqual([observation]);
  expect(batch.hooks.map((entry) => entry.eventIds)).toEqual([[observation.id], [observation.id]]);
});

test("taken batches do not absorb later arrivals or mutate the next batch", () => {
  const queue = new RunQueue(world);
  const matched = hook("one");
  queue.enqueueMessage(world, "old");
  const first = stored(1);
  queue.enqueueObservation(first, [matched]);
  const active = queue.take()!;
  queue.enqueueMessage(world, "new");
  const second = stored(2);
  queue.enqueueObservation(second, [matched]);
  expect(active.playerMessages).toEqual(["old"]);
  expect(active.hooks[0]!.eventIds).toEqual([first.id]);
  Object.assign(active.binding, { worldId: "changed by consumer" });
  active.hooks[0]!.instruction = "changed by consumer";
  active.observations[0]!.observation.data.blockId = "minecraft:air";
  expect(queue.take()).toMatchObject({
    binding: world,
    playerMessages: ["new"],
    hooks: [{ instruction: "check", eventIds: [second.id] }],
    observations: [second],
  });
  expect(queue.take()).toBeUndefined();
});

test("snapshots the caller's world and rejects stale session or scope inputs", () => {
  const caller = { ...world };
  const queue = new RunQueue(caller);
  caller.worldId = "changed during startup";
  for (const binding of [
    { ...world, worldId: "other-world" },
    { ...world, playerId: "other-player" },
    { ...world, sessionId: "new-session" },
  ]) {
    expect(() => queue.enqueueMessage(binding, "not this world")).toThrow("binding");
  }
  const observation = stored(1);
  observation.observation.sessionId = "stale";
  expect(() => queue.enqueueObservation(observation, [])).toThrow("binding");
  queue.enqueueMessage(world, "current");
  expect(queue.take()).toMatchObject({ binding: world, playerMessages: ["current"] });
});

test("counts actual UTF-8 JSON bytes and latches overload instead of evicting", () => {
  const text = '日本語\\"\n';
  const probe = new RunQueue(world);
  probe.enqueueMessage(world, text);
  const bytes = Buffer.byteLength(JSON.stringify(probe.take()), "utf8");
  const exact = new RunQueue(world, bytes);
  exact.enqueueMessage(world, text);
  expect(exact.take()!.playerMessages).toEqual([text]);
  const short = new RunQueue(world, bytes - 1);
  expect(() => short.enqueueMessage(world, text)).toThrow(RunQueueFullError);
  const queue = new RunQueue(world, bytes - 1);
  queue.enqueueMessage(world, "accepted");
  let failure: unknown;
  try {
    queue.enqueueMessage(world, text);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(RunQueueFullError);
  expect(String(failure)).not.toContain(text);
  for (const retry of [
    () => queue.take(),
    () => queue.enqueuePoll(),
    () => queue.enqueueStart(),
    () => queue.enqueueMessage(world, "later"),
  ]) {
    expect(retry).toThrow(failure as Error);
  }
});

test("one oversized supplied batch stops admission", () => {
  const queue = new RunQueue(world, 1024);
  const hooks = Array.from({ length: 8 }, (_, index) =>
    hook(String(index), `${index}:${"x".repeat(300)}`),
  );
  expect(() => queue.enqueueObservation(stored(1), hooks)).toThrow(RunQueueFullError);
  expect(() => queue.take()).toThrow(RunQueueFullError);
  expect(() => queue.enqueueObservation(stored(2), [])).toThrow(RunQueueFullError);
});

test("repeated supplied fires of one hook cannot bypass the pending byte budget", () => {
  const matched = hook("one");
  const probe = new RunQueue(world);
  probe.enqueueObservation(stored(1), [matched]);
  const bytes = Buffer.byteLength(JSON.stringify(probe.take()), "utf8");
  const queue = new RunQueue(world, bytes);
  queue.enqueueObservation(stored(1), [matched]);
  expect(() => queue.enqueueObservation(stored(2), [matched])).toThrow(RunQueueFullError);
  expect(() => queue.take()).toThrow(RunQueueFullError);
});

test("raw captured payload bytes count, not just the number of hook groups", () => {
  const queue = new RunQueue(world, 512);
  expect(() =>
    queue.enqueueObservation(stored(1, "minecraft:" + "x".repeat(100)), [hook("one", "tiny")]),
  ).toThrow(RunQueueFullError);
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid queue byte budget %s",
  (budget) => {
    expect(() => new RunQueue(world, budget)).toThrow("budget");
  },
);
