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

const stackChange = {
  beforeItemId: "minecraft:air",
  beforeCount: 0,
  afterItemId: "minecraft:stone",
  afterCount: 3,
};

function stackRow(
  id: number,
  event: string,
  data: Record<string, unknown>,
  changes: Record<string, unknown> = {},
): StoredEvent {
  return row(id, event, {
    tick: 200,
    observedAt: 2000,
    data: { ...stackChange, ...data },
    ...changes,
  });
}

test("renders one equipped inventory transition for matching container, equipment and hand mirrors", () => {
  const source = compactHistory(0, [
    stackRow(
      1,
      "container_slot_changed",
      {
        menuId: 1,
        containerId: 2,
        slot: 9,
        containerSlot: 40,
        playerInventory: true,
      },
      { observedAt: 1900, position: [3, 65, 0] },
    ),
    stackRow(2, "inventory_slot_changed", { slot: 40 }),
    row(3, "health_changed", { tick: 200, observedAt: 2000 }),
    stackRow(4, "equipment_slot_changed", { slot: "offHand" }),
    stackRow(5, "held_item_changed", { hand: "off_hand", beforeSlot: null, afterSlot: null }),
  ])!;
  expect(source).toMatchObject({
    through: 5,
    sourceCount: 5,
    firstObservedAt: 1900,
    lastObservedAt: 2000,
  });
  expect(source.input).toContain("inventory_slot_changed");
  expect(source.input).toContain("equipped=offHand");
  expect(source.input.match(/afterItemId=minecraft:stone/gu)).toHaveLength(1);
  expect(source.input).not.toContain("container_slot_changed");
  expect(source.input).not.toContain("equipment_slot_changed");
  expect(source.input).not.toContain("held_item_changed");
  expect(source.input).toContain("health_changed");
});

test.each([
  ["feet", 36],
  ["legs", 37],
  ["chest", 38],
  ["head", 39],
  ["offHand", 40],
  ["body", 41],
  ["saddle", 42],
])("keeps the %s equipment meaning on physical inventory slot %i", (equipment, slot) => {
  const source = compactHistory(0, [
    stackRow(1, "inventory_slot_changed", { slot }),
    stackRow(2, "equipment_slot_changed", { slot: equipment }),
  ])!;
  expect(source.input).toContain(`equipped=${equipment}`);
  expect(source.input).not.toContain("equipment_slot_changed");
  expect(source.sourceCount).toBe(2);
});

test("coalesces stable main-hand mirrors but preserves every hotbar selection change", () => {
  const source = compactHistory(0, [
    stackRow(1, "inventory_slot_changed", { slot: 3 }),
    stackRow(2, "held_item_changed", { hand: "main_hand", beforeSlot: 3, afterSlot: 3 }),
    stackRow(3, "held_item_changed", { hand: "main_hand", beforeSlot: 3, afterSlot: 4 }),
    stackRow(4, "held_item_changed", {
      hand: "main_hand",
      beforeSlot: 4,
      afterSlot: 5,
      beforeItemId: "minecraft:stone",
      beforeCount: 3,
    }),
  ])!;
  expect(source.input).toContain("equipped=mainHand");
  expect(source.input.match(/held_item_changed/gu)).toHaveLength(2);
  expect(source.input).toContain("beforeSlot=3 afterSlot=4");
  expect(source.input).toContain("beforeSlot=4 afterSlot=5");
});

test.each([
  { tick: 201 },
  { observedAt: 2001 },
  { dimension: "minecraft:the_nether" },
  { worldId: "other-world" },
  { playerId: "other-player" },
  { data: { beforeItemId: "minecraft:dirt" } },
  { data: { beforeCount: 1 } },
  { data: { afterItemId: "minecraft:dirt" } },
  { data: { afterCount: 4 } },
])("does not merge a different hand snapshot or transition: %j", ({ data = {}, ...changes }) => {
  const source = compactHistory(0, [
    stackRow(1, "inventory_slot_changed", { slot: 40 }),
    stackRow(
      2,
      "held_item_changed",
      {
        hand: "off_hand",
        beforeSlot: null,
        afterSlot: null,
        ...data,
      },
      changes,
    ),
  ])!;
  expect(source.input).toContain("held_item_changed");
});

