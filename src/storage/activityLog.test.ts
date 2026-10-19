import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import type { RunRequest } from "../runtime/runQueue.js";
import {
  activity,
  displayedActivity,
  activityCatalog,
  runRequestActivities,
  validateActivity,
} from "../events/activity.js";
import { eventPageBytes } from "./eventLog.js";
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import { EventCatalog } from "../events/eventCatalog.js";
import { ActivityLog } from "./activityLog.js";
import { EventLog } from "./eventLog.js";
import { initializeEventDatabase } from "./eventDatabase.js";
import { initializeActivityDatabase } from "./activityDatabase.js";
import type { Activity } from "../events/activity.js";
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
  return { ...p, log: new ActivityLog(p.db) };
}

function row(id: number, record: unknown = input) {
  return {
    id,
    world_id: binding.worldId,
    player_id: binding.playerId,
    session_id: binding.sessionId,
    event: input.event,
    recorded_at: input.recordedAt,
    activity_json: JSON.stringify(record),
  };
}

const game: GameEvent = {
  ...binding,
  seq: 1,
  tick: 4,
  observedAt: 100,
  event: "block_broken",
  dimension: "minecraft:overworld",
  position: [0, 64, 0],
  data: { blockId: "minecraft:stone", position: [1, 64, 0] },
};

function realLogs() {
  const rawDb = new DatabaseSync(":memory:");
  const activityDb = new DatabaseSync(":memory:");
  initializeEventDatabase(rawDb);
  initializeActivityDatabase(activityDb);
  return {
    rawDb,
    activityDb,
    raw: new EventLog(rawDb, new EventCatalog(gameEventDefinitions)),
    activities: new ActivityLog(activityDb),
    close() {
      activityDb.close();
      rawDb.close();
    },
  };
}

