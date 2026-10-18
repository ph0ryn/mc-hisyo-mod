import { DatabaseSync } from "node:sqlite";

type ActivityDatabase = Pick<DatabaseSync, "prepare" | "exec">;

export function openActivityDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    initializeActivityDatabase(db);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Activity startup and cleanup failed");
    }
    throw error;
  }
}

/** Independent CLI activity schema. Existing mixed history must be split explicitly. */
export function initializeActivityDatabase(db: ActivityDatabase): void {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (version !== 0 && version !== 1)
    throw new Error(
      "Unsupported activity database schema: expected version 1. Preserve the existing database.",
    );
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 1000;");
  if (version === 1) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        world_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER CHECK(seq IS NULL),
        event TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        observation_json TEXT NOT NULL CHECK(json_valid(observation_json)),
        gap_from INTEGER CHECK(gap_from IS NULL),
        gap_to INTEGER CHECK(gap_to IS NULL)
      ) STRICT;
      CREATE INDEX events_scope ON events(world_id, player_id, id);
      CREATE INDEX events_kind ON events(world_id, player_id, event, id);
      CREATE TABLE response_hooks (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        event TEXT NOT NULL,
        filter_json TEXT NOT NULL CHECK(json_valid(filter_json)),
        instruction TEXT NOT NULL
      ) STRICT;
      CREATE INDEX hooks_scope ON response_hooks(world_id, player_id, event);
      PRAGMA user_version = 1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Activity initialization and rollback failed",
      );
    }
    throw error;
  }
}
