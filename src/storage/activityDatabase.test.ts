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

test("real activity SQLite owns only activities and hooks at independent version 1", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeActivityDatabase(db);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(tables(db)).toEqual([{ name: "activities" }, { name: "hooks" }]);
    const insert = db.prepare(
      "INSERT INTO activities(world_id,player_id,session_id,event,recorded_at,activity_json) VALUES ('world','player','session','hisyo.player_input',100,?)",
    );
    insert.run("{}");
    expect(() => insert.run("invalid JSON")).toThrow();
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
    initializeActivityDatabase(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM activities").get()?.count).toBe(1);
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
    db.exec("CREATE TABLE hooks (preserved TEXT); INSERT INTO hooks VALUES ('original')");
    expect(() => initializeActivityDatabase(db)).toThrow();
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
    expect(tables(db)).toEqual([{ name: "hooks" }]);
    expect(db.prepare("SELECT preserved FROM hooks").get()?.preserved).toBe("original");
    db.exec("DROP TABLE hooks");
    initializeActivityDatabase(db);
    expect(tables(db)).toEqual([{ name: "activities" }, { name: "hooks" }]);
  } finally {
    db.close();
  }
});
