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

/** Version 1 cannot represent truthful CLI-origin facts. Deliberately no migration. */
export function initializeDatabase(db: Pick<DatabaseSync, "prepare" | "exec">): void {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (typeof version !== "number" || (version !== 0 && version !== 2))
    throw new Error(
      "Unsupported database schema: expected version 2. Preserve the existing database and select a new empty data directory; automatic migration is not supported.",
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
}