test("real SQLite keeps source-specific IDs, scopes, filters and captured high-water independent", () => {
  const f = realLogs();
  try {
    const raw = f.raw.append(game);
    const cli = f.activities.appendActivity(input);
    expect(cli.id).toBe(raw.id);
    f.raw.append({ ...game, seq: 3 });
    f.activities.appendActivity({ ...input, playerId: "other" });
    f.activities.appendActivity({ ...input, sessionId: "previous", recordedAt: 101 });
    const report = activity(binding, "hisyo.status_reported", { paused: false }, 102);
    f.activities.appendActivity(report);
    const first = f.activities.search({ worldId: "world", playerId: "player" }, { limit: 1 });
    expect(first).toEqual({ events: [cli], through: 4, nextCursor: 1, hasKnownGaps: false });
    f.activities.appendActivity({ ...input, recordedAt: 103 });
    const rest = f.activities.search(
      { worldId: "world", playerId: "player" },
      { after: first.nextCursor, through: first.through },
    );
    expect(rest.events.map(({ id }) => id)).toEqual([3, 4]);
    expect(rest.hasKnownGaps).toBe(false);
    expect(
      f.activities.search({ worldId: "world", playerId: "other" }).events.map(({ id }) => id),
    ).toEqual([2]);
    expect(
      f.activities
        .search(
          { worldId: "world", playerId: "player" },
          { event: report.event, filter: { paused: false }, since: 101 },
        )
        .events.map(({ id }) => id),
    ).toEqual([4]);
    expect(
      f.activities.search(
        { worldId: "world", playerId: "player" },
        { event: report.event, filter: { paused: true } },
      ).events,
    ).toEqual([]);
    const observations = f.raw.search({ worldId: "world", playerId: "player" });
    expect(observations.through).toBe(2);
    expect(observations.hasKnownGaps).toBe(true);
    expect(observations.events.map(({ observation }) => observation.event)).toEqual([
      game.event,
      game.event,
    ]);
    expect(observations.events[1]?.missingSequencesBefore).toEqual({ from: 2, to: 2 });
    expect(() =>
      f.raw.search({ worldId: "world", playerId: "player" }, { event: input.event }),
    ).toThrow();
    expect(() =>
      f.activities.search({ worldId: "world", playerId: "player" }, { event: game.event }),
    ).toThrow();
    expect(() => f.raw.append(input as unknown as GameEvent)).toThrow();
    expect(() => f.activities.appendActivity(game as unknown as Activity)).toThrow();
    expect(f.rawDb.prepare("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(2);
    expect(f.activityDb.prepare("SELECT COUNT(*) AS count FROM activities").get()?.count).toBe(5);
  } finally {
    f.close();
  }
});

test("SQLite persists searchable per-call token facts without migrating existing activities", () => {
  const f = realLogs();
  try {
    f.activities.appendActivity(input);
    const data = {
      source: "run",
      requestId: "run-1",
      provider: "openai",
      model: "gpt-6-luna",
      api: "openai-responses",
      stopReason: "stop",
      input: 100,
      output: 20,
      cacheRead: 40,
      cacheWrite: 0,
      total: 160,
    };
    f.activities.appendActivity(activity(binding, "hisyo.token_usage", data, 101));
    f.activities.appendActivity(
      activity(
        binding,
        "hisyo.token_usage",
        {
          ...data,
          source: "summary",
          requestId: "summary-1",
          stopReason: "error",
          input: null,
          output: null,
          cacheRead: null,
          cacheWrite: null,
          total: null,
        },
        102,
      ),
    );
    const reopenedOwner = new ActivityLog(f.activityDb);
    const scope = { worldId: binding.worldId, playerId: binding.playerId };
    expect(reopenedOwner.search(scope, { event: "hisyo.token_usage" }).events).toHaveLength(2);
    expect(
      reopenedOwner.search(scope, {
        event: "hisyo.token_usage",
        filter: { source: "summary", total: null },
      }).events[0]!.activity.data,
    ).toMatchObject({ input: null, total: null, source: "summary" });
    expect(
      reopenedOwner.search(scope, { event: "hisyo.player_input" }).events[0]!.activity,
    ).toEqual(input);
    const row = f.activityDb
      .prepare("SELECT activity_json FROM activities WHERE event = ? ORDER BY id")
      .get("hisyo.token_usage");
    expect(JSON.parse(row!.activity_json as string).data).toEqual(data);
    expect(f.activityDb.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  } finally {
    f.close();
  }
});

test("real SQLite activity pages preserve escaped payloads and cursor continuity", () => {
  const f = realLogs();
  try {
    const records = Array.from({ length: 24 }, (_, i) => ({
      ...input,
      data: { text: `${i}\u0000${'"\\日本語'.repeat(3000)}` },
    }));
    f.activities.appendActivities(records);
    const ids: number[] = [];
    let after = 0;
    for (;;) {
      const page = f.activities.search(
        { worldId: "world", playerId: "player" },
        { after, through: 24, limit: 500 },
      );
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(eventPageBytes);
      for (const entry of page.events) {
        ids.push(entry.id);
        expect(entry.activity.data.text).toBe(records[entry.id - 1]?.data.text);
      }
      if (page.nextCursor === undefined) break;
      expect(page.nextCursor).toBeGreaterThan(after);
      after = page.nextCursor;
    }
    expect(ids).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(f.raw.search({ worldId: "world", playerId: "player" })).toEqual({
      events: [],
      through: 0,
      hasKnownGaps: false,
    });
  } finally {
    f.close();
  }
});

test("real SQLite hooks and CLI audits roll back together without touching durable raw observations", () => {
  const f = realLogs();
  try {
    f.raw.append(game);
    const hook = () =>
      f.activityDb
        .prepare("INSERT INTO hooks VALUES ('hook','world','player','block_broken','{}','respond')")
        .run();
    f.activityDb.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT,'audit failed'); END",
    );
    expect(() =>
      f.activities.atomic(() => {
        hook();
        f.activities.appendActivity(input);
      }),
    ).toThrow("audit failed");
    expect(f.activityDb.prepare("SELECT COUNT(*) AS count FROM hooks").get()?.count).toBe(0);
    expect(f.activityDb.prepare("SELECT COUNT(*) AS count FROM activities").get()?.count).toBe(0);
    expect(f.raw.search({ worldId: "world", playerId: "player" }).events).toHaveLength(1);
    f.activityDb.exec("DROP TRIGGER fail_audit");
    expect(
      f.activities.atomic(() => {
        hook();
        f.activities.appendActivity(input);
        return "committed";
      }),
    ).toBe("committed");
    f.activityDb.exec(
      "CREATE TRIGGER fail_report BEFORE INSERT ON activities WHEN NEW.event = 'hisyo.status_reported' BEGIN SELECT RAISE(ABORT,'report failed'); END",
    );
    expect(() =>
      f.activities.appendActivities([
        input,
        activity(binding, "hisyo.status_reported", { paused: false }, 101),
      ]),
    ).toThrow("report failed");
    expect(f.activityDb.prepare("SELECT COUNT(*) AS count FROM hooks").get()?.count).toBe(1);
    expect(f.activityDb.prepare("SELECT COUNT(*) AS count FROM activities").get()?.count).toBe(1);
  } finally {
    f.close();
  }
});

test("real SQLite activity decoding rejects Mod payloads and mismatched stored metadata", () => {
  const f = realLogs();
  try {
    for (const [json, event, recordedAt] of [
      [JSON.stringify(game), game.event, 100],
      [JSON.stringify(input), "hisyo.status_reported", 100],
      [JSON.stringify(input), input.event, 101],
    ] as const) {
      f.activityDb.exec("DELETE FROM activities");
      f.activityDb
        .prepare(
          "INSERT INTO activities(world_id,player_id,session_id,event,recorded_at,activity_json) VALUES ('world','player','session',?,?,?)",
        )
        .run(event, recordedAt, json);
      expect(() => f.activities.search({ worldId: "world", playerId: "player" })).toThrow();
    }
    f.rawDb
      .prepare(
        "INSERT INTO events(world_id,player_id,session_id,seq,event,observed_at,observation_json) VALUES ('world','player','session',1,?,100,?)",
      )
      .run(input.event, JSON.stringify(input));
    expect(() => f.raw.search({ worldId: "world", playerId: "player" })).toThrow();
  } finally {
    f.close();
  }
});

test("CLI activity persists without a fabricated Mod sequence or game coordinates", () => {
  const f = log();
  expect(f.log.appendActivity(input)).toEqual({ id: 1, activity: input });
  expect(f.calls[0]?.args).toEqual([
    binding.worldId,
    binding.playerId,
    binding.sessionId,
    input.event,
    input.recordedAt,
    JSON.stringify(input),
  ]);
});

test("activity log decodes previous-session CLI records without Mod observations", () => {
  const f = log(port([[{ id: 1 }], [row(1)]]));
  expect(f.log.search({ worldId: "world", playerId: "player" })).toEqual({
    events: [{ id: 1, activity: input }],
    through: 1,
    hasKnownGaps: false,
  });
});

test("stored CLI corruption fails rather than inventing game observations", () => {
  for (const observation of [
    { ...input, seq: 1 },
    { ...input, origin: "game" },
    { ...input, data: { text: 1 } },
    { ...input, tick: 1 },
    { ...input, event: "hisyo.unknown" },
  ]) {
    const f = log(port([[{ id: 1 }], [row(1, observation)]]));
    expect(() => f.log.search({ worldId: "world", playerId: "player" })).toThrow();
  }
});

test("every current Hisyo activity fits individually at maximum escaped text and binding sizes", () => {
  const id = "\u0000".repeat(128);
  const text = "\u0000".repeat(16_000);
  const maxBinding = { worldId: id, playerId: id, sessionId: id };
  const samples: [string, Record<string, unknown>][] = [
    [
      "token_usage",
      {
        source: "run",
        requestId: id,
        provider: id,
        model: "\u0000".repeat(256),
        api: "openai-responses",
        stopReason: "stop",
        input: Number.MAX_SAFE_INTEGER,
        output: Number.MAX_SAFE_INTEGER,
        cacheRead: Number.MAX_SAFE_INTEGER,
        cacheWrite: Number.MAX_SAFE_INTEGER,
        total: Number.MAX_SAFE_INTEGER,
      },
    ],
    ["session_attached", { beforeAttachment: "unknown" }],
    ["status_reported", { paused: false }],
    ["session_detached", { reason: "link_closed", afterLastObservation: "unknown" }],
    ["player_input", { text }],
    ["hud_displayed", { runId: id, text }],
    [
      "hook_added",
      { runId: id, hookId: id, event: "block_broken", filter: { blockId: id }, instruction: text },
    ],
    ["hook_removed", { runId: id, hookId: id }],
    ["hook_matched", { hookId: id, sourceEventId: Number.MAX_SAFE_INTEGER }],
    ["run_requested_initial", { requestId: id }],
    ["run_requested_poll", { requestId: id }],
    ["run_requested_advancement", { requestId: id, sourceEventId: Number.MAX_SAFE_INTEGER }],
    ["run_requested_player", { requestId: id, text }],
    ["run_requested_hook", { requestId: id, hookId: id, sourceEventId: Number.MAX_SAFE_INTEGER }],
  ];
  expect(samples).toHaveLength(activityCatalog.list().length);
  const f = log();
  for (const [event, data] of samples) {
    const stored = f.log.appendActivity(
      activity(maxBinding, `hisyo.${event}`, data, Number.MAX_SAFE_INTEGER),
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({ events: [stored], through: Number.MAX_SAFE_INTEGER, hasKnownGaps: false }),
      ),
    ).toBeLessThan(eventPageBytes);
  }
});

