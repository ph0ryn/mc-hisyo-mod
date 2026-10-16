import { mkdtempDisposableSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { EventCatalog } from "../src/events/eventCatalog.js";
import { EventLog } from "../src/events/eventLog.js";
import { ResponseHooks } from "../src/hooks/responseHooks.js";
import { gameEventDefinitions, type GameEvent } from "../src/protocol/gameEvent.js";
import { openDatabase } from "../src/storage/database.js";

const fixture: GameEvent = JSON.parse(
  readFileSync(new URL("./fixtures/protocol/blockBroken.json", import.meta.url), "utf8"),
);
const scope = { worldId: fixture.worldId, playerId: fixture.playerId };

function databasePath() {
  const directory = mkdtempDisposableSync(join(tmpdir(), "mc-hisyo-events-"));
  onTestFinished(() => directory.remove());
  return join(directory.path, "director.sqlite");
}

function open(path = ":memory:", catalog = new EventCatalog(gameEventDefinitions)) {
  const db = openDatabase(path);
  onTestFinished(() => db.close());
  return { db, log: new EventLog(db, catalog), hooks: new ResponseHooks(db, catalog), catalog };
}

function observation(seq: number, changes: Partial<GameEvent> = {}): GameEvent {
  return { ...fixture, seq, tick: fixture.tick + seq, ...changes };
}

describe("durable event history and response hooks", () => {
  it("records without hooks and survives a database reopen with original facts intact", () => {
    const path = databasePath();
    const catalog = new EventCatalog(gameEventDefinitions);
    const db = openDatabase(path);
    const log = new EventLog(db, catalog);
    log.append(fixture);
    db.close();

    const resumed = open(path, catalog);
    expect(resumed.log.search(scope).events).toEqual([{ id: 1, observation: fixture }]);
    expect(resumed.hooks.list(scope)).toEqual({ hooks: [] });
  });

  it("matches exact AND filters, persists hook instructions, and removes only within scope", () => {
    const { log, hooks } = open(databasePath());
    const hook = hooks.add(scope, {
      event: "block_broken",
      filter: { blockId: "minecraft:stone" },
      instruction: "Ask whether to keep mining.",
    });
    log.append(fixture);
    expect(hooks.match(fixture)).toEqual([hook]);
    expect(
      hooks.match(observation(2, { data: { blockId: "minecraft:dirt", position: [1, 2, 3] } })),
    ).toEqual([]);
    expect(hooks.match(observation(2, { playerId: "another-player" }))).toEqual([]);
    expect(hooks.remove({ ...scope, worldId: "another-world" }, hook.id)).toBe(false);
    expect(hooks.remove(scope, hook.id)).toBe(true);
    expect(hooks.match(fixture)).toEqual([]);
    expect(log.search(scope).events).toHaveLength(1);
  });

  it("resumes saved hooks after reopening the same world and player", () => {
    const path = databasePath();
    const catalog = new EventCatalog(gameEventDefinitions);
    const db = openDatabase(path);
    const hook = new ResponseHooks(db, catalog).add(scope, {
      event: "block_broken",
      instruction: "Review the mining plan.",
    });
    db.close();
    expect(open(path, catalog).hooks.match(fixture)).toEqual([hook]);
  });

  it("adds a future event definition without changing persistence, searching, or matching", () => {
    const catalog = new EventCatalog([
      ...gameEventDefinitions,
      {
        name: "example:machine_completed",
        description: "A machine reports successful completion.",
        observation: "confirmed",
        dataSchema: Type.Object(
          { machineId: Type.String(), outputCount: Type.Integer(), powered: Type.Boolean() },
          { additionalProperties: false },
        ),
        filterFields: ["machineId", "outputCount", "powered"],
      },
    ]);
    const { log, hooks } = open(databasePath(), catalog);
    const event = observation(1, {
      event: "example:machine_completed",
      data: { machineId: "example:crusher", outputCount: 0, powered: false },
    });
    const hook = hooks.add(scope, {
      event: event.event,
      filter: { machineId: "example:crusher", outputCount: 0, powered: false },
      instruction: "Review the machine output.",
    });
    log.append(event);
    expect(hooks.match(event)).toEqual([hook]);
    expect(hooks.match({ ...event, data: { ...event.data, powered: true } })).toEqual([]);
    expect(
      log.search(scope, { event: event.event, filter: { outputCount: 0, powered: false } })
        .events[0]?.observation,
    ).toEqual(event);
    expect(
      catalog.list().find((definition) => definition.name === event.event)?.filterFields,
    ).toEqual(["machineId", "outputCount", "powered"]);
  });

  it("keeps booleans, numbers, explicit null, and missing values distinct in history filters", () => {
    const catalog = new EventCatalog([
      ...gameEventDefinitions,
      {
        name: "example:scalar",
        description: "An optional scalar observation.",
        observation: "confirmed",
        dataSchema: Type.Object(
          { value: Type.Optional(Type.Union([Type.Integer(), Type.Boolean(), Type.Null()])) },
          { additionalProperties: false },
        ),
        filterFields: ["value"],
      },
    ]);
    const { log, hooks } = open(":memory:", catalog);
    const event = "example:scalar";
    const hook = hooks.add(scope, { event, filter: { value: false }, instruction: "Review." });
    for (const [index, data] of [{ value: 0 }, { value: false }, { value: null }, {}].entries()) {
      const entry = observation(index + 1, { event, data });
      log.append(entry);
      expect(hooks.match(entry)).toEqual(index === 1 ? [hook] : []);
    }
    expect(
      log.search(scope, { event, filter: { value: false } }).events.map((entry) => entry.id),
    ).toEqual([2]);
    expect(
      log.search(scope, { event, filter: { value: 0 } }).events.map((entry) => entry.id),
    ).toEqual([1]);
    expect(
      log.search(scope, { event, filter: { value: null } }).events.map((entry) => entry.id),
    ).toEqual([3]);
  });

  it("rejects future database schemas without attempting a migration", () => {
    const path = databasePath();
    const db = openDatabase(path);
    db.exec("PRAGMA user_version = 2");
    db.close();
    expect(() => openDatabase(path)).toThrow(/database version/i);
  });

  it("paginates within a stable fence and isolates worlds and players", () => {
    const { log } = open();
    for (let seq = 1; seq <= 3; seq++) log.append(observation(seq));
    log.append(observation(1, { worldId: "other-world" }));
    log.append(observation(1, { playerId: "other-player" }));
    const first = log.search(scope, { limit: 2 });
    expect(first.events.map((entry) => entry.id)).toEqual([1, 2]);
    expect(first.nextCursor).toBe(2);
    log.append(observation(4));
    const second = log.search(scope, { after: first.nextCursor, through: first.through, limit: 2 });
    expect(second.events.map((entry) => entry.id)).toEqual([3]);
    expect(second.nextCursor).toBeUndefined();
    expect(log.search(scope, { since: fixture.observedAt + 1 }).events).toEqual([]);
  });

  it("preserves an explicit sequence gap and rejects duplicate or out-of-order observations", () => {
    const { log } = open();
    log.append(observation(1));
    expect(log.append(observation(4)).missingSequencesBefore).toEqual({ from: 2, to: 3 });
    expect(() => log.append(observation(4))).toThrow(/sequence/i);
    expect(() => log.append(observation(2))).toThrow(/sequence/i);
    expect(log.search(scope).events[1]?.missingSequencesBefore).toEqual({ from: 2, to: 3 });
  });

  it("reports known stream gaps even when matching filters hide the successor event", () => {
    const { log } = open();
    log.append(observation(1));
    const beforeGap = log.search(scope);
    log.append(observation(4, { event: "health_changed", data: { before: 20, after: 18 } }));
    log.append(observation(5));
    const filtered = log.search(scope, { event: "block_broken" });
    expect(filtered.events.every((entry) => entry.missingSequencesBefore === undefined)).toBe(true);
    expect(filtered.hasKnownGaps).toBe(true);
    expect(
      log.search(scope, { event: "block_broken", since: fixture.observedAt + 1 }).hasKnownGaps,
    ).toBe(true);
    expect(log.search(scope, { through: beforeGap.through }).hasKnownGaps).toBe(false);
  });

  it("rejects unknown events, malformed payloads, unsupported filter fields, and bad limits", () => {
    const { log, hooks } = open();
    expect(() => log.append(observation(1, { event: "unknown_event" }))).toThrow(/event/i);
    expect(() => log.append(observation(1, { data: { blockId: 42 } }))).toThrow(/data/i);
    expect(() => log.append(observation(-1))).toThrow(/observation/i);
    expect(() =>
      hooks.add(scope, {
        event: "block_broken",
        filter: { missingField: "x" },
        instruction: "Check.",
      }),
    ).toThrow(/filter/i);
    expect(() =>
      hooks.add(scope, { event: "block_broken", filter: { blockId: 42 }, instruction: "Check." }),
    ).toThrow(/filter/i);
    expect(() => log.search(scope, { filter: { blockId: "minecraft:stone" } })).toThrow(/event/i);
    expect(() => log.search(scope, { limit: 0 })).toThrow(/limit/i);
    expect(() => log.search(scope, { limit: 501 })).toThrow(/limit/i);
    expect(() => log.search(scope, { event: "block_broken", filter: JSON.parse("[]") })).toThrow(
      /filter/i,
    );
    expect(log.search(scope).events).toEqual([]);
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

  it("starts independent session sequences without claiming disconnected intervals were observed", () => {
    const { log } = open();
    log.append(observation(1));
    log.append(observation(1, { worldSessionId: "new-session" }));
    expect(log.search(scope).events).toHaveLength(2);
    // No known discontinuity does not prove complete coverage between sessions.
    expect(log.search(scope).hasKnownGaps).toBe(false);
  });
});
