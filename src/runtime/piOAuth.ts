import { execFile } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Pi alone refreshes/persists the original grant; the isolated child gets no refresh token. */
export async function refreshPiOAuth(
  executable: string,
  agentDirectory: string,
  authPath: string,
  judgmentTimeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    signal.throwIfAborted();
    // Do not kill an in-flight helper: Pi must persist a rotated refresh token before exit.
    const { stdout } = await execute(
      executable,
      [
        "auth",
        "print-bearer-token",
        "--provider",
        "openai",
        "--min-expiry",
        `${judgmentTimeoutMs + 300_000}ms`,
      ],
      {
        env: {
          PATH: process.env.PATH,
          PI_CODING_AGENT_DIR: agentDirectory,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
        },
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
    );
    signal.throwIfAborted();
    const token = stdout.trim();
    // Stored api_key values use Pi's config resolver: reject commands/interpolation, not just blanks.
    if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token)) throw new Error("Invalid bearer token");
    writeFileSync(`${authPath}.tmp`, JSON.stringify({ openai: { type: "api_key", key: token } }), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(`${authPath}.tmp`, authPath);
  } catch {
    // execFile errors can contain stdout/stderr (credentials); never propagate them or their cause.
    throw new Error("Unable to refresh ChatGPT authentication through Pi.");
  }
}
