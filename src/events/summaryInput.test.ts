import { expect, test } from "vite-plus/test";
import observations from "../protocol/fixtures/gameEvents.json" with { type: "json" };
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import { summaryInputBytes } from "../protocol/summary.js";
import { EventCatalog } from "./eventCatalog.js";
import { prepareSummaryInput } from "./summaryInput.js";
import type { StoredEvent } from "../storage/eventLog.js";

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

test("renders every real Mod observation fixture as bounded non-JSON source text", () => {
  for (const observation of observations) {
    const source = prepareSummaryInput(0, [row(1, observation.event)])!;
    expect(source.sourceCount).toBe(1);
    expect(source.through).toBe(1);
    expect(Buffer.byteLength(source.input)).toBeLessThanOrEqual(summaryInputBytes);
    expect(source.input).not.toContain('"worldId"');
    if (observation.event === "structures_sampled")
      expect(source.input).toContain("No retained observations.");
  }
});

test("preserves health transition order, interaction locations and meaningful equipment slots", () => {
  const source = prepareSummaryInput(0, [
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
  expect(source.input).toContain("@overworld:99,64,1");
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
  const source = prepareSummaryInput(0, entries)!;
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
  const source = prepareSummaryInput(3, [
    first,
    row(5),
    row(9, "block_broken", { sessionId: "new-session" }),
  ])!;
  expect(source).toMatchObject({ after: 3, through: 5, sourceCount: 2 });
  expect(source.input).toContain("missing seq 2..3");
  expect(source.input).not.toContain("new-session");
  const large = Array.from({ length: 500 }, (_, i) =>
    row(i + 1, "block_broken", { position: [i, 64, 0] }),
  );
  const bounded = prepareSummaryInput(0, large)!;
  expect(bounded.sourceCount).toBeLessThan(500);
  expect(bounded.through).toBe(bounded.sourceCount);
  expect(Buffer.byteLength(bounded.input)).toBeLessThanOrEqual(summaryInputBytes);
});

test("refuses CLI activity rather than projecting speech into summary input", () => {
  const record = {
    id: 1,
    observation: {
      worldId: "w",
      playerId: "p",
      sessionId: "s",
      observedAt: 1,
      origin: "cli",
      event: "hisyo.player_input",
      data: { text: "CLI_ONLY_SENTINEL" },
    },
  } as unknown as StoredEvent;
  expect(() => prepareSummaryInput(0, [record])).toThrow(/Mod observations/);
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
  const source = prepareSummaryInput(0, [
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
  expect(source.input).not.toContain("equipped=");
  expect(source.input.match(/itemId=air->stone/gu)).toHaveLength(1);
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
  const source = prepareSummaryInput(0, [
    stackRow(1, "inventory_slot_changed", { slot }),
    stackRow(2, "equipment_slot_changed", { slot: equipment }),
  ])!;
  if (equipment === "offHand") expect(source.input).not.toContain("equipped=");
  else expect(source.input).toContain(`equipped=${equipment}`);
  expect(source.input).toContain(`slot=${slot}`);
  expect(source.input).not.toContain("equipment_slot_changed");
  expect(source.sourceCount).toBe(2);
});

test("coalesces stable main-hand mirrors but preserves every hotbar selection change", () => {
  const source = prepareSummaryInput(0, [
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
  expect(source.input).not.toContain("equipped=");
  expect(source.input).not.toContain("hand=");
  expect(source.input.match(/held_item_changed/gu)).toHaveLength(2);
  expect(source.input).toContain("slot=3->4");
  expect(source.input).toContain("slot=4->5");
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
  const source = prepareSummaryInput(0, [
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
  const source = prepareSummaryInput(0, [
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
  const source = prepareSummaryInput(0, [
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
  const source = prepareSummaryInput(0, [
    container,
    stackRow(4, "inventory_slot_changed", { slot: 3 }),
  ])!;
  expect(source.input).toContain("e1: missing seq 1..2");
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
  expect(prepareSummaryInput(0, [container, inventory])!.input).toContain("container_slot_changed");
  expect(
    prepareSummaryInput(0, [
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
    const source = prepareSummaryInput(
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
  const source = prepareSummaryInput(0, [
    stackRow(1, "held_item_changed", { hand: "off_hand", beforeSlot: null, afterSlot: null }),
  ])!;
  expect(source.input).toContain("held_item_changed");
});

test("keeps named equipment as the representative when its inventory counterpart is outside the prefix", () => {
  const source = prepareSummaryInput(0, [
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
  const source = prepareSummaryInput(0, [
    row(1, "grid_result_taken"),
    sample,
    row(3, "grid_result_taken", { seq: 4 }),
  ])!;
  expect(source.input).toContain("e2: missing seq 2..2");
  expect(source.input.match(/grid_result_taken/gu)).toHaveLength(2);
  expect(source.input).not.toContain("totalTaken=");
});

test("shortens IDs and transitions, rounds only coordinates, and omits pickup defaults", () => {
  const entries = [
    row(14001, "block_broken", {
      position: [387.654, -18.06, -0.04],
      data: { blockId: "example:ore", position: [388.156, -19, 2.03] },
    }),
    stackRow(14003, "inventory_slot_changed", {
      slot: 6,
      beforeItemId: "minecraft:torch",
      afterItemId: "minecraft:torch",
      beforeCount: 19,
      afterCount: 18,
    }),
    row(14004, "item_picked_up"),
    row(14005, "item_picked_up", {
      data: {
        ...observations.find((entry) => entry.event === "item_picked_up")!.data,
        infiniteMaterials: true,
        entityPosition: [387.654, -18.06, -0.04],
      },
    }),
    row(14006, "experience_changed", {
      data: {
        beforeLevel: 5,
        afterLevel: 6,
        beforeProgress: 0.3456789,
        afterProgress: 0.1234567,
        beforeTotalExperience: 59,
        afterTotalExperience: 73,
      },
    }),
  ];
  const original = structuredClone(entries);
  const source = prepareSummaryInput(14000, entries)!;
  expect(source.input).toContain(
    "e1 block_broken blockId=example:ore position=388.2,-19,2 @overworld:387.7,-18.1,0",
  );
  expect(source.input).toContain("slot=6");
  expect(source.input).toContain("itemId=torch count=19->18");
  expect(source.input).toContain("infiniteMaterials=true");
  expect(source.input).not.toContain("entityPosition=");
  expect(source.input).toContain("level=5->6 progress=0.3456789->0.1234567 totalExperience=59->73");
  expect(source.input).not.toMatch(
    /beforeItemId|afterCount|remainingCount|infiniteMaterials=false|e1400\d/u,
  );
  expect(source.input).not.toContain("Source session:");
  expect(source.input).not.toContain(entries[0]!.observation.sessionId);
  expect(source.input).not.toContain("Observed ms range:");
  expect(source.input).not.toContain("Coordinates rounded");
  expect(source).toMatchObject({ after: 14000, through: 14006, sourceCount: 5 });
  expect(entries).toEqual(original);
  expect(prepareSummaryInput(14006, [row(15000)])!.input).toContain("e1 block_broken");
});

test.each([
  ["item_picked_up", 3],
  ["item_dropped", 2],
])(
  "omits entityPosition from %s while retaining item quantities and player location",
  (event, count) => {
    const source = prepareSummaryInput(0, [row(1, event)])!;
    expect(source.input).not.toContain("entityPosition=");
    expect(source.input).toContain(`${event} itemId=stone count=${count}`);
    expect(source.input).toContain("@overworld:2,64,0");
  },
);

test("omits visibility caveats while retaining nearby observations", () => {
  const source = prepareSummaryInput(0, [row(1, "nearby_sampled")])!;
  expect(source.input).toContain("nearby_sampled:overworld [1 samples");
  expect(source.input).toContain("seen types=block:stone,entity:cow");
  expect(source.input).toContain(
    "last ray-sampled blocks=stone×1 entities=cow×1 @overworld:2,64,0",
  );
  expect(source.input).not.toMatch(/not FOV|lighting|full sight|empty != absence/u);
});

test("renders only the container menu type while retaining the common event location", () => {
  const entry = row(1, "container_opened");
  const original = structuredClone(entry);
  const source = prepareSummaryInput(0, [entry])!;
  expect(source.input.split("\n").slice(2)).toEqual([
    "e1 container_opened menuType=generic_9x3 @overworld:2,64,0",
  ]);
  expect(source).toMatchObject({ after: 0, through: 1, sourceCount: 1 });
  expect(entry).toEqual(original);
});

test("filters only agreed samples and advancement notifications, retaining effects and progress", () => {
  const effects = observations.find((entry) => entry.event === "status_effects_sampled")!.data;
  const criterion = observations.find(
    (entry) => entry.event === "advancement_criterion_granted",
  )!.data;
  const completed = observations.find((entry) => entry.event === "advancement_completed")!.data;
  const entries = [
    row(1, "structures_sampled"),
    row(2, "status_effects_sampled", {
      data: { ...effects, effects: [], effectsTruncated: false },
    }),
    row(3, "advancement_criterion_granted", {
      data: { ...criterion, advancementId: "minecraft:recipes/tools/pickaxe", afterDone: false },
    }),
    row(4, "advancement_completed", {
      data: { ...completed, advancementId: "minecraft:recipes/tools/pickaxe" },
    }),
    row(5, "advancement_criterion_granted", {
      data: { ...criterion, advancementId: "minecraft:story/mine_diamond", afterDone: true },
    }),
    row(6, "advancement_completed", {
      data: { ...completed, advancementId: "minecraft:story/mine_diamond" },
    }),
    row(7, "advancement_criterion_granted", {
      data: { ...criterion, advancementId: "example:recipes/partial", afterDone: false },
    }),
    row(8, "status_effects_sampled"),
    row(9, "status_effects_sampled", { data: { ...effects, effects: [], effectsTruncated: true } }),
    row(10, "status_effect_changed"),
  ];
  const source = prepareSummaryInput(0, entries)!;
  expect(source.input).not.toContain("structures_sampled");
  expect(source.input).not.toContain("structure metadata");
  expect(source.input).not.toContain("recipes/tools/pickaxe");
  expect(source.input.match(/advancement_criterion_granted/gu)).toHaveLength(1);
  expect(source.input).toContain("advancementId=example:recipes/partial");
  expect(source.input).toContain("advancement_completed advancementId=story/mine_diamond");
  expect(source.input).toContain("status_effects_sampled:overworld [2 samples");
  expect(source.input).toContain("effectsTruncated=true");
  expect(source.input).toContain("status_effect_changed");
  expect(source).toMatchObject({
    through: 10,
    sourceCount: 10,
    firstObservedAt: 1000,
    lastObservedAt: 10000,
  });
});

test("numbers source observations locally, including sample ranges and gaps on omitted rows", () => {
  const filtered = row(14001, "structures_sampled");
  filtered.missingSequencesBefore = { from: 20, to: 22 };
  const source = prepareSummaryInput(14000, [
    filtered,
    row(14002, "block_broken"),
    row(14004, "block_broken"),
    row(14005, "player_location_changed", {
      position: [1.234, 64.03, -2.678],
      data: {
        beforePosition: [0.123, 64, -3.456],
        afterPosition: [1.234, 64.03, -2.678],
        beforeBiomeId: "minecraft:plains",
        afterBiomeId: "example:woods",
        sampleIntervalTicks: 20,
        minimumDistance: 1,
        elapsedTicks: 20,
      },
    }),
    row(14006, "player_location_changed"),
  ])!;
  expect(source.input).toContain("e1: missing seq 20..22");
  expect(source.input).toContain("e2..e3 [2 identical observations] block_broken");
  expect(source.input).toContain("player_location_changed:overworld [2 samples, e4..e5");
  expect(source.input).toContain("first sampled position=0.1,64,-3.5");
  expect(source.input).toContain("example:woods");
  expect(source.input).toContain("last sampled move=0,64,0 -> 2,64,0 @overworld:2,64,0");
  expect(source.input).not.toContain("e140");
  expect(source).toMatchObject({ after: 14000, through: 14006, sourceCount: 5 });
});

test("lossy display formatting never broadens identical-observation grouping", () => {
  const attempted = observations.find((entry) => entry.event === "item_use_attempted")!.data;
  const source = prepareSummaryInput(0, [
    row(1, "block_broken", { position: [1.01, 64, 0] }),
    row(2, "block_broken", { position: [1.04, 64, 0] }),
    row(3, "item_use_attempted", { data: { ...attempted, hand: "main_hand" } }),
    row(4, "item_use_attempted", { data: { ...attempted, hand: "off_hand" } }),
  ])!;
  expect(source.input.match(/block_broken/gu)).toHaveLength(2);
  expect(source.input.match(/item_use_attempted/gu)).toHaveLength(2);
  expect(source.input).not.toMatch(/hand=|identical observations/u);
});

test("timestamp range uses all included rows, not arrival order", () => {
  const source = prepareSummaryInput(0, [
    row(1, "health_changed", { observedAt: 1000 }),
    row(2, "food_changed", { observedAt: 5000 }),
    row(3, "health_changed", { observedAt: 900 }),
  ])!;
  expect(source).toMatchObject({ firstObservedAt: 900, lastObservedAt: 5000 });
  expect(source.input).not.toContain("Observed ms range:");
});
