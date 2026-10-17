#!/usr/bin/env node
import { once } from "node:events";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { cliErrorMessage, parseOptions, usage } from "./cliOptions.js";
import type { BridgeRuntime } from "./runtime/bridgeRuntime.js";

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
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
    const { startDirectorRuntime } = await import("./runtime/directorRuntime.js");
    runtime = await startDirectorRuntime({
      options,
      homeDirectory: homedir(),
      bundledExtension: fileURLToPath(new URL("./directorBridge.mjs", import.meta.url)),
      signal: stop.signal,
      onFault,
    });
    stop.signal.throwIfAborted();
    process.stdout.write(
      `Bridge ready at 127.0.0.1:${runtime!.connection.port}${options.bridgeOnly ? " (bridge-only)" : ""}.\n`,
    );
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

try {
  await main();
} catch (error) {
  process.stderr.write(`${cliErrorMessage(error)}\nRun ai-director --help for usage.\n`);
  process.exitCode = 1;
}
