import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { Type } from "typebox";
import { EventCatalog, matchesFilter, type EventFilter } from "../events/eventCatalog.js";
import { gameEventDefinitions, type GameEvent } from "./gameEvent.js";

const fixtures: GameEvent[] = JSON.parse(
  readFileSync(new URL("./fixtures/observerEvents.json", import.meta.url), "utf8"),
);
const catalog: EventCatalog = new EventCatalog(gameEventDefinitions);

function fixture(name: string): GameEvent {
  const observation = fixtures.find((entry) => entry.event === name);
  if (!observation) throw new Error(`Missing fixture: ${name}`);
  return structuredClone(observation);
}

describe("server observer event contracts", () => {
  it("publishes one shared fixture for each of the 22 supported observation kinds", () => {
    expect(fixtures).toHaveLength(22);
    expect(new Set(fixtures.map((entry) => entry.event)).size).toBe(22);
    expect(gameEventDefinitions.map((entry) => entry.name).toSorted()).toEqual(
      fixtures.map((entry) => entry.event).toSorted(),
    );
  });

  it.each(fixtures)("accepts the Java-shared $event fixture", (observation) => {
    expect(() => catalog.validateObservation(observation)).not.toThrow();
  });

  it("validates and matches every advertised scalar filter", () => {
    for (const observation of fixtures) {
      const definition = catalog.get(observation.event);
      const filter: Record<string, EventFilter[string]> = {};
      for (const field of definition.filterFields) {
        const value = observation.data[field];
        if (
          value !== null &&
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean"
        ) {
          throw new Error(`Fixture filter must be scalar: ${observation.event}.${field}`);
        }
        filter[field] = value;
      }
      expect(() => catalog.validateFilter(observation.event, filter)).not.toThrow();
      expect(matchesFilter(observation.data, filter)).toBe(true);
      expect(() => catalog.validateFilter(observation.event, { inventedField: true })).toThrow();
    }
  });

  it("distinguishes false, zero, null and missing scalar values", () => {
    for (const value of [false, 0, null]) {
      for (const candidate of [false, 0, null]) {
        expect(matchesFilter({ value: candidate }, { value })).toBe(candidate === value);
      }
      expect(matchesFilter({}, { value })).toBe(false);
    }
  });

  it("rejects non-scalar advertised filter fields at catalog construction", () => {
    expect(
      () =>
        new EventCatalog([
          {
            name: "example:invalid",
            description: "Invalid scalar capability.",
            observation: "confirmed",
            dataSchema: Type.Object({ items: Type.Array(Type.String()) }),
            filterFields: ["items"],
          },
        ]),
    ).toThrow(/scalar filter/i);
  });

  it("rejects undeclared payload fields for every fixture", () => {
    for (const observation of fixtures) {
      expect(() =>
        catalog.validateObservation({
          ...observation,
          data: { ...observation.data, inferredCause: "invented" },
        }),
      ).toThrow(/Invalid data/);
    }
  });

  it("keeps attempts, confirmed callbacks, and incomplete snapshot observations distinct", () => {
    expect(catalog.get("entity_use_attempted").observation).toBe("attempt");
    for (const name of [
      "inventory_slot_changed",
      "health_changed",
      "food_changed",
      "experience_changed",
      "held_item_changed",
      "player_location_changed",
    ]) {
      expect(catalog.get(name).observation).toBe("snapshot_delta");
    }
    expect(catalog.get("living_damage_processed").description).toMatch(/lethal/i);
    expect(catalog.get("living_damage_processed").description).toMatch(/health loss/i);
    expect(catalog.get("held_item_changed").description).toMatch(/component/i);
    expect(catalog.get("player_connection_changed").description).toMatch(/removal.*complete/i);
  });

  it("preserves nullable unknown damage entities and nullable or present interaction hit positions", () => {
    const death = fixture("player_died");
    catalog.validateObservation(death);
    catalog.validateFilter("player_died", { causingEntityId: null });
    expect(() => catalog.validateFilter("player_died", { causingEntityId: "" })).toThrow();
    const interaction = fixture("entity_use_attempted");
    catalog.validateObservation(interaction);
    interaction.data.hitPosition = [3, 64.5, 0];
    catalog.validateObservation(interaction);
    expect(() => catalog.validateFilter("entity_use_attempted", { hitPosition: null })).toThrow();
  });

  it("accepts both lifecycle states and live recreation without claiming another death", () => {
    const connection = fixture("player_connection_changed");
    connection.data.state = "leaving";
    catalog.validateObservation(connection);
    connection.data.state = "left";
    expect(() => catalog.validateObservation(connection)).toThrow();
    const respawn = fixture("player_respawned");
    respawn.data.alive = true;
    catalog.validateObservation(respawn);
  });

  it("bounds new samples and rejects invented success, phase, slot and nested facts", () => {
    const effect = {
      effectId: "minecraft:speed",
      amplifier: 0,
      duration: -1,
      ambient: false,
      visible: true,
      showIcon: true,
    };
    for (const change of ["added", "removed", "updated"]) {
      catalog.validateObservation({
        ...fixture("status_effect_changed"),
        data: { ...effect, change },
      });
    }
    catalog.validateObservation({
      ...fixture("status_effects_sampled"),
      data: {
        baseline: true,
        effects: Array(256).fill(effect),
        effectsTruncated: true,
      },
    });
    const invalid: [string, Record<string, unknown>][] = [
      ["status_effects_sampled", { baseline: false }],
      ["status_effects_sampled", { effects: Array(257).fill(effect) }],
      ["status_effects_sampled", { effects: [{ ...effect, inferredCause: "potion" }] }],
      ["status_effect_changed", { change: "refreshed" }],
      ["status_effect_changed", { duration: -2 }],
      ["equipment_slot_changed", { slot: "mainHand" }],
      ["equipment_slot_changed", { afterCount: -1 }],
      ["nearby_sampled", { blockRadius: 5 }],
      [
        "nearby_sampled",
        {
          entities: Array(65).fill({
            entityId: "cow",
            entityType: "minecraft:cow",
            position: [0, 64, 0],
          }),
        },
      ],
      [
        "nearby_sampled",
        { blocks: Array(730).fill({ blockId: "minecraft:stone", position: [0, 64, 0] }) },
      ],
      [
        "nearby_sampled",
        { blocks: [{ blockId: "minecraft:stone", position: [0, 64, 0], visible: true }] },
      ],
      ["structures_sampled", { incomplete: false }],
      [
        "structures_sampled",
        { structureIds: Array.from({ length: 129 }, (_, i) => `example:structure_${i}`) },
      ],
      [
        "structures_sampled",
        { structureIds: ["minecraft:village_plains", "minecraft:village_plains"] },
      ],
      ["structures_sampled", { referenceChunksChecked: 65 }],
      ["structures_sampled", { startsInspected: 129 }],
      ["weather_changed", { afterRaining: "raining" }],
      ["day_clock_phase_changed", { afterPhase: "sunset" }],
      ["day_clock_phase_changed", { dayTime: Number.NaN }],
      ["day_clock_phase_changed", { fixedTime: null }],
      ["advancement_criterion_granted", { criterion: "" }],
      ["advancement_completed", { afterDone: false }],
    ];
    for (const [name, data] of invalid) {
      const observation = fixture(name);
      expect(
        () =>
          catalog.validateObservation({ ...observation, data: { ...observation.data, ...data } }),
        `${name}: ${JSON.stringify(data)}`,
      ).toThrow();
    }
    expect(
      matchesFilter(fixture("status_effect_changed").data, {
        change: "updated",
        effectId: "minecraft:poison",
      }),
    ).toBe(false);
    const fixedClock = fixture("day_clock_phase_changed");
    fixedClock.data.dayTime = -1;
    fixedClock.data.fixedTime = true;
    catalog.validateObservation(fixedClock);
  });

  it("requires explicit valid movement sampling policy instead of claiming a full path", () => {
    const movement = fixture("player_location_changed");
    movement.data.sampleIntervalTicks = 0;
    expect(() => catalog.validateObservation(movement)).toThrow();
    movement.data.sampleIntervalTicks = 20;
    movement.data.minimumDistance = -1;
    expect(() => catalog.validateObservation(movement)).toThrow();
    movement.data.minimumDistance = 1;
    delete movement.data.elapsedTicks;
    expect(() => catalog.validateObservation(movement)).toThrow();
  });
});
