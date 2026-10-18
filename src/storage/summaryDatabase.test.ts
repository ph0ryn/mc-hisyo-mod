import type { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { initializeSummaryDatabase } from "./summaryDatabase.js";

function port(version: unknown, failure?: string, rollbackFailure = false) {
  const sql: string[] = [];
  return {
    sql,
    db: {
      prepare: () => ({ get: () => ({ user_version: version }) }),
      exec: (text: string) => {
        sql.push(text);
        if (failure && text.includes(failure)) throw new Error("schema failure");
        if (rollbackFailure && text === "ROLLBACK") throw new Error("rollback failure");
      },
    } as unknown as DatabaseSync,
  };
}

test("summary schema has its own version 1 and never creates raw tables", () => {
  const f = port(0);
  initializeSummaryDatabase(f.db);
  const sql = f.sql.join("\n");
  expect(sql).toContain("CREATE TABLE history_summaries");
  expect(sql).toContain("PRAGMA user_version = 1");
  expect(sql).not.toMatch(/CREATE TABLE (events|response_hooks)/);
  expect(f.sql).toContain("BEGIN IMMEDIATE");
  expect(f.sql.at(-1)).toBe("COMMIT");
  const current = port(1);
  initializeSummaryDatabase(current.db);
  expect(current.sql).toHaveLength(1);
});

test("unsupported summary versions fail before write-affecting PRAGMAs", () => {
  for (const version of [2, 3, -1, "1", null]) {
    const f = port(version);
    expect(() => initializeSummaryDatabase(f.db)).toThrow(/Unsupported summary/);
    expect(f.sql).toEqual([]);
  }
});

test("failed summary schema creation rolls back and retains rollback failure", () => {
  const f = port(0, "CREATE TABLE");
  expect(() => initializeSummaryDatabase(f.db)).toThrow("schema failure");
  expect(f.sql.at(-1)).toBe("ROLLBACK");
  const both = port(0, "CREATE TABLE", true);
  expect(() => initializeSummaryDatabase(both.db)).toThrow(AggregateError);
});
