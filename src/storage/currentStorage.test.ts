import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { ActivityLog } from "./activityLog.js";
import { activity, validateActivity } from "../events/activity.js";
import { EventCatalog } from "../events/eventCatalog.js";
import { EventLog } from "./eventLog.js";
import observations from "../protocol/fixtures/gameEvents.json" with { type: "json" };
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import { initializeActivityDatabase } from "./activityDatabase.js";
import { initializeEventDatabase } from "./eventDatabase.js";
import { initializeSummaryDatabase } from "./summaryDatabase.js";

const binding = { worldId: "world", playerId: "player", sessionId: "session" };
const scope = { worldId: binding.worldId, playerId: binding.playerId };

for (const [name, initialize, expected] of [
  ["event log", initializeEventDatabase, ["events"]],
  ["activity log", initializeActivityDatabase, ["activities", "hooks"]],
  ["summary", initializeSummaryDatabase, ["summaries"]],
] as const) {
  test(`fresh ${name} persists only its canonical tables at version 1`, () => {
    const db = new DatabaseSync(":memory:");
    try {
      initialize(db);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
          .map(({ name }) => name),
      ).toEqual(expected);
      initialize(db);
      expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    } finally {
      db.close();
    }
  });
}

test("activity persistence exposes activity/recordedAt without fabricated Mod metadata", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeActivityDatabase(db);
    const activities = new ActivityLog(db);
    const record = activity(binding, "hisyo.player_input", { text: "canonical input" }, 123);
    expect(record).toEqual({
      ...binding,
      origin: "cli",
      event: "hisyo.player_input",
      recordedAt: 123,
      data: { text: "canonical input" },
    });
    const stored = activities.appendActivity(record);
    expect(stored).toEqual({ id: 1, activity: record });
    expect(
      db
        .prepare("PRAGMA table_info(activities)")
        .all()
        .map(({ name }) => name),
    ).toEqual([
      "id",
      "world_id",
      "player_id",
      "session_id",
      "event",
      "recorded_at",
      "activity_json",
    ]);
    expect(db.prepare("SELECT recorded_at, activity_json FROM activities").get()).toEqual({
      recorded_at: 123,
      activity_json: JSON.stringify(record),
    });
    expect(
      activities.search(scope, {
        since: 123,
        event: record.event,
        filter: { text: "canonical input" },
      }),
    ).toEqual({ events: [stored], through: 1, hasKnownGaps: false });
    expect(activities.search(scope, { since: 124 }).events).toEqual([]);
    const { recordedAt: _recordedAt, ...withoutTime } = record as unknown as Record<
      string,
      unknown
    >;
    expect(() => validateActivity({ ...withoutTime, observedAt: 123 })).toThrow();
  } finally {
    db.close();
  }
});

for (const [event, field] of [
  ["nearby_sampled", "visibility"],
  ["advancement_criterion_granted", "hasDisplay"],
  ["advancement_completed", "hasDisplay"],
] as const) {
  test(`invalid current ${event} rows fail before exposure, without rewriting stored payloads`, () => {
    const db = new DatabaseSync(":memory:");
    try {
      initializeEventDatabase(db);
      const catalog: EventCatalog = new EventCatalog(gameEventDefinitions);
      const log = new EventLog(db, catalog);
      const sample: unknown = structuredClone(observations.find((entry) => entry.event === event)!);
      catalog.validateObservation(sample);
      delete sample.data[field];
      db.prepare(
        "INSERT INTO events(world_id, player_id, session_id, seq, event, observed_at, observation_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        sample.worldId,
        sample.playerId,
        sample.sessionId,
        sample.seq,
        event,
        sample.observedAt,
        JSON.stringify(sample),
      );
      const before = db.prepare("SELECT * FROM events").all();
      expect(() => log.search({ worldId: sample.worldId, playerId: sample.playerId })).toThrow(
        /Invalid data/,
      );
      expect(() => log.append({ ...sample, seq: sample.seq + 1 })).toThrow(/Invalid data/);
      expect(db.prepare("SELECT * FROM events").all()).toEqual(before);
    } finally {
      db.close();
    }
  });
}
