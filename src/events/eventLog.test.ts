import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vite-plus/test";
import type { DirectorBridge } from "../bridge/directorBridge.js";
import { maxPiFrameBytes } from "../pi/piFraming.js";
import { defaultMaxFrameBytes } from "../transport/jsonLines.js";
import { JudgmentScheduler } from "../runtime/judgmentScheduler.js";
import type { JudgmentBatch } from "../runtime/judgmentQueue.js";
import { startPiSession } from "../runtime/piSession.js";

vi.mock("../runtime/piSession.js", () => ({ startPiSession: vi.fn() }));
import { Type } from "typebox";
import { initializeDatabase } from "../storage/database.js";
import {
  activity,
  displayedActivity,
  directorActivityCatalog,
  judgmentActivities,
  validateDirectorActivity,
} from "./directorActivity.js";
import { eventPageBytes } from "./eventLog.js";
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import { EventCatalog } from "./eventCatalog.js";
import { EventLog } from "./eventLog.js";

const binding = { worldId: "world", playerId: "player", worldSessionId: "session" };
const input = {
  ...binding,
  origin: "cli" as const,
  observedAt: 100,
  event: "director.player_input",
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
    session_id: binding.worldSessionId,
    event: input.event,
    observed_at: input.observedAt,
    seq: null,
    observation_json: JSON.stringify(observation),
    gap_from: null,
    gap_to: null,
  };
}

test("CLI activity persists without a fabricated Mod sequence or game coordinates", () => {
  const f = log();
  expect(f.log.appendActivity(input)).toEqual({ id: 1, observation: input });
  expect(f.calls[0]?.args[3]).toBeNull();
  expect(JSON.parse(f.calls[0]!.args[6] as string)).toEqual(input);
});

test("history decodes previous-session CLI records alongside game history", () => {
  const f = log(port([[{ id: 1 }], [row(1)], [{ found: 1 }]]));
  expect(f.log.search({ worldId: "world", playerId: "player" })).toEqual({
    events: [{ id: 1, observation: input }],
    through: 1,
    hasKnownGaps: true,
  });
});

test("stored CLI corruption fails rather than inventing game observations", () => {
  for (const observation of [
    { ...input, seq: 1 },
    { ...input, origin: "game" },
    { ...input, data: { text: 1 } },
    { ...input, tick: 1 },
    { ...input, event: "director.unknown" },
  ]) {
    const f = log(port([[{ id: 1 }], [row(1, observation)], [{ found: 0 }]]));
    expect(() => f.log.search({ worldId: "world", playerId: "player" })).toThrow();
  }
});

test("every current Director activity fits individually at maximum escaped text and binding sizes", () => {
  const id = "\u0000".repeat(128);
  const text = "\u0000".repeat(16_000);
  const maxBinding = { worldId: id, playerId: id, worldSessionId: id };
  const samples: [string, Record<string, unknown>][] = [
    ["player_input", { text }],
    ["hud_displayed", { runId: id, text }],
    [
      "hook_added",
      { runId: id, hookId: id, event: "block_broken", filter: { blockId: id }, instruction: text },
    ],
    ["hook_removed", { runId: id, hookId: id }],
    ["hook_matched", { hookId: id, sourceEventId: Number.MAX_SAFE_INTEGER }],
    ["judgment_requested_initial", { requestId: id }],
    ["judgment_requested_poll", { requestId: id }],
    ["judgment_requested_player", { requestId: id, text }],
    [
      "judgment_requested_hook",
      { requestId: id, hookId: id, sourceEventId: Number.MAX_SAFE_INTEGER },
    ],
  ];
  expect(samples).toHaveLength(directorActivityCatalog.list().length);
  const f = log();
  for (const [event, data] of samples) {
    const stored = f.log.appendActivity(
      activity(maxBinding, `director.${event}`, data, Number.MAX_SAFE_INTEGER),
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
    { ...input, observedAt: -1 },
    { ...input, data: { text: "x", extra: true } },
  ])
    expect(() => f.log.appendActivity(invalid)).toThrow();
  expect(f.calls).toEqual([]);
});

