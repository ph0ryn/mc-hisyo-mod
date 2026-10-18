import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { PrivateDataDirectory } from "./privateDataDirectory.js";

test("all three private SQLite files and sidecars reject unsafe permissions and symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "director-private-summary-"));
  const originalUmask = process.umask();
  try {
    const directory = new PrivateDataDirectory(join(root, "data"));
    expect(directory.summaryDatabasePath).toBe(join(directory.path, "summaries.sqlite"));
    expect(directory.activityDatabasePath).toBe(join(directory.path, "activities.sqlite"));
    for (const base of [
      directory.databasePath,
      directory.activityDatabasePath,
      directory.summaryDatabasePath,
    ]) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        const path = `${base}${suffix}`;
        writeFileSync(path, "", { mode: 0o600 });
        directory.assertStorageFiles();
        chmodSync(path, 0o644);
        expect(() => directory.assertStorageFiles()).toThrow(/0600/);
        chmodSync(path, 0o600);
        const extraLink = join(root, "extra-link");
        linkSync(path, extraLink);
        expect(() => directory.assertStorageFiles()).toThrow(/single link/);
        rmSync(extraLink);
        // All targets are known direct children of this disposable test directory.
        rmSync(path);
        symlinkSync(join(root, "absent"), path);
        expect(() => directory.assertStorageFiles()).toThrow(/regular/);
        rmSync(path);
      }
    }
  } finally {
    process.umask(originalUmask);
    // root is the exact private mkdtemp directory created by this test.
    rmSync(root, { recursive: true, force: true });
  }
});