test("only pairs the nearest preceding container transition once, preserving cycles and later mutations", () => {
  const container = { menuId: 1, containerId: 2, slot: 9, containerSlot: 3, playerInventory: true };
  const source = compactHistory(0, [
    stackRow(1, "container_slot_changed", container),
    stackRow(2, "container_slot_changed", {
      ...container,
      beforeItemId: "minecraft:stone",
      beforeCount: 3,
      afterItemId: "minecraft:air",
      afterCount: 0,
    }),
    stackRow(3, "container_slot_changed", container),
    stackRow(4, "inventory_slot_changed", { slot: 3 }),
    stackRow(5, "container_slot_changed", container, { observedAt: 2100 }),
  ])!;
  expect(source.input.match(/container_slot_changed/gu)).toHaveLength(3);
  expect(source.input).toContain("e1 container_slot_changed");
  expect(source.input).toContain("e2 container_slot_changed");
  expect(source.input).not.toContain("e3 container_slot_changed");
  expect(source.input).toContain("e4 inventory_slot_changed");
  expect(source.input).toContain("e5 container_slot_changed");
  expect(source).toMatchObject({ through: 5, sourceCount: 5 });
});

test("never confuses non-player crafting slots or menu indices with physical inventory slots", () => {
  const source = compactHistory(0, [
    stackRow(1, "container_slot_changed", {
      menuId: 1,
      containerId: 2,
      slot: 0,
      containerSlot: 40,
      playerInventory: false,
    }),
    stackRow(2, "container_slot_changed", {
      menuId: 1,
      containerId: 2,
      slot: 40,
      containerSlot: 7,
      playerInventory: true,
    }),
    stackRow(3, "inventory_slot_changed", { slot: 40 }),
  ])!;
  expect(source.input.match(/container_slot_changed/gu)).toHaveLength(2);
});

test("retains gap provenance even when its container representation is coalesced", () => {
  const container = stackRow(3, "container_slot_changed", {
    menuId: 1,
    containerId: 2,
    slot: 9,
    containerSlot: 3,
    playerInventory: true,
  });
  container.missingSequencesBefore = { from: 1, to: 2 };
  const source = compactHistory(0, [
    container,
    stackRow(4, "inventory_slot_changed", { slot: 3 }),
  ])!;
  expect(source.input).toContain("e3: missing seq 1..2");
  expect(source.input).not.toContain("container_slot_changed");
  expect(source).toMatchObject({ through: 4, sourceCount: 2 });
});

test("does not coalesce across missing observations or menu lifecycle boundaries", () => {
  const container = stackRow(1, "container_slot_changed", {
    menuId: 1,
    containerId: 2,
    slot: 9,
    containerSlot: 3,
    playerInventory: true,
  });
  const inventory = stackRow(3, "inventory_slot_changed", { slot: 3 });
  inventory.missingSequencesBefore = { from: 2, to: 2 };
  expect(compactHistory(0, [container, inventory])!.input).toContain("container_slot_changed");
  expect(
    compactHistory(0, [
      container,
      row(2, "container_closed", { tick: 200, observedAt: 2000 }),
      stackRow(3, "inventory_slot_changed", { slot: 3 }),
    ])!.input,
  ).toContain("container_slot_changed");
});

test.each(["grid_result_taken", "furnace_result_taken"])(
  "totals real %s credits instead of treating repeated takes as duplicates",
  (event) => {
    const template = observations.find((observation) => observation.event === event)!;
    const source = compactHistory(
      0,
      [1, 2, 3].map((id) =>
        row(id, event, {
          data: { ...template.data, count: 4 },
        }),
      ),
    )!;
    expect(source.input).toContain("totalTaken=12");
    expect(source.input).toContain("creditedTakeEvents=3");
    expect(source.input).not.toContain("identical observations");
    expect(source).toMatchObject({ through: 3, sourceCount: 3 });
  },
);

test("keeps partial-snapshot hand evidence when no matching inventory row is included", () => {
  const source = compactHistory(0, [
    stackRow(1, "held_item_changed", { hand: "off_hand", beforeSlot: null, afterSlot: null }),
  ])!;
  expect(source.input).toContain("held_item_changed");
});

test("keeps named equipment as the representative when its inventory counterpart is outside the prefix", () => {
  const source = compactHistory(0, [
    stackRow(1, "equipment_slot_changed", { slot: "offHand" }),
    stackRow(2, "held_item_changed", { hand: "off_hand", beforeSlot: null, afterSlot: null }),
  ])!;
  expect(source.input).toContain("equipment_slot_changed");
  expect(source.input).toContain("slot=offHand");
  expect(source.input).not.toContain("held_item_changed");
  expect(source).toMatchObject({ through: 2, sourceCount: 2 });
});

test("does not aggregate result credits across a gap on an intervening sample", () => {
  const sample = row(2, "nearby_sampled", { seq: 3 });
  sample.missingSequencesBefore = { from: 2, to: 2 };
  const source = compactHistory(0, [
    row(1, "grid_result_taken"),
    sample,
    row(3, "grid_result_taken", { seq: 4 }),
  ])!;
  expect(source.input).toContain("e2: missing seq 2..2");
  expect(source.input.match(/grid_result_taken/gu)).toHaveLength(2);
  expect(source.input).not.toContain("totalTaken=");
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
