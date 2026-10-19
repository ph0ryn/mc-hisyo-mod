import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import lockfile from "proper-lockfile";
import { HisyoConfigError, validEnvName } from "./hisyoConfig.js";

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
export function environmentKey(
  name: string,
  readEnv: (name: string) => string | undefined,
): string {
  if (!validEnvName.test(name)) throw new HisyoConfigError("credential");
  const key = readEnv(name);
  if (!nonempty(key)) throw new HisyoConfigError("key");
  return key;
}
function validate(value: unknown): Credential | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) throw new HisyoConfigError("credential");
  if (
    value.type === "oauth" &&
    nonempty(value.access) &&
    nonempty(value.refresh) &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires)
  )
    return value as Credential;
  if (
    value.type === "api_key" &&
    nonempty(value.key) &&
    Object.keys(value).every((field) => field === "type" || field === "key")
  ) {
    const variable = /^\$\{([^{}]*)\}$/.exec(value.key);
    if (
      variable
        ? validEnvName.test(variable[1]!)
        : !value.key.trimStart().startsWith("!") && !value.key.includes("${")
    )
      return value as Credential;
  }
  throw new HisyoConfigError("credential");
}

/**
 * Restricted original Pi auth.json store. The released SDK does not publicly export its
 * file store, so use Pi's same proper-lockfile protocol; Models still owns all OAuth.
 * No credential resolver or command runner is involved in reading this file.
 */
export class PiCredentialStore implements CredentialStore {
  private readonly authPath: string;
  private closed = false;
  private mutationFailed = false;
  private readonly pending = new Set<Promise<unknown>>();

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.pending.size) await Promise.allSettled(this.pending);
    if (this.mutationFailed) throw new HisyoConfigError("authentication");
  }

  constructor(
    authPath: string,
    private readonly readEnv = (name: string) => process.env[name],
  ) {
    this.authPath = resolve(authPath);
  }

  private async data(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(this.authPath, "utf8");
    } catch (error) {
      if (object(error) && error.code === "ENOENT") return {};
      throw new HisyoConfigError("read");
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new HisyoConfigError("json");
    }
    if (!object(value)) throw new HisyoConfigError("credential");
    return value;
  }

  private locked<T>(
    fn: (data: Record<string, unknown>, checkLock: () => void) => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new HisyoConfigError("authentication"));
    return this.track(
      this.withLock(fn, options).catch((error: unknown) => {
        if (error instanceof HisyoConfigError) throw error;
        throw new HisyoConfigError("authentication");
      }),
    );
  }

  private async withLock<T>(
    fn: (data: Record<string, unknown>, checkLock: () => void) => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    let release: (() => Promise<void>) | undefined;
    let compromised = false;
    try {
      options?.signal?.throwIfAborted();
      // Pi and this adapter must lock exactly the same pathname, not a symlink alias.
      try {
        if ((await realpath(this.authPath)) !== this.authPath)
          throw new HisyoConfigError("credential");
      } catch (error) {
        if (!object(error) || error.code !== "ENOENT") throw error;
        if ((await realpath(dirname(this.authPath))) !== dirname(this.authPath))
          throw new HisyoConfigError("credential");
      }
      const pending = this.track(
        lockfile
          .lock(this.authPath, {
            realpath: false,
            stale: 30_000,
            retries: { retries: 30, minTimeout: 10, maxTimeout: 1_000, randomize: true },
            onCompromised: () => {
              compromised = true;
            },
          })
          .then(async (unlock) => {
            if (options?.signal?.aborted) {
              await unlock();
              options.signal.throwIfAborted();
            }
            return unlock;
          }),
      );
      release = options?.signal
        ? await raceWithAbortSignal(pending, options.signal)
        : await pending;
      const checkLock = () => {
        if (compromised) throw new HisyoConfigError("authentication");
      };
      checkLock();
      // Once the callback starts, cancellation must not discard a rotated OAuth grant.
      const result = await fn(await this.data(), checkLock);
      checkLock();
      return result;
    } finally {
      if (release) await release();
    }
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (providerId !== "openai") return undefined;
    return this.locked<Credential | undefined>(async (data) => {
      const value = validate(data.openai);
      if (value?.type !== "api_key") return value;
      const key = value.key!;
      const variable = /^\$\{([^{}]*)\}$/.exec(key);
      return {
        type: "api_key",
        key: variable ? environmentKey(variable[1]!, this.readEnv) : key,
      };
    }, options);
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (providerId !== "openai") throw new HisyoConfigError("credential");
    if (this.mutationFailed) throw new HisyoConfigError("authentication");
    return this.locked(async (data, checkLock) => {
      const current = validate(data.openai);
      if (this.mutationFailed) throw new HisyoConfigError("authentication");
      try {
        const next = await fn(current);
        if (next === undefined) return current;
        validate(next);
        checkLock();
        const temporary = `${this.authPath}.${randomUUID()}.tmp`;
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(JSON.stringify({ ...data, openai: next }, null, 2));
            await file.sync();
          } finally {
            await file.close();
          }
          checkLock();
          await rename(temporary, this.authPath);
        } finally {
          await rm(temporary, { force: true });
        }
        return next;
      } catch {
        // A caller may already have cancelled while refresh/rotation continued in the SDK.
        // Keep a non-secret fault so close cannot hide uncertain credential persistence.
        this.mutationFailed = true;
        throw new HisyoConfigError("authentication");
      }
    }, options);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.locked(async (data) => {
      const value = validate(data.openai);
      return value ? [{ providerId: "openai", type: value.type }] : [];
    }, options);
  }

  async delete(_providerId: string, _options?: AuthOperationOptions): Promise<void> {
    // This adapter reuses credentials, but does not offer login/logout management.
    throw new HisyoConfigError("credential");
  }
}
