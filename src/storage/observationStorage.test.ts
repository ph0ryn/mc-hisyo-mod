import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import observations from "../protocol/fixtures/gameEvents.json" with { type: "json" };
import { ActivityLog } from "./activityLog.js";
import { activity } from "../events/activity.js";
import { EventCatalog } from "../events/eventCatalog.js";
import { EventLog } from "./eventLog.js";
import { HookStore } from "./hookStore.js";
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import { initializeActivityDatabase } from "./activityDatabase.js";
import { SummaryStore } from "./summaryStore.js";
import { initializeSummaryDatabase } from "./summaryDatabase.js";
import { initializeEventDatabase } from "./eventDatabase.js";

const observation = observations[0]!;

test("observation schema rejects CLI records even through direct SQL", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeEventDatabase(db);
    const record = activity(observation, "hisyo.player_input", { text: "CLI_ONLY_SENTINEL" });
    expect(() =>
      db
        .prepare(`INSERT INTO events
        (world_id, player_id, session_id, seq, event, observed_at, observation_json)
        VALUES (?, ?, ?, NULL, ?, ?, ?)`)
        .run(
          record.worldId,
          record.playerId,
          record.sessionId,
          record.event,
          record.recordedAt,
          JSON.stringify(record),
        ),
    ).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()!.count).toBe(0);
  } finally {
    db.close();
  }
});

test("observation database creates no hook or summary tables", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeEventDatabase(db);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    expect(tables.map((row) => row.name)).toEqual(["events"]);
  } finally {
    db.close();
  }
});

test("independent persisted activities, HUD speech and hooks never enter observation-derived summaries", () => {
  const rawDb = new DatabaseSync(":memory:");
  const activityDb = new DatabaseSync(":memory:");
  const summaryDb = new DatabaseSync(":memory:");
  try {
    initializeEventDatabase(rawDb);
    initializeActivityDatabase(activityDb);
    initializeSummaryDatabase(summaryDb);
    const catalog = new EventCatalog(gameEventDefinitions);
    const scope = { worldId: observation.worldId, playerId: observation.playerId };
    const log = new EventLog(rawDb, catalog);
    const activities = new ActivityLog(activityDb);
    const hooks = new HookStore(activityDb, catalog);
    const summaries = new SummaryStore(log, summaryDb);
    const entry = log.append({ ...observation, seq: 1, position: [2, 64, 0] });
    activities.appendActivity(
      activity(observation, "hisyo.player_input", { text: "CLI_ONLY_SENTINEL" }),
    );
    activities.appendActivity(
      activity(observation, "hisyo.hud_displayed", {
        runId: "run",
        text: "HUD_ONLY_SENTINEL: HP full",
      }),
    );
    activities.atomic(() => {
      const hook = hooks.add(scope, {
        event: observation.event,
        instruction: "HOOK_ONLY_SENTINEL",
      });
      activities.appendActivity(
        activity(observation, "hisyo.hook_added", {
          runId: "run",
          hookId: hook.id,
          event: hook.event,
          filter: hook.filter,
          instruction: hook.instruction,
        }),
      );
    });
    const { source } = summaries.next(scope)!;
    expect(source).toMatchObject({ after: 0, through: entry.id, sourceCount: 1 });
    expect(source.input).toContain(observation.event);
    expect(source.input).not.toMatch(/CLI_ONLY|HUD_ONLY|HOOK_ONLY|HP full|hisyo\./);
    expect(log.search(scope).events).toEqual([entry]);
    expect(activities.search(scope).events).toHaveLength(3);
    expect(activities.search(scope).through).toBe(3);
    const before = rawDb.prepare("SELECT * FROM events").all();
    summaries.save(scope, source, "観測した操作を記録した。", 200);
    expect(summaries.cursor(scope)).toBe(entry.id);
    expect(summaries.next(scope)).toBeUndefined();
    expect(rawDb.prepare("SELECT * FROM events").all()).toEqual(before);
    expect(activities.search(scope).events).toHaveLength(3);
    expect(hooks.list(scope).hooks).toHaveLength(1);
  } finally {
    summaryDb.close();
    activityDb.close();
    rawDb.close();
  }
});
