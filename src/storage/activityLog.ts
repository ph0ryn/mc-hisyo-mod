import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { WorldScope } from "../protocol/gameEvent.js";
import { activityCatalog, validateActivity, type Activity } from "../events/activity.js";
import { eventPageBytes, searchLog, type EventSearch, type LogPage } from "./logSearch.js";

export interface StoredActivity {
  id: number;
  activity: Activity;
}

function decodeRow(row: Record<string, SQLOutputValue>): StoredActivity {
  if (
    typeof row.id !== "number" ||
    !Number.isSafeInteger(row.id) ||
    row.id < 1 ||
    typeof row.activity_json !== "string"
  )
    throw new Error("Invalid stored activity");
  const activity: unknown = JSON.parse(row.activity_json);
  validateActivity(activity);
  if (
    row.world_id !== activity.worldId ||
    row.player_id !== activity.playerId ||
    row.session_id !== activity.sessionId ||
    row.event !== activity.event ||
    row.recorded_at !== activity.recordedAt
  )
    throw new Error("Invalid stored activity metadata");
  return { id: row.id, activity };
}

/** CLI facts and hooks share this connection, never the Mod observation log. */
export class ActivityLog {
  constructor(readonly db: DatabaseSync) {}

  atomic<T>(mutate: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = mutate();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Activity transaction and rollback failed",
        );
      }
      throw error;
    }
  }

  appendActivity(activity: Activity): StoredActivity {
    validateActivity(activity);
    if (
      Buffer.byteLength(
        JSON.stringify({
          events: [{ id: Number.MAX_SAFE_INTEGER, activity }],
          through: Number.MAX_SAFE_INTEGER,
          hasKnownGaps: false,
          nextCursor: Number.MAX_SAFE_INTEGER,
        }),
      ) > eventPageBytes
    )
      throw new Error("Hisyo activity exceeds activity log page byte budget");
    const result = this.db
      .prepare(
        `INSERT INTO activities(world_id, player_id, session_id, event, recorded_at, activity_json) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        activity.worldId,
        activity.playerId,
        activity.sessionId,
        activity.event,
        activity.recordedAt,
        JSON.stringify(activity),
      );
    const id = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid stored activity cursor");
    return { id, activity: structuredClone(activity) };
  }

  appendActivities(activities: readonly Activity[]): void {
    if (!activities.length) return;
    this.atomic(() => {
      for (const activity of activities) this.appendActivity(activity);
    });
  }

  search(scope: WorldScope, options: EventSearch = {}): LogPage<StoredActivity> {
    return searchLog(this.db, activityCatalog, "activities", scope, options, decodeRow);
  }
}
