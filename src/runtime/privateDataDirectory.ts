import { lstatSync, mkdirSync, realpathSync, unlinkSync, type BigIntStats } from "node:fs";
import { dirname, join, resolve } from "node:path";

type FileIdentity = Pick<BigIntStats, "dev" | "ino" | "uid">;

function sameIdentity(actual: FileIdentity, expected: FileIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.uid === expected.uid;
}

function optionalStat(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Process-startup helper: tightens umask; never repairs existing permissions. */
export class PrivateDataDirectory {
  readonly path: string;
  readonly databasePath: string;
  readonly connectionPath: string;
  readonly #identity: FileIdentity;

  constructor(path: string) {
    const uid = process.getuid?.();
    if (uid === undefined)
      throw new Error("Private discovery currently requires POSIX permissions.");
    if (!path.trim()) throw new Error("Choose a nonempty --data-dir path.");
    process.umask(0o077);
    const requested = resolve(path);
    try {
      mkdirSync(requested, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const stat = lstatSync(requested, { bigint: true });
    if (!stat.isDirectory() || stat.uid !== BigInt(uid) || (stat.mode & 0o777n) !== 0o700n)
      throw new Error(
        "Use a real, owned 0700 data directory; existing permissions are not changed.",
      );
    this.path = realpathSync(requested);
    this.#identity = stat;
    this.databasePath = join(this.path, "history.sqlite");
    this.connectionPath = join(this.path, "connection.json");
    this.assertCurrent();
  }

  assertCurrent(): void {
    const stat = lstatSync(this.path, { bigint: true });
    if (
      realpathSync(this.path) !== this.path ||
      !stat.isDirectory() ||
      !sameIdentity(stat, this.#identity) ||
      (stat.mode & 0o777n) !== 0o700n
    )
      throw new Error("Data directory changed; refusing to access replacement paths.");
  }

  assertDiscoveryAbsent(): void {
    this.assertCurrent();
    if (optionalStat(this.connectionPath))
      throw new Error(
        "connection.json already exists. Stop the owning Director; remove stale discovery manually only after confirming it has stopped.",
      );
  }

  assertStorageFiles(): void {
    this.assertCurrent();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const stat = optionalStat(`${this.databasePath}${suffix}`);
      if (
        stat &&
        (!stat.isFile() ||
          stat.uid !== this.#identity.uid ||
          (stat.mode & 0o777n) !== 0o600n ||
          stat.nlink !== 1n)
      )
        throw new Error("SQLite paths must be owned regular 0600 files with a single link.");
    }
  }

  removeOwned(path: string, identity: FileIdentity): void {
    this.assertCurrent();
    if (resolve(path) !== path || dirname(path) !== this.path)
      throw new Error("Refusing to remove a path outside the canonical data directory.");
    const stat = optionalStat(path);
    if (!stat) return;
    if (!stat.isFile() || !sameIdentity(stat, identity))
      throw new Error("Refusing to remove replaced connection discovery; left untouched.");
    unlinkSync(path);
  }
}
