import { DatabaseSync } from "node:sqlite";
import { expect, onTestFinished, test } from "vite-plus/test";
import observations from "../protocol/fixtures/gameEvents.json" with { type: "json" };
import { gameEventDefinitions, type GameEvent } from "../protocol/gameEvent.js";
import { summaryContextBytes, summaryInputBytes } from "../protocol/summary.js";
import { EventCatalog } from "../events/eventCatalog.js";
import type { SummarySource } from "../events/summaryInput.js";
import { initializeEventDatabase } from "./eventDatabase.js";
import { initializeSummaryDatabase } from "./summaryDatabase.js";
import { EventLog } from "./eventLog.js";
import { SummaryStore } from "./summaryStore.js";

const sample = observations.find((row) => row.event === "block_broken")!;
const scope = { worldId: sample.worldId, playerId: sample.playerId };
function fixture() {
  const raw = new DatabaseSync(":memory:");
  const db = new DatabaseSync(":memory:");
  initializeEventDatabase(raw);
  initializeSummaryDatabase(db);
  onTestFinished(() => {
    db.close();
    raw.close();
  });
  const log = new EventLog(raw, new EventCatalog(gameEventDefinitions));
  const summaries = new SummaryStore(log, db);
  const sequences = new Map<string, number>();
  const append = (at: number, event = "block_broken", changes: Partial<GameEvent> = {}) => {
    const observation: GameEvent = {
      ...observations.find((row) => row.event === event)!,
      position: [2, 64, 0],
      observedAt: at,
      ...changes,
    };
    const key = JSON.stringify([observation.worldId, observation.playerId, observation.sessionId]);
    observation.seq = (sequences.get(key) ?? 0) + 1;
    sequences.set(key, observation.seq);
    return log.append(observation);
  };
  return {
    raw,
    db,
    log,
    summaries,
    append,
    next: (now = 600_000) => summaries.next(scope, now)?.source,
    save: (source: SummarySource, text = "石を採掘した。") =>
      summaries.save(scope, source, text, 900_000),
    reopen: () => new SummaryStore(log, db),
  };
}

test("latest completed minute wins, then history drains newest to oldest", () => {
  const f = fixture();
  f.append(1_000);
  f.append(61_000);
  f.append(121_000);
  f.append(180_000); // The current open minute must wait.
  for (const minuteStart of [120_000, 60_000, 0]) {
    const source = f.next(185_000)!;
    expect(source).toMatchObject({ minuteStart, sourceCount: 1 });
    expect(source.firstObservedAt).toBeGreaterThanOrEqual(minuteStart);
    expect(source.lastObservedAt).toBeLessThan(minuteStart + 60_000);
    f.save(source);
  }
  expect(f.next(239_999)).toBeUndefined();
  expect(f.next(240_000)).toMatchObject({ minuteStart: 180_000, eventIds: [4] });
});

test("half-open minute boundaries and empty spans require no fabricated batches", () => {
  const f = fixture();
  expect(f.next(0)).toBeUndefined();
  f.append(59_999);
  f.append(60_000);
  expect(f.next(59_999)).toBeUndefined();
  const first = f.next(60_000)!;
  expect(first.eventIds).toEqual([1]);
  f.save(first);
  expect(f.next(119_999)).toBeUndefined();
  const second = f.next(120_000)!;
  expect(second.eventIds).toEqual([2]);
  f.save(second);
  expect(f.next(10_000_000)).toBeUndefined();
});

test("exact coverage survives interleaved timestamps, late arrivals, other scopes and reopen", () => {
  const f = fixture();
  f.append(121_000);
  f.append(1_000);
  f.append(122_000);
  f.append(200_000, "block_broken", { playerId: "other-player" });
  const latest = f.next(180_000)!;
  expect(latest.eventIds).toEqual([1, 3]);
  f.save(latest);
  expect(f.reopen().next(scope, 180_000)?.source.eventIds).toEqual([2]);
  f.append(123_000); // Late observation for a previously processed minute.
  const late = f.next(180_000)!;
  expect(late.eventIds).toEqual([5]);
  f.save(late);
  const older = f.next(180_000)!;
  expect(older.eventIds).toEqual([2]);
  f.save(older);
  expect(f.reopen().next(scope, 180_000)).toBeUndefined();
});

test("a new completed minute outranks remaining history after each save", () => {
  const f = fixture();
  f.append(1_000);
  f.append(61_000);
  const latest = f.next(120_000)!;
  f.save(latest);
  const backfill = f.next(120_000)!;
  expect(backfill.minuteStart).toBe(0);
  f.append(121_000);
  f.save(backfill);
  expect(f.next(180_000)?.minuteStart).toBe(120_000);
});

