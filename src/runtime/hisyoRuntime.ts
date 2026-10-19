import type { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CliOptions } from "../cliOptions.js";
import { startBridgeRuntime, type BridgeRuntime } from "./bridgeRuntime.js";
import { resolveTrustedConfig, type ConfigInput } from "./hisyoConfig.js";
import { RunScheduler, type RunSchedulerOptions } from "./runScheduler.js";
import { SummaryScheduler, type SummarySchedulerOptions } from "./summaryScheduler.js";

export interface HisyoRuntimePorts extends Omit<ConfigInput, "homeDirectory"> {
  startBridge: typeof startBridgeRuntime;
  createScheduler: (
    options: RunSchedulerOptions,
  ) => Pick<RunScheduler, "poll" | "close" | "summarize"> &
    Pick<EventEmitter<{ fault: [error: Error] }>, "on" | "off">;
  createSummaryScheduler: (
    options: SummarySchedulerOptions,
  ) => Pick<SummaryScheduler, "poll" | "close"> &
    Pick<EventEmitter<{ fault: [error: Error] }>, "on" | "off">;
  everySecond: (sample: () => void) => () => void;
}
const resources: HisyoRuntimePorts = {
  readText: (path) => readFileSync(path, "utf8"),
  readEnv: (name) => process.env[name],
  startBridge: startBridgeRuntime,
  createScheduler: (options) => new RunScheduler(options),
  createSummaryScheduler: (options) => new SummaryScheduler(options),
  everySecond: (sample) => {
    const timer = setInterval(sample, 1_000);
    return () => clearInterval(timer);
  },
};
interface HisyoRuntimeOptions extends Pick<RunSchedulerOptions, "onLog"> {
  options: CliOptions;
  homeDirectory: string;
  bundledExtension: string;
  signal: AbortSignal;
  onFault: (error: Error) => void;
}

/** One concrete resource boundary; scheduler/Pi process retain all run and child ownership. */
export async function startHisyoRuntime(
  input: HisyoRuntimeOptions,
  ports = resources,
): Promise<BridgeRuntime | undefined> {
  const { options, homeDirectory, bundledExtension, signal, onFault, onLog } = input;
  if (options.help) return;
  signal.throwIfAborted();
  const config = options.bridgeOnly
    ? undefined
    : resolveTrustedConfig(options, { ...ports, homeDirectory });
  const dataDirectory =
    config?.dataDirectory ?? resolve(options.dataDirectory ?? join(homeDirectory, ".mc-hisyo"));
  let base: BridgeRuntime | undefined;
  let scheduler: ReturnType<HisyoRuntimePorts["createScheduler"]> | undefined;
  let summaryScheduler: ReturnType<HisyoRuntimePorts["createSummaryScheduler"]> | undefined;
  let cancelTimer: (() => void) | undefined;
  let closing = false;
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (shutdown) return shutdown;
    const errors: unknown[] = [];
    let schedulerShutdown: Promise<void> | undefined;
    let summaryShutdown: Promise<void> | undefined;
    // Publish before timer disposal or scheduler invalidation can reenter close().
    shutdown = Promise.resolve().then(async () => {
      for (const result of await Promise.allSettled([summaryShutdown, schedulerShutdown])) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      scheduler?.off("fault", onFault);
      summaryScheduler?.off("fault", onFault);
      try {
        await base?.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, "Hisyo cleanup failed");
    });
    closing = true;
    try {
      cancelTimer?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      summaryShutdown = summaryScheduler?.close();
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
        ...(onLog ? { onLog } : {}),
      });
      scheduler.on("fault", onFault);
      summaryScheduler = ports.createSummaryScheduler({
        bridge: base.bridge,
        summarize: (...args) => scheduler!.summarize(...args),
      });
      summaryScheduler.on("fault", onFault);
      signal.throwIfAborted();
      cancelTimer = ports.everySecond(() => {
        if (closing || signal.aborted) return;
        const session = base!.bridge.readySession;
        if (session) {
          try {
            scheduler!.poll(session.binding);
            if (!closing && !signal.aborted) summaryScheduler!.poll(session.binding);
          } catch (error) {
            onFault(error instanceof Error ? error : new Error("Hisyo polling failed"));
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
      throw new AggregateError([error, cleanup], "Hisyo startup and cleanup failed");
    }
    throw error;
  }
}
