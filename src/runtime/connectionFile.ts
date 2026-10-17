import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import type { protocolVersion } from "../protocol/bridge.js";
import type { PrivateDataDirectory } from "./privateDataDirectory.js";

export interface ConnectionInfo {
  protocolVersion: typeof protocolVersion;
  host: "127.0.0.1";
  port: number;
  token: string;
  pid: number;
}

/** Exclusive hard-link publication never replaces another process's discovery. */
export class ConnectionFile {
  readonly #directory: PrivateDataDirectory;
  readonly #temporary: string;
  #identity: BigIntStats | undefined;
  #fd: number | undefined;
  #published = false;
  #closed = false;

  constructor(directory: PrivateDataDirectory) {
    directory.assertDiscoveryAbsent();
    this.#directory = directory;
    this.#temporary = join(directory.path, `.connection-${randomUUID()}.tmp`);
  }

  publish(connection: ConnectionInfo): void {
    if (this.#identity || this.#closed) throw new Error("Connection discovery is already used");
    this.#directory.assertCurrent();
    const fd = openSync(
      this.#temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    // Keep this inode alive through cleanup: POSIX permits reuse after its last reference closes.
    this.#fd = fd;
    this.#identity = fstatSync(fd, { bigint: true });
    writeFileSync(fd, `${JSON.stringify(connection)}\n`, "utf8");
    fsyncSync(fd);
    this.#directory.assertCurrent();
    linkSync(this.#temporary, this.#directory.connectionPath);
    this.#published = true;
    this.#directory.removeOwned(this.#temporary, this.#identity);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const paths = this.#published
      ? [this.#directory.connectionPath, this.#temporary]
      : [this.#temporary];
    const errors: unknown[] = [];
    try {
      if (this.#identity)
        for (const path of paths) {
          try {
            this.#directory.removeOwned(path, this.#identity);
          } catch (error) {
            errors.push(error);
          }
        }
    } finally {
      if (this.#fd !== undefined) {
        try {
          closeSync(this.#fd);
        } catch (error) {
          errors.push(error);
        }
        this.#fd = undefined;
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Could not close owned connection discovery");
  }
}
