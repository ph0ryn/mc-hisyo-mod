import { DatabaseSync } from "node:sqlite";

/** No event-specific tables: adding event payloads requires no storage migration. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    initializeDatabase(db);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Observation startup and cleanup failed");
    }
    throw error;
  }
}

/** Raw history is Mod observations only. Mixed legacy databases require an explicit split. */
export function initializeDatabase(db: Pick<DatabaseSync, "prepare" | "exec">): void {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (version !== 0 && version !== 4)
    throw new Error(
      "Unsupported observation database schema: expected version 4. Preserve the existing database; automatic migration is not supported.",
    );
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 1000;");
  if (version === 4) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        world_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK(seq > 0),
        event TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        observation_json TEXT NOT NULL CHECK(json_valid(observation_json)),
        gap_from INTEGER,
        gap_to INTEGER,
        UNIQUE(world_id, player_id, session_id, seq)
      ) STRICT;
      CREATE INDEX events_scope ON events(world_id, player_id, id);
      CREATE INDEX events_kind ON events(world_id, player_id, event, id);
      CREATE INDEX events_gaps ON events(world_id, player_id, id) WHERE gap_from IS NOT NULL;
      PRAGMA user_version = 4;
    `);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Observation initialization and rollback failed",
      );
    }
    throw error;
  }
}
