import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { initializeDatabase } from "./database.js";
import { initializeSummaryDatabase } from "./summaryDatabase.js";
import { expect, test, vi } from "vite-plus/test";
import observations from "../protocol/fixtures/observerEvents.json" with { type: "json" };
import { gameEventDefinitions, type GameEvent } from "../protocol/gameEvent.js";
import { historyContextBytes } from "../protocol/history.js";
import { EventCatalog } from "../events/eventCatalog.js";
import { EventLog } from "../events/eventLog.js";
import type { HistorySource } from "../events/compactHistory.js";
import { HistorySummaries } from "./historySummaries.js";

const sample: GameEvent = { ...observations[0]!, position: [2, 64, 0] };
const scope = { worldId: sample.worldId, playerId: sample.playerId };
const source: HistorySource = {
  after: 0,
  through: 10,
  sourceSessionId: "old-session",
  sourceCount: 10,
  firstObservedAt: 1,
  lastObservedAt: 100,
  input: "RAW_PROJECTION_NOT_CONTEXT",
};

function storedRow(overrides: Record<string, SQLOutputValue> = {}) {
  return {
    id: 1,
    world_id: scope.worldId,
    player_id: scope.playerId,
    source_after: source.after,
    source_through: source.through,
    source_json: JSON.stringify(source),
    summary: "stored summary",
    created_at: 200,
    model: "openai/gpt-6-luna",
    requested_tier: "fast",
    prompt_version: 1,
    ...overrides,
  };
}

/** Independent SQL capture ports, not a simulated SQLite durability claim. */
function fixture() {
  const rows: Record<string, SQLOutputValue>[] = [];
  const events: Record<string, SQLOutputValue>[] = [];
  const sql: string[] = [];
  const rawSql: string[] = [];
  const inserts: SQLInputValue[][] = [];
  let insertFailure: Error | undefined;
  let max = 100;
  const rawDb = {
    exec: () => {
      throw new Error("Summary must not start a raw-history transaction");
    },
    prepare: (text: string) => {
      rawSql.push(text);
      return {
        get: () => (text.includes("MAX(id)") ? { id: max } : { found: 0 }),
        all: (...params: SQLInputValue[]) =>
          events
            .filter(
              (row) => Number(row.id) > Number(params[2]) && Number(row.id) <= Number(params[3]),
            )
            .slice(0, Number(params.at(-1))),
      };
    },
  } as unknown as DatabaseSync;
  const db = {
    exec: (text: string) => {
      sql.push(text);
    },
    prepare: (text: string) => {
      sql.push(text);
      return {
        get: (...params: SQLInputValue[]) => {
          const scoped = rows.filter(
            (row) => row.world_id === params[0] && row.player_id === params[1],
          );
          return text.includes("source_after = ?")
            ? scoped.find((row) => row.source_after === params[2])
            : scoped.at(-1);
        },
        all: (...params: SQLInputValue[]) =>
          rows
            .filter((row) => row.world_id === params[0] && row.player_id === params[1])
            .toReversed()
            .slice(0, 5),
        run: (...params: SQLInputValue[]) => {
          if (insertFailure) throw insertFailure;
          inserts.push(params);
          const [
            world_id,
            player_id,
            source_after,
            source_through,
            source_json,
            summary,
            created_at,
            model = "openai/gpt-6-luna",
            requested_tier = "fast",
            prompt_version = 1,
          ] = params as [
            string,
            string,
            number,
            number,
            string,
            string,
            number,
            string?,
            string?,
            number?,
          ];
          rows.push({
            id: rows.length + 1,
            world_id,
            player_id,
            source_after,
            source_through,
            source_json,
            summary,
            created_at,
            model,
            requested_tier,
            prompt_version,
          });
        },
      };
    },
  } as unknown as DatabaseSync;
  const log = new EventLog(rawDb, new EventCatalog(gameEventDefinitions));
  return {
    history: new HistorySummaries(log, db),
    reopen: () => new HistorySummaries(log, db),
    log,
    db,
    rows,
    events,
    sql,
    rawSql,
    inserts,
    fail: (error: Error | undefined) => {
      insertFailure = error;
    },
    max: (id: number) => {
      max = id;
    },
  };
}