test("500-row, input-byte and source-session caps leave the rest of the same minute eligible", () => {
  const f = fixture();
  f.append(1_000);
  for (let i = 0; i < 501; i++) f.append(61_000);
  f.append(62_000, "block_broken", { sessionId: "second-session" });
  const first = f.next(120_000)!;
  expect(first).toMatchObject({ minuteStart: 60_000, sourceCount: 500 });
  f.save(first);
  const second = f.next(120_000)!;
  expect(second).toMatchObject({ minuteStart: 60_000, sourceCount: 1, eventIds: [502] });
  f.save(second);
  const third = f.next(120_000)!;
  expect(third).toMatchObject({
    minuteStart: 60_000,
    sourceCount: 1,
    sourceSessionId: "second-session",
  });
  f.save(third);
  expect(f.next(120_000)?.minuteStart).toBe(0);

  const bytes = fixture();
  for (let i = 0; i < 500; i++) bytes.append(61_000, "block_broken", { position: [i, 64, 0] });
  const bounded = bytes.next(120_000)!;
  expect(bounded.sourceCount).toBeLessThan(500);
  expect(Buffer.byteLength(bounded.input)).toBeLessThanOrEqual(summaryInputBytes);
  bytes.save(bounded);
  expect(bytes.next(120_000)?.minuteStart).toBe(60_000);
});

test("bounded raw transport pages can be combined without including a later minute", () => {
  const f = fixture();
  const nearby = observations.find((row) => row.event === "nearby_sampled")!;
  for (let i = 0; i < 60; i++)
    f.append(61_000, "nearby_sampled", {
      data: {
        ...nearby.data,
        blocks: Array.from({ length: 729 }, (_, n) => ({
          blockId: "minecraft:stone",
          position: [n, 64, 0],
        })),
      },
    });
  f.append(120_000);
  const source = f.next(120_000)!;
  expect(source).toMatchObject({ sourceCount: 60, through: 60, minuteStart: 60_000 });
  f.save(source);
  expect(f.next(120_000)).toBeUndefined();
});

test("summary text and coverage commit together; invalid or failed inserts do not consume events", () => {
  const f = fixture();
  f.append(1_000);
  const source = f.next()!;
  const before = f.raw.prepare("SELECT * FROM events").all();
  for (const text of [" ", "あ".repeat(401), `bad${String.fromCharCode(0)}text`])
    expect(() => f.save(source, text)).toThrow();
  f.db.exec(
    "CREATE TRIGGER fail_summary BEFORE INSERT ON summaries BEGIN SELECT RAISE(ABORT, 'storage failure'); END",
  );
  expect(() => f.save(source)).toThrow("storage failure");
  expect(f.next()).toEqual(source);
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM summaries").get()!.count).toBe(0);
  f.db.exec("DROP TRIGGER fail_summary");
  f.save(source);
  expect(f.next()).toBeUndefined();
  expect(() => f.save(source)).toThrow(/overlap|stale/i);
  expect(f.raw.prepare("SELECT * FROM events").all()).toEqual(before);
  const storedSource = JSON.parse(
    f.db.prepare("SELECT source_json FROM summaries").get()!.source_json as string,
  );
  expect(storedSource).not.toHaveProperty("input");
  expect({ ...storedSource, input: source.input }).toEqual(source);
});

test("legacy v1 range summaries remain valid coverage without migration or rewriting", () => {
  const f = fixture();
  for (const time of [1_000, 61_000, 121_000]) f.append(time);
  const legacy: SummarySource = {
    after: 0,
    through: 2,
    sourceSessionId: sample.sessionId,
    sourceCount: 2,
    firstObservedAt: 1_000,
    lastObservedAt: 61_000,
    input: "legacy raw projection",
  };
  f.save(legacy, "legacy summary");
  // Reproduce the old payload independently of the current save implementation.
  f.db.prepare("UPDATE summaries SET source_json = ?").run(JSON.stringify(legacy));
  const before = f.db.prepare("SELECT * FROM summaries").get();
  initializeSummaryDatabase(f.db);
  const next = f.reopen().next(scope, 180_000)!.source;
  expect(next.eventIds).toEqual([3]);
  f.save(next);
  expect(f.next(180_000)).toBeUndefined();
  expect(f.db.prepare("PRAGMA user_version").get()!.user_version).toBe(1);
  expect(f.db.prepare("SELECT * FROM summaries WHERE id = 1").get()).toEqual(before);
});

