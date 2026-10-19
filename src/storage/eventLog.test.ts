import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { expect, test } from "vite-plus/test";

import { Type } from "typebox";
import { initializeEventDatabase } from "./eventDatabase.js";
import { activityCatalog } from "../events/activity.js";
import { eventPageBytes } from "./eventLog.js";
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import { EventCatalog } from "../events/eventCatalog.js";
import { EventLog } from "./eventLog.js";
import { ActivityLog } from "./activityLog.js";
import type { GameEvent } from "../protocol/gameEvent.js";

const binding = { worldId: "world", playerId: "player", sessionId: "session" };
const input = {
  ...binding,
  origin: "cli" as const,
  recordedAt: 100,
  event: "hisyo.player_input",
  data: { text: "日本語をそのまま" },
};

// Literal statement replies only: this port neither parses nor executes SQL.
function port(replies: Record<string, SQLOutputValue>[][] = [], failRunAt = 0) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const transactions: string[] = [];
  let id = 0;
  const db = {
    exec(sql: string) {
      transactions.push(sql);
    },
    prepare(sql: string) {
      return {
        get(...args: unknown[]) {
          calls.push({ sql, args });
          return replies.shift()?.[0];
        },
        all(...args: unknown[]) {
          calls.push({ sql, args });
          return replies.shift() ?? [];
        },
        run(...args: unknown[]) {
          calls.push({ sql, args });
          if (++id === failRunAt) throw new Error("storage failed");
          return { lastInsertRowid: id, changes: 1 };
        },
      };
    },
  };
  return { db: db as unknown as DatabaseSync, calls, transactions };
}

function log(p = port()) {
  return { ...p, log: new EventLog(p.db, new EventCatalog(gameEventDefinitions)) };
}

function row(id: number, observation: unknown = input) {
  return {
    id,
    world_id: binding.worldId,
    player_id: binding.playerId,
    session_id: binding.sessionId,
    event: input.event,
    observed_at: input.recordedAt,
    seq: null,
    observation_json: JSON.stringify(observation),
    gap_from: null,
    gap_to: null,
  };
}

test("real raw SQLite schema contains only observation tables at independent version 1", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeEventDatabase(db);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "events" }]);
  } finally {
    db.close();
  }
});

test("real raw SQLite refuses null and nonpositive Mod sequences", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeEventDatabase(db);
    const insert = db.prepare(
      "INSERT INTO events(world_id,player_id,session_id,seq,event,observed_at,observation_json) VALUES ('world','player','session',?,'hisyo.player_input',100,?)",
    );
    for (const seq of [null, 0, -1]) expect(() => insert.run(seq, JSON.stringify(input))).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(0);
  } finally {
    db.close();
  }
});

