import { DatabaseSync } from "node:sqlite";

type SummaryDatabase = Pick<DatabaseSync, "prepare" | "exec">;

export function openSummaryDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    initializeSummaryDatabase(db);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Summary startup and cleanup failed");
    }
    throw error;
  }
}

/** Summary writes never acquire event log or activity log transactions. */
export function summaryTransaction<T>(db: SummaryDatabase, mutate: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = mutate();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Summary transaction and rollback failed");
    }
    throw error;
  }
}

/** Summaries have an independent schema/version and connection lifecycle. */
export function initializeSummaryDatabase(db: SummaryDatabase): void {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (version !== 0 && version !== 1)
    throw new Error(
      "Unsupported summary database schema: expected version 1. Preserve the existing database.",
    );
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 1000;");
  if (version === 0)
    summaryTransaction(db, () => {
      db.exec(`
      CREATE TABLE summaries (
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
      CREATE INDEX summaries_scope ON summaries(world_id, player_id, id);
      PRAGMA user_version = 1;
    `);
    });
}
