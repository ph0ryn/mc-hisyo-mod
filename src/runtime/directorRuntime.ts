import type { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CliOptions } from "../cliOptions.js";
import { startBridgeRuntime, type BridgeRuntime } from "./bridgeRuntime.js";
import { resolveTrustedConfig, type ConfigInput } from "./directorConfig.js";
import { JudgmentScheduler, type JudgmentSchedulerOptions } from "./judgmentScheduler.js";

export interface DirectorRuntimePorts extends Omit<ConfigInput, "homeDirectory"> {
  startBridge: typeof startBridgeRuntime;
  createScheduler: (
    options: JudgmentSchedulerOptions,
  ) => Pick<JudgmentScheduler, "poll" | "close"> &
    Pick<EventEmitter<{ fault: [error: Error] }>, "on" | "off">;
  everySecond: (sample: () => void) => () => void;
}
const resources: DirectorRuntimePorts = {
  readText: (path) => readFileSync(path, "utf8"),
  readEnv: (name) => process.env[name],
  startBridge: startBridgeRuntime,
  createScheduler: (options) => new JudgmentScheduler(options),
  everySecond: (sample) => {
    const timer = setInterval(sample, 1_000);
    return () => clearInterval(timer);
  },
};
interface DirectorRuntimeOptions {
  options: CliOptions;
  homeDirectory: string;
  bundledExtension: string;
  signal: AbortSignal;
  onFault: (error: Error) => void;
}

/** One concrete resource boundary; scheduler/session retain all run and child ownership. */
export async function startDirectorRuntime(
  input: DirectorRuntimeOptions,
  ports = resources,
): Promise<BridgeRuntime | undefined> {
  const { options, homeDirectory, bundledExtension, signal, onFault } = input;
  if (options.help) return;
  signal.throwIfAborted();
  const config = options.bridgeOnly
    ? undefined
    : resolveTrustedConfig(options, { ...ports, homeDirectory });
  const dataDirectory =
    config?.dataDirectory ?? resolve(options.dataDirectory ?? join(homeDirectory, ".mc-hisyo"));
  let base: BridgeRuntime | undefined;
  let scheduler: ReturnType<DirectorRuntimePorts["createScheduler"]> | undefined;
  let cancelTimer: (() => void) | undefined;
  let closing = false;
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (shutdown) return shutdown;
    const errors: unknown[] = [];
    let schedulerShutdown: Promise<void> | undefined;
    // Publish before timer disposal or scheduler invalidation can reenter close().
    shutdown = Promise.resolve().then(async () => {
      try {
        await schedulerShutdown;
      } catch (error) {
        errors.push(error);
      }
      scheduler?.off("fault", onFault);
      try {
        await base?.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, "Director cleanup failed");
    });
    closing = true;
    try {
      cancelTimer?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      schedulerShutdown = scheduler?.close();
    } catch (error) {
      errors.push(error);
    }
    return shutdown;
  };
  try {
    base = await ports.startBridge({ dataDirectory, signal, onFault });
    signal.throwIfAborted();
    if (config) {
      scheduler = ports.createScheduler({
        dataDirectory: config.dataDirectory,
        executable: config.executable,
        model: config.model,
        ...(config.oauthAgentDirectory === undefined
          ? {}
          : { oauthAgentDirectory: config.oauthAgentDirectory }),
        bridge: base.bridge,
        connection: base.connection,
        bundledExtension,
      });
      scheduler.on("fault", onFault);
      signal.throwIfAborted();
      cancelTimer = ports.everySecond(() => {
        if (closing || signal.aborted) return;
        const world = base!.bridge.readyWorld;
        if (world) {
          try {
            scheduler!.poll(world.binding);
          } catch (error) {
            onFault(error instanceof Error ? error : new Error("Director polling failed"));
          }
        }
      });
    }
    signal.throwIfAborted();
    return { ...base, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Director startup and cleanup failed");
    }
    throw error;
  }
}
