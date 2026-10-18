import { expect, test } from "vite-plus/test";
import observations from "../protocol/fixtures/observerEvents.json" with { type: "json" };
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import { summaryInputBytes } from "../protocol/history.js";
import { EventCatalog } from "./eventCatalog.js";
import { compactHistory } from "./compactHistory.js";
import type { StoredEvent } from "./eventLog.js";

const catalog: EventCatalog = new EventCatalog(gameEventDefinitions);
function row(
  id: number,
  event = "block_broken",
  changes: Record<string, unknown> = {},
): StoredEvent {
  const template = observations.find((observation) => observation.event === event)!;
  const observation = { ...template, seq: id, observedAt: id * 1000, ...changes };
  catalog.validateObservation(observation);
  return { id, observation };
}

test("renders every real observer fixture as bounded non-JSON source text", () => {
  for (const observation of observations) {
    const source = compactHistory(0, [row(1, observation.event)])!;
    expect(source.sourceCount).toBe(1);
    expect(source.through).toBe(1);
    expect(Buffer.byteLength(source.input)).toBeLessThanOrEqual(summaryInputBytes);
    expect(source.input).not.toContain('"worldId"');
    if (observation.event === "structures_sampled") expect(source.input).toContain("not discovery");
  }
});

test("preserves health transition order, interaction locations and meaningful equipment slots", () => {
  const source = compactHistory(0, [
    row(1, "health_changed", { data: { before: 20, after: 18 } }),
    row(2, "health_changed", { data: { before: 18, after: 20 } }),
    row(3, "health_changed", { data: { before: 20, after: 18 } }),
    row(4, "block_broken", { position: [99, 64, 1] }),
    row(5, "equipment_slot_changed"),
  ])!;
  expect(source.input.indexOf("e1 health_changed")).toBeLessThan(
    source.input.indexOf("e2 health_changed"),
  );
  expect(source.input.indexOf("e2 health_changed")).toBeLessThan(
    source.input.indexOf("e3 health_changed"),
  );
  expect(source.input).toContain("@minecraft:overworld:99,64,1");
  expect(source.input).toContain("slot=");
});

test("a realistic active minute with full nearby samples and walking fits one compact call", () => {
  const entries: StoredEvent[] = [];
  for (let second = 0; second < 60; second++) {
    const nearby = row(entries.length + 1, "nearby_sampled");
    nearby.observation.data = {
      ...nearby.observation.data,
      visibility: "unobstructed",
      blocks: Array.from({ length: 729 }, (_, i) => ({
        blockId: "minecraft:stone",
        position: [second + (i % 9) - 4, 64 + (Math.floor(i / 9) % 9) - 4, Math.floor(i / 81) - 4],
      })),
    };
    entries.push(nearby);
    entries.push(
      row(entries.length + 1, "player_location_changed", {
        data: {
          beforePosition: [second, 64, 0],
          afterPosition: [second + 1, 64, 0],
          beforeBiomeId: "minecraft:plains",
          afterBiomeId: "minecraft:plains",
          sampleIntervalTicks: 20,
          minimumDistance: 1,
          elapsedTicks: 20,
        },
      }),
    );
    entries.push(row(entries.length + 1, "structures_sampled"));
    entries.push(row(entries.length + 1, "status_effects_sampled"));
    entries.push(row(entries.length + 1, "block_broken", { position: [second, 64, 0] }));
  }
  const source = compactHistory(0, entries)!;
  expect(source.sourceCount).toBe(300);
  expect(source.through).toBe(300);
  expect(source.input).toContain("first sampled position=0,64,0");
  expect(source.input).toContain("59,64,0 -> 60,64,0");
  expect(source.input).toContain("60 samples");
  expect(Buffer.byteLength(source.input)).toBeLessThanOrEqual(summaryInputBytes);
});

test("consumes only a bounded whole-row prefix of one session, including gap provenance", () => {
  const first = row(4);
  first.missingSequencesBefore = { from: 2, to: 3 };
  const source = compactHistory(3, [
    first,
    row(5),
    row(9, "block_broken", { worldSessionId: "new-session" }),
  ])!;
  expect(source).toMatchObject({ after: 3, through: 5, sourceCount: 2 });
  expect(source.input).toContain("missing seq 2..3");
  expect(source.input).not.toContain("new-session");
  const large = Array.from({ length: 500 }, (_, i) =>
    row(i + 1, "block_broken", { position: [i, 64, 0] }),
  );
  const bounded = compactHistory(0, large)!;
  expect(bounded.sourceCount).toBeLessThan(500);
  expect(bounded.through).toBe(bounded.sourceCount);
  expect(Buffer.byteLength(bounded.input)).toBeLessThanOrEqual(summaryInputBytes);
});

test("refuses CLI activity rather than projecting speech into game memory", () => {
  const record = {
    id: 1,
    observation: {
      worldId: "w",
      playerId: "p",
      worldSessionId: "s",
      observedAt: 1,
      origin: "cli",
      event: "director.player_input",
      data: { text: "CLI_ONLY_SENTINEL" },
    },
  } as unknown as StoredEvent;
  expect(() => compactHistory(0, [record])).toThrow(/Mod observations/);
});

test("timestamp range uses all included rows, not arrival order", () => {
  const source = compactHistory(0, [
    row(1, "health_changed", { observedAt: 1000 }),
    row(2, "food_changed", { observedAt: 5000 }),
    row(3, "health_changed", { observedAt: 900 }),
  ])!;
  expect(source).toMatchObject({ firstObservedAt: 900, lastObservedAt: 5000 });
  expect(source.input).toContain("900..5000");
});