test("summary and cursor share one atomic insert, with explicit source provenance", () => {
  const f = fixture();
  expect(f.history.cursor(scope)).toBe(0);
  f.history.save(scope, source, "石を採掘した。", 200);
  expect(f.history.cursor(scope)).toBe(10);
  expect(f.inserts).toEqual([
    [scope.worldId, scope.playerId, 0, 10, JSON.stringify(source), "石を採掘した。", 200],
  ]);
  expect(f.sql).toContain("BEGIN IMMEDIATE");
  expect(f.sql).toContain("COMMIT");
  expect(() => f.history.save(scope, source, "duplicate", 201)).toThrow(
    "Stale history summary cursor",
  );
  expect(f.sql.at(-1)).toBe("ROLLBACK");
  expect(f.inserts).toHaveLength(1);
  expect(f.sql.join("\n")).not.toMatch(/\bevents\b|DELETE/);
  expect(f.rawSql.join("\n")).not.toMatch(/INSERT|BEGIN|COMMIT|ROLLBACK/);
});

test("opening memory performs no raw-history inspection or automatic import", () => {
  const f = fixture();
  f.reopen();
  expect(f.rawSql).toEqual([]);
  expect(f.sql).toEqual([]);
  expect(f.rows).toEqual([]);
});

test("invalid stored summary metadata or provenance fails before exposing memory", () => {
  for (const invalid of [
    { model: "other-model" },
    { requested_tier: "default" },
    { prompt_version: 2 },
    { created_at: -1 },
    { source_json: "{}" },
    { source_through: 11 },
    { summary: " " },
  ]) {
    const f = fixture();
    f.rows.push(storedRow(invalid));
    expect(() => f.history.cursor(scope)).toThrow();
    expect(() => f.history.context(scope)).toThrow();
    expect(f.inserts).toHaveLength(0);
  }
});

test("the raw event connection cannot double as the summary store", () => {
  const f = fixture();
  expect(() => new HistorySummaries(f.log, f.log.db)).toThrow(/separate/);
});

test("bad completion or failed insert never moves the stored cursor", () => {
  const f = fixture();
  for (const summary of [" ", "あ".repeat(401), `bad${String.fromCharCode(0)}text`])
    expect(() => f.history.save(scope, source, summary, 1)).toThrow();
  expect(f.inserts).toHaveLength(0);
  f.fail(new Error("storage failure"));
  expect(() => f.history.save(scope, source, "valid", 1)).toThrow("storage failure");
  expect(f.sql.at(-1)).toBe("ROLLBACK");
  expect(f.history.cursor(scope)).toBe(0);
});

test("context is latest, chronological, bounded history; source input never recursively enters it", () => {
  const f = fixture();
  expect(f.history.context(scope)).toBe("");
  for (let i = 0; i < 5; i++)
    f.history.save(
      scope,
      { ...source, after: i * 10, through: (i + 1) * 10 },
      `summary-${i + 1} ${"あ".repeat(390)}`,
      i,
    );
  f.max(51);
  const text = f.history.context(scope);
  expect(text).toContain("current snapshot wins");
  expect(text).toContain("Older summaries omitted");
  expect(text).toContain("not summarized yet");
  expect(text).not.toContain("summary-1");
  expect(text.indexOf("summary-2")).toBeLessThan(text.indexOf("summary-5"));
  expect(text).not.toContain(source.input);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(historyContextBytes);
  f.rows.at(-1)!.requested_tier = "default";
  expect(() => f.history.context(scope)).toThrow("Invalid stored history summary");
});

test("next spans filtered raw pages, consumes one session prefix, not the high-water fence", () => {
  const f = fixture();
  const filtered: GameEvent = {
    ...observations.find((entry) => entry.event === "structures_sampled")!,
    position: sample.position,
  };
  const search = vi.spyOn(f.log, "search");
  search.mockReturnValueOnce({
    events: [
      { id: 1, observation: filtered },
      { id: 2, observation: { ...filtered, seq: 2 } },
    ],
    through: 100,
    hasKnownGaps: false,
    nextCursor: 2,
  });
  search.mockReturnValueOnce({
    events: [{ id: 3, observation: { ...sample, seq: 3 } }],
    through: 100,
    hasKnownGaps: false,
    nextCursor: 3,
  });
  search.mockReturnValueOnce({
    events: [{ id: 4, observation: { ...sample, worldSessionId: "new-session" } }],
    through: 100,
    hasKnownGaps: false,
  });
  const next = f.history.next(scope)!;
  expect(next).toMatchObject({
    source: { after: 0, through: 3, sourceCount: 3, sourceSessionId: sample.worldSessionId },
    backlog: true,
  });
  expect(next.source.input).toContain("e3 block_broken");
  expect(next.source.input).not.toContain("structures_sampled");
  expect(search).toHaveBeenNthCalledWith(2, scope, { after: 2, through: 100, limit: 498 });
  expect(search).toHaveBeenNthCalledWith(3, scope, { after: 3, through: 100, limit: 497 });
});

