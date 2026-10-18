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

/** Raw v2 and legacy v3 are compatible; legacy summary tables remain untouched. */
export function initializeDatabase(db: Pick<DatabaseSync, "prepare" | "exec">): void {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (typeof version !== "number" || ![0, 2, 3].includes(version))
    throw new Error(
      "Unsupported database schema: expected raw version 2 or legacy version 3. Preserve the existing database and select a compatible data directory; version 1 migration is not supported.",
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