test("real legacy raw schemas fail without automatic migration or data mutation", () => {
  for (const version of [2, 3, 4, 5]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('original'); PRAGMA user_version = ${version}`,
      );
      expect(() => initializeEventDatabase(db)).toThrow("Preserve the existing database");
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
      expect(db.prepare("SELECT value FROM preserved").all()).toEqual([{ value: "original" }]);
    } finally {
      db.close();
    }
  }
});

test("real raw SQLite applies typed AND filters while retaining scope-wide gap evidence", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeEventDatabase(db);
    const catalog = new EventCatalog([
      {
        name: "future",
        description: "future",
        observation: "confirmed",
        dataSchema: Type.Object({
          flag: Type.Union([Type.Boolean(), Type.Number()]),
          n: Type.Number(),
          value: Type.Union([Type.Null(), Type.String()]),
          text: Type.String(),
        }),
        filterFields: ["flag", "n", "value", "text"],
      },
    ]);
    const raw = new EventLog(db, catalog);
    const game: GameEvent = {
      ...binding,
      seq: 1,
      tick: 1,
      observedAt: 100,
      event: "future",
      dimension: "minecraft:overworld",
      position: [0, 64, 0],
      data: { flag: true, n: 1, value: null, text: "1" },
    };
    raw.append(game);
    raw.append({ ...game, seq: 3, data: { ...game.data, flag: 1 } });
    raw.append({ ...game, seq: 4, data: { ...game.data, text: "other" } });
    raw.append({ ...game, seq: 5, data: { ...game.data, value: "null" } });
    const scope = { worldId: "world", playerId: "player" };
    const filtered = raw.search(scope, {
      event: "future",
      filter: { flag: true, n: 1, value: null, text: "1" },
    });
    expect(filtered.events.map(({ id }) => id)).toEqual([1]);
    expect(filtered.through).toBe(4);
    expect(filtered.hasKnownGaps).toBe(true);
    expect(raw.search(scope, { since: 101 })).toEqual({
      events: [],
      through: 4,
      hasKnownGaps: true,
    });
    const first = raw.search(scope, { limit: 1 });
    raw.append({ ...game, seq: 6 });
    expect(
      raw
        .search(scope, { after: first.nextCursor, through: first.through })
        .events.map(({ id }) => id),
    ).toEqual([2, 3, 4]);
    expect(() => raw.append(game)).toThrow("Invalid event sequence");
    initializeEventDatabase(db);
    expect(raw.search(scope).through).toBe(5);
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  } finally {
    db.close();
  }
});

test("real raw transaction rollback does not consume observations or sequence progress", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeEventDatabase(db);
    const raw = new EventLog(db, new EventCatalog(gameEventDefinitions));
    const game: GameEvent = {
      ...binding,
      seq: 1,
      tick: 1,
      observedAt: 100,
      event: "block_broken",
      dimension: "minecraft:overworld",
      position: [0, 64, 0],
      data: { blockId: "minecraft:stone", position: [1, 64, 0] },
    };
    expect(() =>
      raw.atomic(() => {
        raw.append(game);
        throw new Error("second observation failed");
      }),
    ).toThrow("second observation failed");
    expect(raw.search({ worldId: "world", playerId: "player" }).events).toEqual([]);
    expect(raw.atomic(() => raw.append(game))).toEqual({ id: 1, observation: game });
  } finally {
    db.close();
  }
});

test("real raw initialization rolls back partial DDL without an automatic repair", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE events_scope (value TEXT); INSERT INTO events_scope VALUES ('original')");
    expect(() => initializeEventDatabase(db)).toThrow();
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all(),
    ).toEqual([{ name: "events_scope" }]);
    expect(db.prepare("SELECT value FROM events_scope").get()?.value).toBe("original");
    db.exec("DROP TABLE events_scope");
    initializeEventDatabase(db);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  } finally {
    db.close();
  }
});

test("event log rejects invalid current nearby payloads without rewriting stored data", () => {
  const nearby = {
    ...binding,
    seq: 1,
    tick: 4,
    observedAt: 100,
    event: "nearby_sampled",
    dimension: "minecraft:overworld",
    position: [0, 64, 0],
    data: {
      sampleIntervalTicks: 20,
      blockRadius: 4,
      blocksComplete: true,
      blocks: [{ blockId: "minecraft:diamond_ore", position: [0, 60, 0] }],
      entityRadius: 16,
      entitiesTruncated: false,
      entities: [{ entityId: "hidden", entityType: "minecraft:zombie", position: [3, 64, 0] }],
    },
  };
  const invalid = { ...row(1, nearby), seq: 1, event: nearby.event };
  const original = invalid.observation_json;
  const f = log(port([[{ id: 1 }], [invalid], [{ found: 0 }]]));
  expect(() => f.log.search({ worldId: binding.worldId, playerId: binding.playerId })).toThrow(
    /Invalid data/,
  );
  expect(invalid.observation_json).toBe(original);
  const sink = log();
  expect(() => sink.log.append({ ...nearby, position: [0, 64, 0] })).toThrow(/Invalid data/);
  expect(sink.calls).toEqual([]);

  const filtered = { ...nearby, data: { ...nearby.data, visibility: "unobstructed" } };
  const g = log(
    port([
      [{ id: 1 }],
      [{ ...invalid, observation_json: JSON.stringify(filtered) }],
      [{ found: 0 }],
    ]),
  );
  expect(
    g.log.search({ worldId: binding.worldId, playerId: binding.playerId }).events[0]!.observation,
  ).toEqual(filtered);
});

test("observation-only event log preserves Mod sequence and gap semantics", () => {
  const game = {
    ...binding,
    seq: 3,
    tick: 4,
    observedAt: 100,
    event: "block_broken",
    dimension: "minecraft:overworld",
    position: [0, 64, 0] as [number, number, number],
    data: { blockId: "minecraft:stone", position: [1, 64, 0] },
  };
  const f = log(port([[{ seq: 1 }]]));
  expect(f.log.append(game)).toEqual({
    id: 1,
    observation: game,
    missingSequencesBefore: { from: 2, to: 2 },
  });
  const storedGame = { ...row(1, game), seq: 3, event: game.event, gap_from: 2, gap_to: 2 };
  const search = log(port([[{ id: 1 }], [storedGame], [{ found: 1 }]]));
  expect(search.log.search({ worldId: "world", playerId: "player" }).events).toEqual([
    { id: 1, observation: game, missingSequencesBefore: { from: 2, to: 2 } },
  ]);
  expect(() => new EventCatalog(gameEventDefinitions).validateObservation(input)).toThrow();
});

test.each([
  [0, 1, null, null],
  [1, 2, null, null],
  [1, 4, 2, 3],
])(
  "independent game and CLI logs retain distinct sequence metadata (%i -> %i)",
  (last, seq, from, to) => {
    const f = log(port([[{ seq: last }]]));
    const a = port();
    const cliLog = new ActivityLog(a.db);
    const cli = structuredClone(input);
    const game = {
      ...binding,
      seq,
      tick: 4,
      observedAt: 101,
      event: "block_broken",
      dimension: "minecraft:overworld",
      position: [0, 64, 0] as [number, number, number],
      data: { blockId: "minecraft:stone", position: [1, 64, 0] },
    };
    const storedCli = cliLog.appendActivity(cli);
    const storedGame = f.log.append(game);
    expect(storedCli.id).toBe(storedGame.id);
    expect(a.calls[0]!.args).toEqual([
      binding.worldId,
      binding.playerId,
      binding.sessionId,
      cli.event,
      cli.recordedAt,
      JSON.stringify(cli),
    ]);
    expect(f.calls[1]!.args).toEqual([
      binding.worldId,
      binding.playerId,
      binding.sessionId,
      seq,
      game.event,
      game.observedAt,
      JSON.stringify(game),
      from,
      to,
    ]);
    expect(storedGame.missingSequencesBefore).toEqual(from === null ? undefined : { from, to });
    cli.data.text = "changed";
    game.data.position[0] = 999;
    expect(storedCli.activity.data.text).toBe(input.data.text);
    expect(storedGame.observation.data.position).toEqual([1, 64, 0]);
  },
);

test("oversized future game records fail explicitly instead of dropping or truncating", () => {
  const catalog = new EventCatalog([
    {
      name: "future",
      description: "future",
      observation: "confirmed",
      dataSchema: Type.Object({ text: Type.String() }),
      filterFields: ["text"],
    },
  ]);
  const game = {
    ...binding,
    seq: 1,
    tick: 1,
    observedAt: 100,
    event: "future",
    dimension: "overworld",
    position: [0, 0, 0],
    data: { text: "x".repeat(eventPageBytes) },
  };
  const p = port([[{ id: 1 }], [{ ...row(1, game), seq: 1, event: "future" }], [{ found: 0 }]]);
  expect(() =>
    new EventLog(p.db, catalog).search({ worldId: "world", playerId: "player" }),
  ).toThrow("byte budget");
});

test("event log filters retain scalar type-sensitive AND parameters", () => {
  const catalog = new EventCatalog([
    {
      name: "future",
      description: "future",
      observation: "confirmed",
      dataSchema: Type.Object({
        flag: Type.Boolean(),
        n: Type.Number(),
        value: Type.Null(),
        text: Type.String(),
      }),
      filterFields: ["flag", "n", "value", "text"],
    },
  ]);
  const p = port([[{ id: 0 }], [], [{ found: 0 }]]);
  new EventLog(p.db, catalog).search(
    { worldId: "world", playerId: "player" },
    { event: "future", filter: { flag: true, n: 1, value: null, text: "1" } },
  );
  expect(p.calls[1]!.sql).toContain(" AND json_type");
  expect(p.calls[1]!.args).toEqual([
    "world",
    "player",
    0,
    0,
    "future",
    '$.data."flag"',
    "true",
    '$.data."flag"',
    1,
    '$.data."n"',
    "integer",
    "real",
    '$.data."n"',
    1,
    '$.data."value"',
    "null",
    '$.data."value"',
    null,
    '$.data."text"',
    "text",
    '$.data."text"',
    "1",
    101,
  ]);
  expect(() =>
    activityCatalog.validateFilter("hisyo.hook_matched", { sourceEventId: "1" }),
  ).toThrow();
});

test("schema 0 creates only raw positive-seq observations at version 1", () => {
  const fresh = port([[{ user_version: 0 }]]);
  initializeEventDatabase(fresh.db);
  const sql = fresh.transactions.join("\n");
  expect(sql).toContain("seq INTEGER NOT NULL CHECK(seq > 0)");
  expect(sql).not.toContain("hooks");
  expect(sql).toContain("PRAGMA user_version = 1;");
  expect(sql).not.toContain("summaries");
  expect(sql).not.toContain("PRAGMA user_version = 3");
});

test("raw v1 reopens without changing schema or rows", () => {
  const p = port([[{ user_version: 1 }]]);
  initializeEventDatabase(p.db);
  expect(p.transactions).toHaveLength(1);
  expect(p.transactions.join("\n")).not.toMatch(/CREATE|DROP|DELETE|user_version/);
});

test("legacy and unknown raw schemas fail before even write-affecting PRAGMAs", () => {
  for (const version of [2, 3, 4, -1, 99, "1", null]) {
    const p = port([[{ user_version: version }]]);
    expect(() => initializeEventDatabase(p.db)).toThrow("Preserve the existing database");
    expect(p.transactions).toEqual([]);
  }
});
