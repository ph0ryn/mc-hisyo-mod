import { EventEmitter } from "node:events";
import { createModels, type Model } from "@earendil-works/pi-ai";
import { expect, test, vi } from "vite-plus/test";
import type { BridgeServer } from "../bridge/bridgeServer.js";
import { parseOptions } from "../cliOptions.js";
import type { SessionBinding } from "../protocol/bridge.js";
import { startHisyoRuntime, type HisyoRuntimePorts } from "./hisyoRuntime.js";

const world: SessionBinding = { worldId: "w", playerId: "p", sessionId: "s" };
function fixture(args = ["--api-key-env", "KEY"]) {
  const order: string[] = [];
  const model: Model<"openai-responses"> = {
    provider: "openai",
    id: "gpt-6-luna",
    name: "fake",
    api: "openai-responses",
    baseUrl: "https://fake.invalid",
    reasoning: true,
    input: ["text"],
    contextWindow: 100_000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const modelAccess = {
    model,
    models: createModels({
      authContext: { env: async () => undefined, fileExists: async () => false },
    }),
    close: vi.fn(async () => {
      order.push("modelAccess");
    }),
  };
  let sample!: () => void;
  let readySession: { binding: SessionBinding } | undefined;
  const scheduler = Object.assign(new EventEmitter<{ fault: [error: Error] }>(), {
    poll: vi.fn((_binding: SessionBinding) => false),
    summarize: vi.fn(
      async (_binding: SessionBinding, _input: string, _signal: AbortSignal) => "summary",
    ),
    close: vi.fn(async () => {
      order.push("scheduler");
    }),
  });
  const summaryScheduler = Object.assign(new EventEmitter<{ fault: [error: Error] }>(), {
    poll: vi.fn((_binding: SessionBinding) => false),
    close: vi.fn(async () => {
      order.push("summaryScheduler");
    }),
  });
  const bridge = {
    get readySession() {
      return readySession;
    },
  } as BridgeServer;
  const base = {
    bridge,
    connection: {
      protocolVersion: 2 as const,
      host: "127.0.0.1" as const,
      port: 1,
      token: "unused",
      pid: 1,
    },
    close: vi.fn(async () => {
      order.push("base");
    }),
  };
  const ports: HisyoRuntimePorts = {
    readEnv: vi.fn((name) => {
      if (name === "PI_CODING_AGENT_DIR") order.push("config");
      return name === "KEY" ? "SECRET_SENTINEL" : undefined;
    }),
    createModelAccess: vi.fn(async () => {
      order.push("createModelAccess");
      return modelAccess;
    }),
    startBridge: vi.fn(async () => {
      order.push("bridge");
      return base;
    }),
    createScheduler: vi.fn(() => {
      order.push("createScheduler");
      return scheduler;
    }),
    createSummaryScheduler: vi.fn(() => {
      order.push("createSummaryScheduler");
      return summaryScheduler;
    }),
    everySecond: vi.fn((callback) => {
      sample = callback;
      return () => {
        order.push("timer");
      };
    }),
  };
  const stop = new AbortController();
  const onFault = vi.fn();
  const options = {
    options: parseOptions(args),
    homeDirectory: "/home/unit",
    signal: stop.signal,
    onFault,
  };
  return {
    order,
    scheduler,
    summaryScheduler,
    modelAccess,
    base,
    ports,
    stop,
    onFault,
    options,
    sample: () => sample(),
    ready: (binding?: SessionBinding) => {
      readySession = binding ? { binding } : undefined;
    },
  };
}

test.each(["--help", "--bridge-only"])(
  "help/bridge-only never resolve SDK credentials or create a scheduler: %s",
  async (flag) => {
    const f = fixture([flag]);
    const runtime = await startHisyoRuntime(f.options, f.ports);
    expect(f.ports.createModelAccess).not.toHaveBeenCalled();
    expect(f.ports.readEnv).not.toHaveBeenCalled();
    expect(f.ports.createScheduler).not.toHaveBeenCalled();
    expect(f.ports.createSummaryScheduler).not.toHaveBeenCalled();
    expect(f.ports.everySecond).not.toHaveBeenCalled();
    expect(f.ports.startBridge).toHaveBeenCalledTimes(flag === "--help" ? 0 : 1);
    await runtime?.close();
  },
);

test("config fails before acquiring any resource", async () => {
  const f = fixture();
  f.ports.readEnv = () => " ";
  await expect(startHisyoRuntime(f.options, f.ports)).rejects.toThrow();
  expect(f.ports.startBridge).not.toHaveBeenCalled();
});

test("CLI diagnostics reach the scheduler without logging credentials or connection tokens", async () => {
  const f = fixture();
  const onLog = vi.fn();
  const runtime = (await startHisyoRuntime({ ...f.options, onLog }, f.ports))!;
  try {
    const schedulerOptions = vi.mocked(f.ports.createScheduler).mock.calls[0]![0];
    schedulerOptions.onLog?.("tool_execution_start", { toolName: "send_message" });
    expect(onLog).toHaveBeenCalledExactlyOnceWith("tool_execution_start", {
      toolName: "send_message",
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("SECRET_SENTINEL");
    expect(JSON.stringify(onLog.mock.calls)).not.toContain(f.base.connection.token);
  } finally {
    await runtime.close();
  }
});

test("default launch resolves the Pi credential source only at the SDK model-access boundary", async () => {
  const f = fixture([]);
  const runtime = (await startHisyoRuntime(f.options, f.ports))!;
  expect(f.ports.createModelAccess).toHaveBeenCalledWith(
    expect.objectContaining({ agentDirectory: "/home/unit/.pi/agent" }),
    expect.objectContaining({ readEnv: f.ports.readEnv }),
  );
  expect(vi.mocked(f.ports.createModelAccess).mock.calls[0]![0]).not.toHaveProperty("apiKeyEnv");
  expect(f.ports.createScheduler).toHaveBeenCalledWith(
    expect.objectContaining({ modelAccess: f.modelAccess }),
  );
  await runtime.close();
});

test("normal composition snapshots config before bridge, polls only current binding, routes faults", async () => {
  const f = fixture();
  const runtime = (await startHisyoRuntime(f.options, f.ports))!;
  expect(f.order).toEqual([
    "config",
    "createModelAccess",
    "bridge",
    "createScheduler",
    "createSummaryScheduler",
  ]);
  expect(f.ports.createScheduler).toHaveBeenCalledWith(
    expect.objectContaining({
      bridge: f.base.bridge,
      modelAccess: f.modelAccess,
    }),
  );
  f.sample();
  expect(f.scheduler.poll).not.toHaveBeenCalled();
  f.ready(world);
  f.sample();
  const next = { ...world, sessionId: "next" };
  f.ready(next);
  f.sample();
  expect(f.scheduler.poll.mock.calls).toEqual([[world], [next]]);
  expect(f.summaryScheduler.poll.mock.calls).toEqual([[world], [next]]);
  const fault = new Error("fault");
  f.scheduler.emit("fault", fault);
  expect(f.onFault).toHaveBeenCalledExactlyOnceWith(fault);
  await runtime.close();
  f.sample();
  expect(f.scheduler.poll).toHaveBeenCalledTimes(2);
  expect(f.order.slice(-5)).toEqual([
    "timer",
    "summaryScheduler",
    "scheduler",
    "modelAccess",
    "base",
  ]);
});

test("shutdown is published before reentry and waits for scheduler termination before base", async () => {
  const f = fixture();
  let release!: () => void;
  const termination = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = (await startHisyoRuntime(f.options, f.ports))!;
  let reentrant: Promise<void> | undefined;
  f.scheduler.close.mockImplementation(() => {
    f.order.push("scheduler");
    reentrant = runtime.close();
    return termination;
  });
  const closing = runtime.close();
  expect(reentrant).toBe(closing);
  expect(runtime.close()).toBe(closing);
  expect(f.base.close).not.toHaveBeenCalled();
  f.ready(world);
  f.sample();
  expect(f.scheduler.poll).not.toHaveBeenCalled();
  release();
  await closing;
  expect(f.order.slice(-5)).toEqual([
    "timer",
    "summaryScheduler",
    "scheduler",
    "modelAccess",
    "base",
  ]);
});

test("summaryScheduler faults are routed and shutdown awaits its pending completion before closing SQLite", async () => {
  const f = fixture();
  let release!: () => void;
  f.summaryScheduler.close.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const runtime = (await startHisyoRuntime(f.options, f.ports))!;
  const failure = new Error("summary failure");
  f.summaryScheduler.emit("fault", failure);
  expect(f.onFault).toHaveBeenCalledExactlyOnceWith(failure);
  const closing = runtime.close();
  expect(f.base.close).not.toHaveBeenCalled();
  release();
  await closing;
  expect(f.base.close).toHaveBeenCalledOnce();
  expect(f.summaryScheduler.listenerCount("fault")).toBe(0);
});

test("cleanup attempts base and retains all cleanup failures", async () => {
  const f = fixture();
  const first = new Error("termination unconfirmed");
  const second = new Error("base cleanup");
  f.scheduler.close.mockRejectedValue(first);
  f.base.close.mockRejectedValue(second);
  const runtime = (await startHisyoRuntime(f.options, f.ports))!;
  await expect(runtime.close()).rejects.toMatchObject({ errors: [first, second] });
  expect(f.base.close).toHaveBeenCalledTimes(1);
});

test.each(["scheduler", "summaryScheduler", "timer", "aborted"])(
  "partial %s startup cleans owned resources",
  async (stage) => {
    const f = fixture();
    if (stage === "scheduler")
      f.ports.createScheduler = () => {
        throw new Error("create");
      };
    if (stage === "summaryScheduler")
      f.ports.createSummaryScheduler = () => {
        throw new Error("summaryScheduler create");
      };
    if (stage === "timer")
      f.ports.everySecond = () => {
        throw new Error("timer");
      };
    if (stage === "aborted")
      f.ports.createScheduler = () => {
        f.stop.abort();
        return f.scheduler;
      };
    await expect(startHisyoRuntime(f.options, f.ports)).rejects.toThrow();
    expect(f.base.close).toHaveBeenCalledTimes(1);
    expect(f.scheduler.close).toHaveBeenCalledTimes(stage === "scheduler" ? 0 : 1);
  },
);

test("summaryScheduler model calls route through the trusted current-session owner", async () => {
  const f = fixture();
  const runtime = (await startHisyoRuntime(f.options, f.ports))!;
  const summaryScheduler = vi.mocked(f.ports.createSummaryScheduler).mock.calls[0]![0];
  const signal = new AbortController().signal;
  await expect(summaryScheduler.summarize(world, "observations", signal)).resolves.toBe("summary");
  expect(f.scheduler.summarize).toHaveBeenCalledExactlyOnceWith(world, "observations", signal);
  await runtime.close();
});

test("trusted credential-source configuration is captured before bridge acquisition", async () => {
  const f = fixture();
  f.ports.startBridge = vi.fn(async () => {
    f.options.options.agentDirectory = "/changed";
    f.options.options.apiKeyEnv = "CHANGED";
    return f.base;
  });
  const runtime = (await startHisyoRuntime(f.options, f.ports))!;
  expect(f.ports.createModelAccess).toHaveBeenCalledWith(
    expect.objectContaining({ agentDirectory: "/home/unit/.pi/agent", apiKeyEnv: "KEY" }),
    expect.objectContaining({ readEnv: f.ports.readEnv }),
  );
  const schedulerOptions = vi.mocked(f.ports.createScheduler).mock.calls[0]![0];
  expect(schedulerOptions.modelAccess).toBe(f.modelAccess);
  for (const obsolete of [
    "executable",
    "connection",
    "bundledExtension",
    "oauthAgentDirectory",
    "apiKey",
  ])
    expect(schedulerOptions).not.toHaveProperty(obsolete);
  await runtime.close();
});

test("sampling faults route once through the stop callback; aborted samples do nothing", async () => {
  const f = fixture();
  const fault = new Error("SECRET_SENTINEL");
  f.options.onFault = vi.fn((error: Error) => {
    f.onFault(error);
    f.stop.abort(error);
  });
  const runtime = (await startHisyoRuntime(f.options, f.ports))!;
  f.ready(world);
  f.scheduler.poll.mockImplementation(() => {
    throw fault;
  });
  f.sample();
  f.sample();
  expect(f.onFault).toHaveBeenCalledExactlyOnceWith(fault);
  expect(f.scheduler.poll).toHaveBeenCalledTimes(1);
  await Promise.all([runtime.close(), runtime.close()]);
  expect(f.scheduler.close).toHaveBeenCalledTimes(1);
  expect(f.base.close).toHaveBeenCalledTimes(1);
});

test("timer disposal failure still retires scheduler and closes base", async () => {
  const f = fixture();
  const failure = new Error("timer disposal");
  f.ports.everySecond = () => () => {
    throw failure;
  };
  const runtime = (await startHisyoRuntime(f.options, f.ports))!;
  await expect(runtime.close()).rejects.toMatchObject({ errors: [failure] });
  expect(f.scheduler.close).toHaveBeenCalledTimes(1);
  expect(f.base.close).toHaveBeenCalledTimes(1);
});

test("startup and cleanup failures are both retained", async () => {
  const f = fixture();
  const primary = new Error("timer");
  const cleanup = new Error("base");
  f.ports.everySecond = () => {
    throw primary;
  };
  f.base.close.mockRejectedValue(cleanup);
  await expect(startHisyoRuntime(f.options, f.ports)).rejects.toMatchObject({
    errors: [primary, expect.objectContaining({ errors: [cleanup] })],
  });
});

test("SDK credential failure stops startup before acquiring the game bridge", async () => {
  const f = fixture();
  const failure = new Error("credential unavailable");
  vi.mocked(f.ports.createModelAccess).mockRejectedValueOnce(failure);
  await expect(startHisyoRuntime(f.options, f.ports)).rejects.toBe(failure);
  expect(f.ports.startBridge).not.toHaveBeenCalled();
  expect(f.ports.createScheduler).not.toHaveBeenCalled();
  expect(f.modelAccess.close).not.toHaveBeenCalled();
});

test("cancellation during SDK model-access startup closes the late owner without opening the bridge", async () => {
  const f = fixture();
  let release!: (access: typeof f.modelAccess) => void;
  vi.mocked(f.ports.createModelAccess).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const starting = startHisyoRuntime(f.options, f.ports);
  const rejected = expect(starting).rejects.toMatchObject({ name: "AbortError" });
  f.stop.abort();
  release(f.modelAccess);
  await rejected;
  expect(f.modelAccess.close).toHaveBeenCalledOnce();
  expect(f.ports.startBridge).not.toHaveBeenCalled();
  expect(f.ports.createScheduler).not.toHaveBeenCalled();
});

test("bridge startup failure releases SDK model access even without a scheduler", async () => {
  const f = fixture();
  const failure = new Error("bridge failed");
  vi.mocked(f.ports.startBridge).mockRejectedValueOnce(failure);
  await expect(startHisyoRuntime(f.options, f.ports)).rejects.toBe(failure);
  expect(f.modelAccess.close).toHaveBeenCalledOnce();
  expect(f.ports.createScheduler).not.toHaveBeenCalled();
});

test("SDK model access closes only after both scheduler drains and before bridge storage", async () => {
  const f = fixture();
  let finishRun!: () => void;
  let finishSummary!: () => void;
  f.scheduler.close.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishRun = resolve;
      }),
  );
  f.summaryScheduler.close.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishSummary = resolve;
      }),
  );
  const runtime = (await startHisyoRuntime(f.options, f.ports))!;
  const closing = runtime.close();
  expect(f.modelAccess.close).not.toHaveBeenCalled();
  finishRun();
  await Promise.resolve();
  expect(f.modelAccess.close).not.toHaveBeenCalled();
  finishSummary();
  await closing;
  expect(f.modelAccess.close).toHaveBeenCalledOnce();
  expect(f.order.slice(-2)).toEqual(["modelAccess", "base"]);
});

test("model-access cleanup failure is retained and does not prevent bridge cleanup", async () => {
  const f = fixture();
  const failure = new Error("SDK cleanup failed");
  f.modelAccess.close.mockRejectedValueOnce(failure);
  const runtime = (await startHisyoRuntime(f.options, f.ports))!;
  await expect(runtime.close()).rejects.toMatchObject({ errors: [failure] });
  expect(f.base.close).toHaveBeenCalledOnce();
});
