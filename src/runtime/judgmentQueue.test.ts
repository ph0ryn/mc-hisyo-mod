import { expect, onTestFinished, test } from "vite-plus/test";
import { EventCatalog } from "../events/eventCatalog.js";
import { EventLog } from "../events/eventLog.js";
import { ResponseHooks } from "../hooks/responseHooks.js";
import type { WorldBinding } from "../protocol/bridge.js";
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import { openDatabase } from "../storage/database.js";
import { JudgmentQueue, JudgmentQueueFullError } from "./judgmentQueue.js";

const scope = { worldId: "world-a", playerId: "player-a" };
const world: WorldBinding = { ...scope, worldSessionId: "session-a" };

function fixture(maxBytes?: number) {
  const db = openDatabase(":memory:");
  onTestFinished(() => db.close());
  const catalog = new EventCatalog(gameEventDefinitions);
  const eventLog = new EventLog(db, catalog);
  const hooks = new ResponseHooks(db, catalog);
  const queue = new JudgmentQueue(world, maxBytes);
  let seq = 0;
  function observe(blockId = "minecraft:stone", advance = 1) {
    seq += advance;
    const stored = eventLog.append({
      ...world,
      seq,
      tick: seq,
      observedAt: 1000 + seq,
      event: "block_broken",
      dimension: "minecraft:overworld",
      position: [0, 64, 0],
      data: { blockId, position: [1, 64, 0] },
    });
    const matched = hooks.match(stored.observation);
    queue.enqueueObservation(stored, matched);
    return { stored, matched };
  }
  return { queue, hooks, eventLog, observe };
}

test("ordinary observations persist without reserving a judgment", () => {
  const f = fixture();
  expect(f.queue.take()).toBeUndefined();
  const { stored } = f.observe();
  expect(f.queue.take()).toBeUndefined();
  expect(f.eventLog.search(scope).events).toEqual([stored]);
});

test("coalesces start and poll but retains every chat in arrival order", () => {
  const { queue } = fixture();
  for (let index = 0; index < 50; index++) {
    queue.enqueueStart();
    queue.enqueuePoll();
  }
  queue.enqueueMessage(world, "first");
  queue.enqueueMessage(world, "same");
  queue.enqueueMessage(world, "same");
  expect(queue.take()).toEqual({
    binding: world,
    worldStart: true,
    poll: true,
    playerMessages: ["first", "same", "same"],
    hooks: [],
    observations: [],
  });
  expect(queue.take()).toBeUndefined();
  queue.enqueuePoll();
  expect(queue.take()).toMatchObject({ worldStart: false, poll: true, playerMessages: [] });
});

test("captures removed hook instructions and never retrofires later registrations", () => {
  const f = fixture();
  const old = f.hooks.add(scope, {
    event: "block_broken",
    instruction: "instruction at firing",
  });
  const first = f.observe();
  first.matched[0]!.instruction = "mutated after admission";
  first.stored.observation.data.blockId = "minecraft:air";
  expect(f.hooks.remove(scope, old.id)).toBe(true);
  const next = f.hooks.add(scope, { event: "block_broken", instruction: "new instruction" });
  const second = f.observe();
  f.hooks.add(scope, { event: "block_broken", instruction: "registered after both events" });
  const batch = f.queue.take()!;
  expect(batch.hooks).toEqual([
    { id: old.id, event: old.event, instruction: old.instruction, eventIds: [first.stored.id] },
    { id: next.id, event: next.event, instruction: next.instruction, eventIds: [second.stored.id] },
  ]);
  expect(batch.observations.map(({ observation }) => observation.data.blockId)).toEqual([
    "minecraft:stone",
    "minecraft:stone",
  ]);
});

test("coalesces sparse hook fires with exact event IDs and no fabricated missing events", () => {
  const f = fixture();
  const hook = f.hooks.add(scope, {
    event: "block_broken",
    filter: { blockId: "minecraft:stone" },
    instruction: "check stone",
  });
  const first = f.observe();
  f.observe("minecraft:oak_log");
  const third = f.observe("minecraft:stone", 2);
  const fourth = f.observe();
  const batch = f.queue.take()!;
  expect(batch.hooks).toEqual([
    {
      id: hook.id,
      event: hook.event,
      instruction: hook.instruction,
      eventIds: [first.stored.id, third.stored.id, fourth.stored.id],
    },
  ]);
  expect(batch.observations).toEqual([first.stored, third.stored, fourth.stored]);
  expect(batch.observations[1]!.missingSequencesBefore).toEqual({ from: 3, to: 3 });
  expect(f.eventLog.search(scope).events).toHaveLength(4);
});