test("one shared history preserves game sequence and gap semantics", () => {
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
  f.log.appendActivity(input);
  expect(f.log.append(game)).toEqual({
    id: 2,
    observation: game,
    missingSequencesBefore: { from: 2, to: 2 },
  });
  const storedGame = { ...row(2, game), seq: 3, event: game.event, gap_from: 2, gap_to: 2 };
  const search = log(port([[{ id: 2 }], [row(1), storedGame], [{ found: 1 }]]));
  expect(search.log.search({ worldId: "world", playerId: "player" }).events).toEqual([
    { id: 1, observation: input },
    { id: 2, observation: game, missingSequencesBefore: { from: 2, to: 2 } },
  ]);
  expect(() => new EventCatalog(gameEventDefinitions).validateObservation(input)).toThrow();
});

test("byte-bounded escaped-text pages resume without loss or duplication", () => {
  const large = { ...input, data: { text: "\u0000".repeat(16_000) } };
  const rows = Array.from({ length: 24 }, (_, i) => row(i + 1, large));
  const seen: number[] = [];
  let after = 0;
  do {
    const f = log(port([[{ id: 24 }], rows.slice(after), [{ found: 1 }]]));
    const page = f.log.search(
      { worldId: "world", playerId: "player" },
      { event: input.event, filter: { text: large.data.text }, after, through: 24, limit: 500 },
    );
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(eventPageBytes);
    expect(page.hasKnownGaps).toBe(true);
    expect(page.events.every((entry) => entry.observation.data.text === large.data.text)).toBe(
      true,
    );
    expect(f.calls[1]!.args.slice(0, 4)).toEqual(["world", "player", after, 24]);
    expect(f.calls[2]!.args).toEqual(["world", "player", 24]);
    seen.push(...page.events.map((entry) => entry.id));
    if (page.nextCursor === undefined) break;
    expect(page.nextCursor).toBeGreaterThan(after);
    after = page.nextCursor;
  } while (after < 24);
  expect(seen).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
});

test("quote-heavy history pages fit TCP and native Pi tool results across cursors", () => {
  const quoted = { ...input, data: { text: '"'.repeat(16_000) } };
  const rows = Array.from({ length: 32 }, (_, i) => row(i + 1, quoted));
  const seen: number[] = [];
  let after = 0;
  do {
    const f = log(port([[{ id: 32 }], rows.slice(after), [{ found: 0 }]]));
    const page = f.log.search({ worldId: "world", playerId: "player" }, { after, through: 32 });
    expect(page.through).toBe(32);
    expect(page.events.every((entry) => entry.observation.data.text === quoted.data.text)).toBe(
      true,
    );
    expect(
      Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: "9007199254740991", result: page })),
    ).toBeLessThan(defaultMaxFrameBytes);
    // Existing extension result and installed Pi's native tool_execution_end emitter.
    const toolEnd = {
      type: "tool_execution_end",
      toolCallId: "history-call",
      toolName: "get_recent_events",
      result: { content: [{ type: "text", text: JSON.stringify(page) }], details: page },
      isError: false,
      durationMs: 1,
    };
    expect(Buffer.byteLength(JSON.stringify(toolEnd))).toBeLessThanOrEqual(maxPiFrameBytes);
    seen.push(...page.events.map((entry) => entry.id));
    if (page.nextCursor === undefined) break;
    expect(page.nextCursor).toBeGreaterThan(after);
    after = page.nextCursor;
  } while (after < 32);
  expect(seen).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
});

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

test("history filters retain scalar type-sensitive AND parameters", () => {
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
    directorActivityCatalog.validateFilter("director.hook_matched", { sourceEventId: "1" }),
  ).toThrow();
});

test("hook mutation and history use one transaction with rollback on recording failure", () => {
  const f = log(port([], 2));
  expect(() =>
    f.log.atomic(() => {
      f.db.prepare("manual hook mutation").run();
      f.log.appendActivity(
        activity(binding, "director.hook_removed", { runId: "run", hookId: "hook" }, 100),
      );
    }),
  ).toThrow("storage failed");
  expect(f.transactions).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
});

