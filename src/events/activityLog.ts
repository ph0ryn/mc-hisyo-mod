import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { WorldScope } from "../protocol/gameEvent.js";
import {
  directorActivityCatalog,
  validateDirectorActivity,
  type DirectorActivity,
} from "./directorActivity.js";
import {
  eventPageBytes,
  searchHistory,
  type EventSearch,
  type HistoryPage,
} from "./historySearch.js";

export interface StoredActivity {
  id: number;
  observation: DirectorActivity;
}

function decodeRow(row: Record<string, SQLOutputValue>): StoredActivity {
  if (
    typeof row.id !== "number" ||
    !Number.isSafeInteger(row.id) ||
    row.id < 1 ||
    typeof row.observation_json !== "string"
  )
    throw new Error("Invalid stored activity");
  const observation: unknown = JSON.parse(row.observation_json);
  validateDirectorActivity(observation);
  if (
    row.world_id !== observation.worldId ||
    row.player_id !== observation.playerId ||
    row.session_id !== observation.worldSessionId ||
    row.event !== observation.event ||
    row.observed_at !== observation.observedAt ||
    row.seq !== null ||
    row.gap_from !== null ||
    row.gap_to !== null
  )
    throw new Error("Invalid stored activity metadata");
  return { id: row.id, observation };
}

/** CLI facts and response hooks share this connection, never the Mod observation log. */
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

  appendActivity(observation: DirectorActivity): StoredActivity {
    validateDirectorActivity(observation);
    if (
      Buffer.byteLength(
        JSON.stringify({
          events: [{ id: Number.MAX_SAFE_INTEGER, observation }],
          through: Number.MAX_SAFE_INTEGER,
          hasKnownGaps: false,
          nextCursor: Number.MAX_SAFE_INTEGER,
        }),
      ) > eventPageBytes
    )
      throw new Error("Director activity exceeds history page byte budget");
    const result = this.db
      .prepare(
        `INSERT INTO events(world_id, player_id, session_id, seq, event, observed_at, observation_json, gap_from, gap_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        observation.worldId,
        observation.playerId,
        observation.worldSessionId,
        null,
        observation.event,
        observation.observedAt,
        JSON.stringify(observation),
        null,
        null,
      );
    const id = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid stored event cursor");
    return { id, observation: structuredClone(observation) };
  }

  appendActivities(observations: readonly DirectorActivity[]): void {
    if (!observations.length) return;
    this.atomic(() => {
      for (const observation of observations) this.appendActivity(observation);
    });
  }

  search(scope: WorldScope, options: EventSearch = {}): HistoryPage<StoredActivity> {
    return searchHistory(this.db, directorActivityCatalog, scope, options, decodeRow);
  }
}