test("two matching hooks share one captured observation payload", () => {
  const f = fixture();
  f.hooks.add(scope, { event: "block_broken", instruction: "one" });
  f.hooks.add(scope, { event: "block_broken", instruction: "two" });
  const { stored } = f.observe();
  const batch = f.queue.take()!;
  expect(batch.observations).toEqual([stored]);
  expect(batch.hooks.map((hook) => hook.eventIds)).toEqual([[stored.id], [stored.id]]);
});

test("taken batches do not absorb later arrivals or mutate the next batch", () => {
  const f = fixture();
  f.hooks.add(scope, { event: "block_broken", instruction: "check" });
  f.queue.enqueueMessage(world, "old");
  const first = f.observe();
  const active = f.queue.take()!;
  f.queue.enqueueMessage(world, "new");
  const second = f.observe();
  expect(active.playerMessages).toEqual(["old"]);
  expect(active.hooks[0]!.eventIds).toEqual([first.stored.id]);
  (active.binding as { worldId: string }).worldId = "changed by consumer";
  active.hooks[0]!.instruction = "changed by consumer";
  active.observations[0]!.observation.data.blockId = "minecraft:air";
  expect(f.queue.take()).toMatchObject({
    binding: world,
    playerMessages: ["new"],
    hooks: [{ instruction: "check", eventIds: [second.stored.id] }],
    observations: [second.stored],
  });
  expect(f.queue.take()).toBeUndefined();
});

test("snapshots the caller's world and rejects stale session or scope inputs", () => {
  const caller = { ...world };
  const queue = new JudgmentQueue(caller);
  caller.worldId = "changed during startup";
  for (const binding of [
    { ...world, worldId: "other-world" },
    { ...world, playerId: "other-player" },
    { ...world, worldSessionId: "new-session" },
  ]) {
    expect(() => queue.enqueueMessage(binding, "not this world")).toThrow("binding");
  }
  const f = fixture();
  const { stored } = f.observe();
  stored.observation.worldSessionId = "stale";
  expect(() => queue.enqueueObservation(stored, [])).toThrow("binding");
  queue.enqueueMessage(world, "current");
  expect(queue.take()).toMatchObject({ binding: world, playerMessages: ["current"] });
});

test("counts actual UTF-8 JSON bytes and latches overload instead of evicting", () => {
  const text = '日本語\\"\n';
  const probe = new JudgmentQueue(world);
  probe.enqueueMessage(world, text);
  const bytes = Buffer.byteLength(JSON.stringify(probe.take()), "utf8");
  const exact = new JudgmentQueue(world, bytes);
  exact.enqueueMessage(world, text);
  expect(exact.take()!.playerMessages).toEqual([text]);
  const short = new JudgmentQueue(world, bytes - 1);
  expect(() => short.enqueueMessage(world, text)).toThrow(JudgmentQueueFullError);
  const queue = new JudgmentQueue(world, bytes - 1);
  queue.enqueueMessage(world, "accepted");
  let failure: unknown;
  try {
    queue.enqueueMessage(world, text);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(JudgmentQueueFullError);
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

test("one oversized matched batch stops admission while raw history remains available", () => {
  const f = fixture(1024);
  for (let index = 0; index < 8; index++) {
    f.hooks.add(scope, { event: "block_broken", instruction: `${index}:${"x".repeat(300)}` });
  }
  expect(() => f.observe()).toThrow(JudgmentQueueFullError);
  expect(f.eventLog.search(scope).events).toHaveLength(1);
  expect(() => f.queue.take()).toThrow(JudgmentQueueFullError);
  expect(() => f.queue.enqueueObservation(f.eventLog.search(scope).events[0]!, [])).toThrow(
    JudgmentQueueFullError,
  );
});

test("repeated fires of one hook cannot bypass the pending byte budget", () => {
  const probe = fixture();
  probe.hooks.add(scope, { event: "block_broken", instruction: "check" });
  probe.observe();
  const bytes = Buffer.byteLength(JSON.stringify(probe.queue.take()), "utf8");
  const f = fixture(bytes);
  f.hooks.add(scope, { event: "block_broken", instruction: "check" });
  f.observe();
  expect(() => f.observe()).toThrow(JudgmentQueueFullError);
  expect(f.eventLog.search(scope).events).toHaveLength(2);
  expect(() => f.queue.take()).toThrow(JudgmentQueueFullError);
});

test("raw captured payload bytes count, not just the number of hook groups", () => {
  const f = fixture(512);
  f.hooks.add(scope, { event: "block_broken", instruction: "tiny" });
  expect(() => f.observe("minecraft:" + "x".repeat(100))).toThrow(JudgmentQueueFullError);
  expect(f.eventLog.search(scope).events).toHaveLength(1);
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid queue byte budget %s",
  (budget) => {
    expect(() => new JudgmentQueue(world, budget)).toThrow("budget");
  },
);
