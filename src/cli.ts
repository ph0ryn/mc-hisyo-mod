#!/usr/bin/env node
import { once } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { BridgeRuntime } from "./runtime/bridgeRuntime.js";

const usage = `Usage: ai-director [--bridge-only] [--data-dir PATH] [--help]

Minecraft AI Director

Options:
  --help           Show usage without touching state or starting Pi.
  --bridge-only    Start the authenticated bridge without Pi or judgments.
  --data-dir PATH  Private state directory (default: ~/.mc-hisyo).
                   Its parent must exist; existing directories must be owned 0700.

Private discovery currently requires POSIX permissions. Keep parent directories trusted.
Stop with Ctrl-C or SIGTERM. Stale connection.json requires manual recovery after its owner stops.
Production Pi integration is not available in this development stage.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" },
      "bridge-only": { type: "boolean" },
      "data-dir": { type: "string" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(usage);
    return;
  }
  if (!values["bridge-only"])
    throw new Error("Pi integration is not available yet. Use --bridge-only to run without Pi.");

  const stop = new AbortController();
  let fatalError: Error | undefined;
  const onFault = (error: Error) => {
    fatalError ??= error;
    stop.abort(error);
  };
  const onSignal = () => stop.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.stdout.on("error", onFault);
  let runtime: BridgeRuntime | undefined;
  const errors: unknown[] = [];
  try {
    const { startBridgeRuntime } = await import("./runtime/bridgeRuntime.js");
    runtime = await startBridgeRuntime({
      dataDirectory: values["data-dir"] ?? join(homedir(), ".mc-hisyo"),
      signal: stop.signal,
      onFault,
    });
    stop.signal.throwIfAborted();
    process.stdout.write(`Bridge ready at 127.0.0.1:${runtime.connection.port} (bridge-only).\n`);
    await once(stop.signal, "abort");
  } catch (error) {
    if (!stop.signal.aborted || error !== stop.signal.reason) errors.push(error);
  } finally {
    try {
      await runtime?.close();
    } catch (error) {
      errors.push(error);
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.stdout.off("error", onFault);
    }
  }
  if (fatalError && !errors.includes(fatalError)) errors.unshift(fatalError);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Director execution and cleanup failed");
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError)
    return `${error.message}\n${error.errors.map(errorMessage).join("\n")}`;
  return error instanceof Error ? error.message : String(error);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\nRun ai-director --help for usage.\n`);
  process.exitCode = 1;
}
