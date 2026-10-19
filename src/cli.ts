#!/usr/bin/env node
import { once } from "node:events";
import { homedir } from "node:os";
import { cliErrorMessage, parseOptions, usage } from "./cliOptions.js";
import { writeCliLog } from "./cliLog.js";
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
  process.stderr.on("error", onFault);
  let runtime: BridgeRuntime | undefined;
  const errors: unknown[] = [];
  try {
    const { startHisyoRuntime } = await import("./runtime/hisyoRuntime.js");
    runtime = await startHisyoRuntime({
      options,
      homeDirectory: homedir(),
      signal: stop.signal,
      onFault,
      onLog: writeCliLog,
    });
    stop.signal.throwIfAborted();
    runtime!.bridge.on("attach", (world) =>
      writeCliLog("game.attached", {
        ...world.binding,
        language: world.language,
        paused: world.paused,
      }),
    );
    runtime!.bridge.on("detach", (binding) => writeCliLog("game.detached", binding));
    runtime!.bridge.on("status", (world) =>
      writeCliLog("game.status", { ...world.binding, paused: world.paused }),
    );
    runtime!.bridge.on("runRequested", (batch) =>
      writeCliLog("run.requested", {
        ...batch.binding,
        initial: batch.initial,
        poll: batch.poll,
        playerMessages: batch.playerMessages,
        hooks: batch.hooks.map((hook) => hook.id),
        observations: batch.observations.length,
      }),
    );
    runtime!.bridge.on("runInvalidated", (binding, reason) =>
      writeCliLog("run.invalidated", { ...binding, reason }),
    );
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
      process.stderr.off("error", onFault);
    }
  }
  if (fatalError && !errors.includes(fatalError)) errors.unshift(fatalError);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Hisyo execution and cleanup failed");
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${cliErrorMessage(error)}\nRun hisyo --help for usage.\n`);
  process.exitCode = 1;
}