test("legacy hidden nearby data is redacted by the existing decoder before summarization", () => {
  const f = fixture();
  const observation = observations.find((row) => row.event === "nearby_sampled")!;
  const { visibility: _visibility, ...data } = observation.data;
  const legacy = {
    ...observation,
    data: { ...data, blocks: [{ blockId: "minecraft:diamond_ore", position: [0, 10, 0] }] },
  };
  f.events.push({
    id: 1,
    observation_json: JSON.stringify(legacy),
    world_id: legacy.worldId,
    player_id: legacy.playerId,
    session_id: legacy.worldSessionId,
    event: legacy.event,
    seq: legacy.seq,
    observed_at: legacy.observedAt,
    gap_from: null,
    gap_to: null,
  });
  f.max(1);
  expect(f.history.next(scope)!.source.input).not.toContain("diamond_ore");
});

test("simplifies model input without changing raw storage or stalling filtered prefixes", () => {
  const raw = new DatabaseSync(":memory:");
  const summaries = new DatabaseSync(":memory:");
  try {
    initializeDatabase(raw);
    initializeSummaryDatabase(summaries);
    const log = new EventLog(raw, new EventCatalog(gameEventDefinitions));
    const history = new HistorySummaries(log, summaries);
    const structure: GameEvent = {
      ...observations.find((entry) => entry.event === "structures_sampled")!,
      position: sample.position,
    };
    const emptyEffects: GameEvent = {
      ...observations.find((entry) => entry.event === "status_effects_sampled")!,
      position: sample.position,
    };
    log.append({ ...structure, seq: 1, observedAt: 5000 });
    log.append({
      ...emptyEffects,
      seq: 2,
      observedAt: 900,
      data: { ...emptyEffects.data, effects: [], effectsTruncated: false },
    });
    const first = history.next(scope)!.source;
    expect(first).toMatchObject({
      after: 0,
      through: 2,
      sourceCount: 2,
      firstObservedAt: 900,
      lastObservedAt: 5000,
      sourceSessionId: sample.worldSessionId,
    });
    expect(first.input).toContain("No retained observations.");
    expect(first.input).not.toMatch(
      /structures_sampled|status_effects_sampled|Source session:|Observed ms range:/u,
    );
    history.save(scope, first, "保持対象の観測なし。", 6000);
    expect(history.cursor(scope)).toBe(2);
    expect(history.next(scope)).toBeUndefined();

    const inventory: GameEvent = {
      ...observations.find((entry) => entry.event === "inventory_slot_changed")!,
      position: sample.position,
    };
    log.append({ ...structure, seq: 3, observedAt: 7000 });
    const stored = log.append({ ...inventory, seq: 4, observedAt: 8000 });
    log.append({ ...structure, seq: 5, observedAt: 9000 });
    const before = raw.prepare("SELECT * FROM events ORDER BY id").all();
    const second = history.next(scope)!.source;
    expect(second).toMatchObject({
      after: 2,
      through: 5,
      sourceCount: 3,
      firstObservedAt: 7000,
      lastObservedAt: 9000,
    });
    expect(second.input).toContain("e2 inventory_slot_changed slot=0 itemId=air->stone count=0->3");
    expect(second.input).not.toContain("e4 inventory_slot_changed");
    expect(log.search(scope).events.find((entry) => entry.id === stored.id)).toEqual(stored);
    history.save(scope, second, "stoneをslot 0に3個所持。", 10000);
    expect(history.cursor(scope)).toBe(5);
    expect(history.next(scope)).toBeUndefined();
    expect(raw.prepare("SELECT * FROM events ORDER BY id").all()).toEqual(before);
    const saved = summaries
      .prepare("SELECT source_json FROM history_summaries ORDER BY id DESC LIMIT 1")
      .get()!;
    expect(JSON.parse(saved.source_json as string)).toEqual(second);
  } finally {
    summaries.close();
    raw.close();
  }
});
