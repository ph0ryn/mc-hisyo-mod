import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc } from "@earendil-works/pi-durable";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, onTestFinished, test } from "vite-plus/test";
import { openDurableStorage } from "./durableStorage.js";

const binding = { worldId: "world", playerId: "player", sessionId: "one" };
const State = defineDoc({
  kind: "app.storageBoundary",
  version: 1,
  scope: "session",
  initial: () => ({ count: 0 }),
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "hisyo-storage-test-"));
  onTestFinished(() => {
    if (!path.startsWith(join(tmpdir(), "hisyo-storage-test-")))
      throw new Error("unexpected cleanup target");
    rmSync(path, { recursive: true });
  });
  return path;
}
async function open(path: string, session = binding) {
  const files = await openDurableStorage(path, session);
  const kernel = createSession(files.storage);
  return {
    ...files,
    kernel,
    async close() {
      await kernel.close(BACKGROUND_CONTEXT);
      files.release();
    },
  };
}

test("SQLite scope is world/player stable across attachments, private, and separately owned", async () => {
  const path = directory();
  const first = await open(path);
  await first.kernel.commit(async (tx) => {
    (await tx.doc(State)).count = 3;
  }, BACKGROUND_CONTEXT);
  expect(statSync(first.path).mode & 0o777).toBe(0o600);
  await expect(open(path)).rejects.toThrow(/live owner/);
  await first.close();
  const next = await open(path, { ...binding, sessionId: "two" });
  expect(next.path).toBe(first.path);
  expect(await next.kernel.snapshot(State, BACKGROUND_CONTEXT)).toEqual({ count: 3 });
  const other = await open(path, { ...binding, playerId: "other" });
  expect(other.path).not.toBe(first.path);
  expect(await other.kernel.snapshot(State, BACKGROUND_CONTEXT)).toBeUndefined();
  await other.close();
  await next.close();
});

test("new Durable location never reads, repairs, migrates or deletes old JSONL state", async () => {
  const path = directory();
  const old = join(path, "pi");
  mkdirSync(old, { mode: 0o700 });
  const conversation = join(old, "conversation.jsonl");
  writeFileSync(conversation, "deliberately not valid JSONL\n", { mode: 0o600 });
  const current = await open(path);
  await current.close();
  expect(readFileSync(conversation, "utf8")).toBe("deliberately not valid JSONL\n");
});

test("SQLite WAL and dead-owner lease recover committed documents after an actual process crash", async () => {
  const path = directory();
  const first = await open(path);
  const database = first.path;
  await first.close();
  const script = `
    import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
    import { createSession, defineDoc } from '@earendil-works/pi-durable';
    import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
    import { writeFileSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    const path = process.argv[1];
    writeFileSync(join(dirname(path), 'owner.lock'), process.pid + '\\n', { flag: 'wx', mode: 0o600 });
    const storage = await openNodeSqliteStorage(path);
    const kernel = createSession(storage);
    const State = defineDoc({kind:'app.storageBoundary',version:1,scope:'session',initial:()=>({count:0})});
    await kernel.commit(async tx => { (await tx.doc(State)).count = 17; }, BACKGROUND_CONTEXT);
    process.kill(process.pid, 'SIGKILL');
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", script, database], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(crashed.error).toBeUndefined();
  expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
  const recovered = await open(path);
  expect(await recovered.kernel.snapshot(State, BACKGROUND_CONTEXT)).toEqual({ count: 17 });
  await recovered.close();
});

test("existing symlinked SQLite files fail closed without touching the external target", async () => {
  const path = directory();
  const initial = await open(path);
  const database = initial.path;
  await initial.close();
  // Use a different world scope, precreate its owned parent using the public adapter, then replace its DB.
  const second = await open(path, { ...binding, worldId: "other" });
  const target = second.path;
  await second.close();
  const expected = join(dirname(target), "conversation.sqlite");
  if (target !== expected || !target.includes("/durable/"))
    throw new Error("unexpected database replacement target");
  rmSync(target);
  symlinkSync(database, target);
  await expect(open(path, { ...binding, worldId: "other" })).rejects.toThrow(/owned regular/);
  expect(statSync(database).isFile()).toBe(true);
});
