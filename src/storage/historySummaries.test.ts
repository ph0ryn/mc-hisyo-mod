import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
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

test("next spans raw transport pages, consumes one session prefix, not the high-water fence", () => {
  const f = fixture();
  const search = vi.spyOn(f.log, "search");
  search.mockReturnValueOnce({
    events: [
      { id: 1, observation: sample },
      { id: 2, observation: { ...sample, seq: 2 } },
    ],
    through: 100,
    hasKnownGaps: false,
    nextCursor: 2,
  });
  search.mockReturnValueOnce({
    events: [{ id: 3, observation: { ...sample, worldSessionId: "new-session" } }],
    through: 100,
    hasKnownGaps: false,
  });
  expect(f.history.next(scope)).toMatchObject({
    source: { after: 0, through: 2, sourceCount: 2, sourceSessionId: sample.worldSessionId },
    backlog: true,
  });
  expect(search).toHaveBeenNthCalledWith(2, scope, { after: 2, through: 100, limit: 498 });
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