test.each([true, false])(
  "stored exact-ID coverage works with legacy input present=%s",
  (hasInput) => {
    const f = fixture();
    f.append(1_000);
    f.append(61_000);
    const source = f.next(120_000)!;
    expect(source.input).toContain("Observed event log");
    f.save(source, "saved minute");
    f.db.prepare("UPDATE summaries SET source_json = ?").run(JSON.stringify(source));
    if (!hasInput) {
      const cleanup = f.db.prepare(
        "UPDATE summaries SET source_json = json_remove(source_json, '$.input') WHERE json_type(source_json, '$.input') IS NOT NULL",
      );
      expect(cleanup.run().changes).toBe(1);
      expect(cleanup.run().changes).toBe(0);
      const metadata = JSON.parse(
        f.db.prepare("SELECT source_json FROM summaries").get()!.source_json as string,
      );
      expect(metadata).not.toHaveProperty("input");
      expect({ ...metadata, input: source.input }).toEqual(source);
    }
    const before = f.db.prepare("SELECT * FROM summaries").all();
    const reopened = f.reopen();
    expect(reopened.context(scope)).toContain("saved minute");
    const next = reopened.next(scope, 120_000)!.source;
    expect(next.eventIds).toEqual([1]);
    expect(next.input).toContain("Observed event log");
    expect(f.db.prepare("SELECT * FROM summaries").all()).toEqual(before);
  },
);

test.each([
  ["model", "other-model"],
  ["requested_tier", "default"],
  ["prompt_version", 2],
  ["created_at", -1],
  ["source_json", "{}"],
  ["source_through", 99],
  ["summary", " "],
])("invalid stored %s fails closed before selection and context", (column, value) => {
  const f = fixture();
  f.append(1_000);
  f.save(f.next()!);
  f.db.prepare(`UPDATE summaries SET ${column} = ?`).run(value);
  expect(() => f.next()).toThrow();
  expect(() => f.summaries.context(scope)).toThrow();
});

test("invalid explicit coverage metadata cannot consume or hide source rows", () => {
  for (const changes of [
    { eventIds: [1, 1] },
    { eventIds: [0] },
    { eventIds: [2] },
    { minuteStart: 1 },
    { sourceCount: 2 },
  ]) {
    const f = fixture();
    f.append(1_000);
    const source = f.next()!;
    expect(() => f.save({ ...source, ...changes })).toThrow(/source/i);
    expect(f.next()).toEqual(source);
  }
  const f = fixture();
  f.append(1_000);
  const partial = f.next()!;
  delete partial.minuteStart;
  expect(() => f.save(partial)).toThrow(/source/i);
});

test("main context uses target time rather than backfill insertion order and never includes source input", () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) f.append(i * 60_000 + 1_000);
  expect(f.summaries.context(scope)).toBe("");
  for (let i = 5; i >= 0; i--) {
    const source = f.next(360_000)!;
    f.save(source, `minute-${i} ${"あ".repeat(390)}`);
  }
  f.append(360_001); // The latest open minute is deliberately still unsummarized.
  const text = f.summaries.context(scope);
  expect(text).toContain("current snapshot wins");
  expect(text).toContain("Older summaries omitted");
  expect(text).toContain("not summarized yet");
  expect(text).not.toContain("minute-0");
  expect(text).not.toContain("minute-1");
  expect(text.indexOf("minute-2")).toBeLessThan(text.indexOf("minute-5"));
  expect(text).not.toContain("Observed event log");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(summaryContextBytes);
});

test("invalid nearby data fails without rewriting observations", () => {
  const f = fixture();
  f.append(1_000, "nearby_sampled");
  const row = f.raw.prepare("SELECT observation_json FROM events").get()!;
  const bad = JSON.parse(row.observation_json as string);
  delete bad.data.visibility;
  f.raw.prepare("UPDATE events SET observation_json = ?").run(JSON.stringify(bad));
  const before = f.raw.prepare("SELECT * FROM events").all();
  expect(() => f.next()).toThrow(/Invalid data/);
  expect(f.raw.prepare("SELECT * FROM events").all()).toEqual(before);
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM summaries").get()!.count).toBe(0);
});

test("filtered projections still advance exact coverage and preserve raw storage", () => {
  const f = fixture();
  f.append(5_000, "structures_sampled");
  f.append(900, "status_effects_sampled", {
    data: {
      ...observations.find((row) => row.event === "status_effects_sampled")!.data,
      effects: [],
      effectsTruncated: false,
    },
  });
  const first = f.next()!;
  expect(first).toMatchObject({ firstObservedAt: 900, lastObservedAt: 5_000, eventIds: [1, 2] });
  expect(first.input).toContain("No retained observations.");
  f.save(first);
  expect(f.next()).toBeUndefined();
  f.append(7_000, "structures_sampled");
  const inventory = f.append(8_000, "inventory_slot_changed");
  f.append(9_000, "structures_sampled");
  const before = f.raw.prepare("SELECT * FROM events").all();
  const second = f.next()!;
  expect(second.input).toContain("e2 inventory_slot_changed slot=0 itemId=air->stone count=0->3");
  expect(f.log.search(scope).events.find((entry) => entry.id === inventory.id)).toEqual(inventory);
  f.save(second);
  expect(f.next()).toBeUndefined();
  expect(f.raw.prepare("SELECT * FROM events").all()).toEqual(before);
  expect(() => new SummaryStore(f.log, f.raw)).toThrow(/separate/);
});
