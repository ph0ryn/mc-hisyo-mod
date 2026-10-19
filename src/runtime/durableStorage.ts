import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SessionBinding } from "../protocol/bridge.js";
import { PrivateDataDirectory } from "./privateDataDirectory.js";

function code(error: unknown, expected: string): boolean {
  return error instanceof Error && "code" in error && error.code === expected;
}

/** A new format/location: old Pi JSONL is neither inspected nor changed. */
export async function openDurableStorage(dataDirectory: string, session: SessionBinding) {
  const root = new PrivateDataDirectory(dataDirectory);
  const scopes = new PrivateDataDirectory(join(root.path, "durable"));
  const hash = createHash("sha256")
    .update(JSON.stringify([session.worldId, session.playerId]))
    .digest("hex");
  const scope = new PrivateDataDirectory(join(scopes.path, hash));
  const lockPath = join(scope.path, "owner.lock");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (!code(error, "EEXIST")) throw error;
    const previous = lstatSync(lockPath, { bigint: true });
    if (
      !previous.isFile() ||
      previous.uid !== BigInt(process.getuid!()) ||
      (previous.mode & 0o777n) !== 0o600n ||
      previous.nlink !== 1n
    )
      throw new Error("Durable owner lock must be an owned regular 0600 file");
    const pidText = readFileSync(lockPath, "utf8");
    if (!/^[1-9][0-9]*\n$/.test(pidText))
      throw new Error(
        "Malformed durable owner lock; confirm ownership before removing it manually",
      );
    const pid = Number(pidText.trim());
    if (!Number.isSafeInteger(pid)) throw new Error("Invalid durable owner PID");
    try {
      process.kill(pid, 0);
    } catch (ownerError) {
      if (!code(ownerError, "ESRCH")) throw ownerError;
      // Only this validated, dead owner's unchanged lock is removed. A competing reopen loses safely.
      scope.removeOwned(lockPath, previous);
      descriptor = openSync(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
    }
    if (descriptor === undefined) throw new Error("Durable conversation already has a live owner");
  }
  const ownedDescriptor = descriptor;
  const identity = fstatSync(ownedDescriptor, { bigint: true });
  const path = join(scope.path, "conversation.sqlite");
  const assertCurrent = () => {
    root.assertCurrent();
    scopes.assertCurrent();
    scope.assertCurrent();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        const stat = lstatSync(`${path}${suffix}`, { bigint: true });
        if (
          !stat.isFile() ||
          stat.uid !== identity.uid ||
          (stat.mode & 0o777n) !== 0o600n ||
          stat.nlink !== 1n
        )
          throw new Error("Durable SQLite paths must be owned regular 0600 files with one link");
      } catch (error) {
        if (!code(error, "ENOENT")) throw error;
      }
    }
  };
  let released = false;
  const release = () => {
    if (released) return;
    root.assertCurrent();
    scopes.assertCurrent();
    scope.assertCurrent();
    try {
      scope.removeOwned(lockPath, identity);
    } finally {
      closeSync(ownedDescriptor);
      released = true;
    }
  };
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  try {
    writeFileSync(ownedDescriptor, `${process.pid}\n`);
    assertCurrent();
    storage = await openNodeSqliteStorage(path);
    assertCurrent();
    return { storage, path, assertCurrent, release };
  } catch (error) {
    try {
      await storage?.close(BACKGROUND_CONTEXT);
      release();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Durable storage setup and cleanup failed");
    }
    throw error;
  }
}
