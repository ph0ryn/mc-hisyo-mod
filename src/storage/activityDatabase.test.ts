import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { initializeActivityDatabase } from "./activityDatabase.js";

function tables(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
}

test("real activity SQLite owns only CLI events and hooks at independent version 1", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeActivityDatabase(db);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(tables(db)).toEqual([{ name: "events" }, { name: "response_hooks" }]);
    const insert = db.prepare(
      "INSERT INTO events(world_id,player_id,session_id,seq,event,observed_at,observation_json,gap_from,gap_to) VALUES ('world','player','session',?,'director.player_input',100,'{}',?,?)",
    );
    insert.run(null, null, null);
    for (const [seq, from, to] of [
      [1, null, null],
      [0, null, null],
      [-1, null, null],
      [null, 1, null],
      [null, null, 1],
    ] as const)
      expect(() => insert.run(seq, from, to)).toThrow();
    initializeActivityDatabase(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(1);
  } finally {
    db.close();
  }
});

test("activity schema rejects unsupported versions without altering data or schemas", () => {
  for (const version of [2, 3, 4, 99]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('original'); PRAGMA user_version = ${version}; PRAGMA synchronous = OFF`,
      );
      expect(() => initializeActivityDatabase(db)).toThrow("Preserve the existing database");
      expect(db.prepare("PRAGMA synchronous").get()?.synchronous).toBe(0);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
      expect(db.prepare("SELECT value FROM preserved").all()).toEqual([{ value: "original" }]);
      expect(tables(db)).toEqual([{ name: "preserved" }]);
    } finally {
      db.close();
    }
  }
});

test("activity schema initialization rolls back partial DDL and permits an explicit repair retry", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE response_hooks (preserved TEXT); INSERT INTO response_hooks VALUES ('original')",
    );
    expect(() => initializeActivityDatabase(db)).toThrow();
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
    expect(tables(db)).toEqual([{ name: "response_hooks" }]);
    expect(db.prepare("SELECT preserved FROM response_hooks").get()?.preserved).toBe("original");
    db.exec("DROP TABLE response_hooks");
    initializeActivityDatabase(db);
    expect(tables(db)).toEqual([{ name: "events" }, { name: "response_hooks" }]);
  } finally {
    db.close();
  }
});
