import { DatabaseSync } from "node:sqlite";

/** No event-specific tables: adding event payloads requires no storage migration. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    initializeDatabase(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Version 1 cannot represent truthful CLI-origin facts; only the additive v2 upgrade is supported. */
export function initializeDatabase(db: Pick<DatabaseSync, "prepare" | "exec">): void {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (typeof version !== "number" || ![0, 2, 3].includes(version))
    throw new Error(
      "Unsupported database schema: expected version 3 (or upgradeable version 2). Preserve the existing database and select a compatible data directory; version 1 migration is not supported.",
    );
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 1000;");
  if (version === 0) {
    db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          world_id TEXT NOT NULL,
          player_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          seq INTEGER CHECK(seq IS NULL OR seq > 0),
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
        CREATE TABLE response_hooks (
          id TEXT PRIMARY KEY,
          world_id TEXT NOT NULL,
          player_id TEXT NOT NULL,
          event TEXT NOT NULL,
          filter_json TEXT NOT NULL CHECK(json_valid(filter_json)),
          instruction TEXT NOT NULL
        ) STRICT;
        CREATE INDEX hooks_scope ON response_hooks(world_id, player_id, event);
        PRAGMA user_version = 2;
        COMMIT;
      `);
  }
  if (version === 0 || version === 2) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE history_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          world_id TEXT NOT NULL,
          player_id TEXT NOT NULL,
          source_after INTEGER NOT NULL CHECK(source_after >= 0),
          source_through INTEGER NOT NULL CHECK(source_through > source_after),
          source_json TEXT NOT NULL CHECK(json_valid(source_json)),
          summary TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          model TEXT NOT NULL,
          requested_tier TEXT NOT NULL,
          prompt_version INTEGER NOT NULL,
          UNIQUE(world_id, player_id, source_after)
        ) STRICT;
        CREATE INDEX history_summaries_scope ON history_summaries(world_id, player_id, id);
        PRAGMA user_version = 3;
        COMMIT;
      `);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "History schema upgrade and rollback failed",
        );
      }
      throw error;
    }
  }
}