test("reason batches commit completely or propagate failure and roll back", () => {
  const batch = {
    binding,
    worldStart: true,
    poll: true,
    playerMessages: ["one", "two"],
    hooks: [{ id: "hook", event: "block_broken", instruction: "respond", eventIds: [7, 9] }],
    observations: [],
  };
  const records = judgmentActivities(batch, 100, "request");
  expect(records.map((entry) => entry.event)).toEqual([
    "director.judgment_requested_initial",
    "director.judgment_requested_poll",
    "director.judgment_requested_player",
    "director.judgment_requested_player",
    "director.judgment_requested_hook",
    "director.judgment_requested_hook",
  ]);
  expect(records.map((entry) => entry.data)).toEqual([
    { requestId: "request" },
    { requestId: "request" },
    { requestId: "request", text: "one" },
    { requestId: "request", text: "two" },
    { requestId: "request", hookId: "hook", sourceEventId: 7 },
    { requestId: "request", hookId: "hook", sourceEventId: 9 },
  ]);
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
    { ...ack, worldSessionId: "other" },
    { ...ack, extra: true },
  ])
    expect(() => f.log.appendActivity(displayedActivity(request, invalid, 100))).toThrow();
  expect(f.calls).toEqual([]);
  f.log.appendActivity(displayedActivity(request, ack, 100));
  expect(JSON.parse(f.calls[0]!.args[6] as string)).toEqual({
    ...binding,
    origin: "cli",
    observedAt: 100,
    event: "director.hud_displayed",
    data: { runId: "old-run", text: request.text },
  });
  expect(() => validateDirectorActivity({ ...input, position: [0, 0, 0] })).toThrow();
});

test("schema 0 creates v2 nullable-seq events; v2 reopens without table changes", () => {
  const fresh = port([[{ user_version: 0 }]]);
  initializeDatabase(fresh.db);
  expect(fresh.transactions[1]).toContain("seq INTEGER CHECK(seq IS NULL OR seq > 0)");
  expect(fresh.transactions[1]).toContain("PRAGMA user_version = 2;");
  const current = port([[{ user_version: 2 }]]);
  initializeDatabase(current.db);
  expect(current.transactions).toHaveLength(1);
});

test("actual scheduler stores request reasons before judge and stops on storage failure", async () => {
  for (const failRunAt of [0, 1]) {
    const f = log(port([], failRunAt));
    const order: string[] = [];
    const bridge = Object.assign(new EventEmitter(), {
      readyWorld: { binding, supportedEvents: ["block_broken"], paused: false },
      handlePlayerMessages: () => () => {},
    });
    bridge.on("judgmentRequested", (batch: JudgmentBatch) => {
      f.log.appendActivities(judgmentActivities(batch, 100, "request"));
      order.push("history");
    });
    const session = Object.assign(new EventEmitter(), {
      judge: vi.fn(async () => {
        order.push("judge");
        return { status: "settled" };
      }),
      close: vi.fn(async () => {}),
    });
    vi.mocked(startPiSession).mockResolvedValue(
      session as unknown as Awaited<ReturnType<typeof startPiSession>>,
    );
    const scheduler = new JudgmentScheduler({
      bridge: bridge as unknown as DirectorBridge,
      dataDirectory: "/unused",
      monotonicNow: () => 0,
      executable: "never-launched",
      bundledExtension: "/unused/directorBridge.mjs",
      connection: { protocolVersion: 1, host: "127.0.0.1", port: 1, token: "unused", pid: 1 },
      model: { provider: "test-provider", id: "test-model", apiKey: "unused" },
    });
    const faults: Error[] = [];
    scheduler.on("fault", (error) => faults.push(error));
    try {
      // Drain finite promise continuations, with no timers or elapsed-time assertion.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(order).toEqual(failRunAt ? [] : ["history", "judge"]);
      expect(faults).toHaveLength(failRunAt ? 1 : 0);
      expect(f.transactions).toEqual(["BEGIN IMMEDIATE", failRunAt ? "ROLLBACK" : "COMMIT"]);
      expect(JSON.parse(f.calls[0]!.args[6] as string).event).toBe(
        "director.judgment_requested_initial",
      );
    } finally {
      await scheduler.close();
    }
  }
});

test("v1 and unknown schema versions fail before even write-affecting PRAGMAs", () => {
  for (const version of [1, 3, -1, 99, "2", null]) {
    const p = port([[{ user_version: version }]]);
    expect(() => initializeDatabase(p.db)).toThrow("Preserve the existing database");
    expect(p.transactions).toEqual([]);
  }
});
