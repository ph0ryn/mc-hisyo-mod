import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { EventCatalog, type EventFilter } from "../events/eventCatalog.js";
import { EventLog } from "../events/eventLog.js";
import { ResponseHooks } from "../hooks/responseHooks.js";
import { gameEventDefinitions, type GameEvent } from "./gameEvent.js";
import { openDatabase } from "../storage/database.js";

const fixtures: GameEvent[] = JSON.parse(
  readFileSync(
    new URL("../../tests/fixtures/protocol/observerEvents.json", import.meta.url),
    "utf8",
  ),
);
const catalog: EventCatalog = new EventCatalog(gameEventDefinitions);

function fixture(name: string): GameEvent {
  const observation = fixtures.find((entry) => entry.event === name);
  if (!observation) throw new Error(`Missing fixture: ${name}`);
  return structuredClone(observation);
}

describe("server observer event contracts", () => {
  it("publishes one shared fixture for each of the 13 supported observation kinds", () => {
    expect(fixtures).toHaveLength(13);
    expect(new Set(fixtures.map((entry) => entry.event)).size).toBe(13);
    expect(gameEventDefinitions.map((entry) => entry.name).toSorted()).toEqual(
      fixtures.map((entry) => entry.event).toSorted(),
    );
  });

  it.each(fixtures)("accepts the Java-shared $event fixture", (observation) => {
    expect(() => catalog.validateObservation(observation)).not.toThrow();
  });

  it("stores, searches, and matches every advertised scalar filter without changing generic engines", () => {
    const db = openDatabase(":memory:");
    try {
      const log = new EventLog(db, catalog);
      const hooks = new ResponseHooks(db, catalog);
      for (const observation of fixtures) {
        const scope = { worldId: observation.worldId, playerId: observation.playerId };
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
        const hook = hooks.add(scope, {
          event: observation.event,
          filter,
          instruction: "Review the observed facts, not an inferred action.",
        });
        log.append(observation);
        expect(log.search(scope, { event: observation.event, filter }).events).toEqual([
          expect.objectContaining({ observation }),
        ]);
        expect(hooks.match(observation)).toEqual([hook]);
        expect(hooks.match({ ...observation, playerId: "other-player" })).toEqual([]);
        expect(() => catalog.validateFilter(observation.event, { inventedField: true })).toThrow();
      }
    } finally {
      db.close();
    }
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