test("invalid activity and scope fail before a write", () => {
  const f = log();
  for (const invalid of [
    { ...input, data: { text: " " } },
    { ...input, worldId: "" },
    { ...input, recordedAt: -1 },
    { ...input, data: { text: "x", extra: true } },
  ])
    expect(() => f.log.appendActivity(invalid)).toThrow();
  expect(f.calls).toEqual([]);
});

test("byte-bounded escaped-text pages resume without loss or duplication", () => {
  const large = { ...input, data: { text: "\u0000".repeat(16_000) } };
  const rows = Array.from({ length: 24 }, (_, i) => row(i + 1, large));
  const seen: number[] = [];
  let after = 0;
  do {
    const f = log(port([[{ id: 24 }], rows.slice(after)]));
    const page = f.log.search(
      { worldId: "world", playerId: "player" },
      { event: input.event, filter: { text: large.data.text }, after, through: 24, limit: 500 },
    );
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(eventPageBytes);
    expect(page.hasKnownGaps).toBe(false);
    expect(page.events.every((entry) => entry.activity.data.text === large.data.text)).toBe(true);
    expect(f.calls[1]!.args.slice(0, 4)).toEqual(["world", "player", after, 24]);
    expect(f.calls).toHaveLength(2);
    expect(
      f.calls.some(({ sql }) => /gap_from|gap_to|observation_json|observed_at/u.test(sql)),
    ).toBe(false);
    seen.push(...page.events.map((entry) => entry.id));
    if (page.nextCursor === undefined) break;
    expect(page.nextCursor).toBeGreaterThan(after);
    after = page.nextCursor;
  } while (after < 24);
  expect(seen).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
});

test("quote-heavy in-process activity tool pages obey their own byte budget across cursors", () => {
  const quoted = { ...input, data: { text: '"'.repeat(16_000) } };
  const rows = Array.from({ length: 32 }, (_, i) => row(i + 1, quoted));
  const seen: number[] = [];
  let after = 0;
  do {
    const f = log(port([[{ id: 32 }], rows.slice(after)]));
    const page = f.log.search({ worldId: "world", playerId: "player" }, { after, through: 32 });
    expect(page.through).toBe(32);
    expect(page.events.every((entry) => entry.activity.data.text === quoted.data.text)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(eventPageBytes);
    seen.push(...page.events.map((entry) => entry.id));
    if (page.nextCursor === undefined) break;
    expect(page.nextCursor).toBeGreaterThan(after);
    after = page.nextCursor;
  } while (after < 32);
  expect(seen).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
});

test("hook mutation and activity log use one transaction with rollback on recording failure", () => {
  const f = log(port([], 2));
  expect(() =>
    f.log.atomic(() => {
      f.db.prepare("manual hook mutation").run();
      f.log.appendActivity(
        activity(binding, "hisyo.hook_removed", { runId: "run", hookId: "hook" }, 100),
      );
    }),
  ).toThrow("storage failed");
  expect(f.transactions).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
});

test("reason batches commit completely or propagate failure and roll back", () => {
  const batch: RunRequest = {
    binding,
    initial: true,
    poll: true,
    playerMessages: ["one", "two"],
    hooks: [{ id: "hook", event: "block_broken", instruction: "respond", eventIds: [7, 9] }],
    observations: [
      {
        id: 8,
        observation: {
          ...binding,
          seq: 1,
          tick: 1,
          observedAt: 100,
          event: "advancement_completed",
          dimension: "minecraft:overworld",
          position: [0, 64, 0],
          data: {
            advancementId: "minecraft:story/mine_stone",
            criterion: "get_cobblestone",
            afterDone: true,
            hasDisplay: true,
          },
        },
      },
    ],
  };
  const records = runRequestActivities(batch, 100, "request");
  expect(records.map((entry) => entry.event)).toEqual([
    "hisyo.run_requested_initial",
    "hisyo.run_requested_poll",
    "hisyo.run_requested_player",
    "hisyo.run_requested_player",
    "hisyo.run_requested_hook",
    "hisyo.run_requested_hook",
    "hisyo.run_requested_advancement",
  ]);
  expect(records.map((entry) => entry.data)).toEqual([
    { requestId: "request" },
    { requestId: "request" },
    { requestId: "request", text: "one" },
    { requestId: "request", text: "two" },
    { requestId: "request", hookId: "hook", sourceEventId: 7 },
    { requestId: "request", hookId: "hook", sourceEventId: 9 },
    { requestId: "request", sourceEventId: 8 },
  ]);
  batch.observations[0]!.observation.data.hasDisplay = false;
  expect(runRequestActivities(batch, 100, "request").map((entry) => entry.event)).not.toContain(
    "hisyo.run_requested_advancement",
  );
  const f = log();
  f.log.appendActivities(records);
  expect(f.transactions).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  const failed = log(port([], 3));
  expect(() => failed.log.appendActivities(records)).toThrow("storage failed");
  expect(failed.transactions).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
  expect(failed.calls).toHaveLength(3);
});

test("only valid bound displayed:true ACKs become exact HUD facts", () => {
  const request = { ...binding, runId: "old-run", text: 'Literal 日本語 "\\n' };
  const ack = { ...binding, runId: "old-run", displayed: true };
  const f = log();
  for (const invalid of [
    undefined,
    { ...ack, displayed: false },
    { ...ack, runId: "new-run" },
    { ...ack, sessionId: "other" },
    { ...ack, extra: true },
  ])
    expect(() => f.log.appendActivity(displayedActivity(request, invalid, 100))).toThrow();
  expect(f.calls).toEqual([]);
  f.log.appendActivity(displayedActivity(request, ack, 100));
  expect(JSON.parse(f.calls[0]!.args[5] as string)).toEqual({
    ...binding,
    origin: "cli",
    recordedAt: 100,
    event: "hisyo.hud_displayed",
    data: { runId: "old-run", text: request.text },
  });
  expect(() => validateActivity({ ...input, position: [0, 0, 0] })).toThrow();
});

test("lifecycle activity log preserves initial false reports and FIFO facts without native event fiction", () => {
  const facts = [
    activity(binding, "hisyo.session_attached", { beforeAttachment: "unknown" }, 100),
    ...[false, true, false].map((paused, i) =>
      activity(binding, "hisyo.status_reported", { paused }, 101 + i),
    ),
    activity(
      binding,
      "hisyo.session_detached",
      {
        reason: "link_closed",
        afterLastObservation: "unknown",
      },
      104,
    ),
  ];
  const f = log();
  facts.forEach((fact, i) => {
    expect(f.log.appendActivity(fact)).toEqual({ id: i + 1, activity: fact });
    expect(f.calls[i]!.args.slice(3, 5)).toEqual([fact.event, fact.recordedAt]);
    expect(JSON.parse(f.calls[i]!.args[5] as string)).toEqual(fact);
    expect(f.calls[i]!.args).toHaveLength(6);
    for (const key of ["seq", "tick", "position", "dimension", "runId"])
      expect(fact).not.toHaveProperty(key);
  });
  expect(facts.slice(1, 4).map((fact) => fact.data)).toEqual([
    { paused: false },
    { paused: true },
    { paused: false },
  ]);
});

test("unknown lifecycle coverage is searchable across sessions and is not a numeric sequence gap", () => {
  const previous = activity(
    binding,
    "hisyo.session_detached",
    {
      reason: "bridge_shutdown",
      afterLastObservation: "unknown",
    },
    100,
  );
  const current = activity(
    { ...binding, sessionId: "next-session" },
    "hisyo.session_attached",
    { beforeAttachment: "unknown" },
    200,
  );
  const rows = [previous, current].map((fact, i) => ({
    ...row(i + 1, fact),
    session_id: fact.sessionId,
    event: fact.event,
    recorded_at: fact.recordedAt,
  }));
  const f = log(port([[{ id: 2 }], rows]));
  const first = f.log.search({ worldId: "world", playerId: "player" }, { limit: 1 });
  expect(first).toEqual({
    events: [{ id: 1, activity: previous }],
    through: 2,
    hasKnownGaps: false,
    nextCursor: 1,
  });
  expect(f.calls[1]!.args).toEqual(["world", "player", 0, 2, 2]);
  const next = log(port([[{ id: 2 }], [rows[1]!]]));
  expect(
    next.log.search(
      { worldId: "world", playerId: "player" },
      { after: first.nextCursor, through: first.through },
    ),
  ).toEqual({
    events: [{ id: 2, activity: current }],
    through: 2,
    hasKnownGaps: false,
  });
});

test("lifecycle schemas reject fabricated coverage, unsafe reasons and nonboolean reports before writes or decoding", () => {
  for (const [event, data] of [
    ["session_attached", { beforeAttachment: "complete" }],
    ["status_reported", { paused: "false" }],
    ["status_reported", { paused: false, before: false }],
    ["session_detached", { reason: "/private/token", afterLastObservation: "unknown" }],
    ["session_detached", { reason: "link_closed", afterLastObservation: "complete" }],
  ] as const) {
    const invalid = { ...input, event: `hisyo.${event}`, data };
    const f = log();
    expect(() => f.log.appendActivity(invalid)).toThrow();
    expect(f.calls).toEqual([]);
    const stored = { ...row(1, invalid), event: invalid.event };
    expect(() => log(port([[{ id: 1 }], [stored]])).log.search(binding)).toThrow();
  }
  activityCatalog.validateFilter("hisyo.status_reported", { paused: false });
  expect(() =>
    activityCatalog.validateFilter("hisyo.status_reported", { paused: "false" }),
  ).toThrow();
  expect(() => new EventCatalog(gameEventDefinitions).get("hisyo.session_attached")).toThrow();
});

test("lifecycle recording failures propagate without retry or fabricated successful rows", () => {
  const f = log(port([], 1));
  const fact = activity(
    binding,
    "hisyo.session_detached",
    {
      reason: "game_detached",
      afterLastObservation: "unknown",
    },
    100,
  );
  expect(() => f.log.appendActivity(fact)).toThrow("storage failed");
  expect(f.calls).toHaveLength(1);
  expect(f.transactions).toEqual([]);
});
