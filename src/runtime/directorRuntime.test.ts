import { EventEmitter } from "node:events";
import { expect, test, vi } from "vite-plus/test";
import type { DirectorBridge } from "../bridge/directorBridge.js";
import { parseOptions } from "../cliOptions.js";
import type { WorldBinding } from "../protocol/bridge.js";
import { startDirectorRuntime, type DirectorRuntimePorts } from "./directorRuntime.js";

const world: WorldBinding = { worldId: "w", playerId: "p", worldSessionId: "s" };
function fixture(args = ["--provider", "p", "--model", "m", "--api-key-env", "KEY"]) {
  const order: string[] = [];
  let sample!: () => void;
  let readyWorld: { binding: WorldBinding } | undefined;
  const scheduler = Object.assign(new EventEmitter<{ fault: [error: Error] }>(), {
    poll: vi.fn((_binding: WorldBinding) => false),
    close: vi.fn(async () => {
      order.push("scheduler");
    }),
  });
  const bridge = {
    get readyWorld() {
      return readyWorld;
    },
  } as DirectorBridge;
  const base = {
    bridge,
    connection: {
      protocolVersion: 1 as const,
      host: "127.0.0.1" as const,
      port: 1,
      token: "unused",
      pid: 1,
    },
    close: vi.fn(async () => {
      order.push("base");
    }),
  };
  const ports: DirectorRuntimePorts = {
    readText: vi.fn(() => {
      order.push("config");
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    }),
    readEnv: vi.fn((name) => (name === "KEY" ? "SECRET_SENTINEL" : undefined)),
    startBridge: vi.fn(async () => {
      order.push("bridge");
      return base;
    }),
    createScheduler: vi.fn(() => {
      order.push("createScheduler");
      return scheduler;
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
    bundledExtension: "/trusted/directorBridge.mjs",
    signal: stop.signal,
    onFault,
  };
  return {
    order,
    scheduler,
    base,
    ports,
    stop,
    onFault,
    options,
    sample: () => sample(),
    ready: (binding?: WorldBinding) => {
      readyWorld = binding ? { binding } : undefined;
    },
  };
}

test.each(["--help", "--bridge-only"])(
  "help/bridge-only never read config or create Pi scheduler: %s",
  async (flag) => {
    const f = fixture([flag]);
    const runtime = await startDirectorRuntime(f.options, f.ports);
    expect(f.ports.readText).not.toHaveBeenCalled();
    expect(f.ports.readEnv).not.toHaveBeenCalled();
    expect(f.ports.createScheduler).not.toHaveBeenCalled();
    expect(f.ports.everySecond).not.toHaveBeenCalled();
    expect(f.ports.startBridge).toHaveBeenCalledTimes(flag === "--help" ? 0 : 1);
    await runtime?.close();
  },
);

test("config fails before acquiring any resource", async () => {
  const f = fixture();
  f.ports.readEnv = () => undefined;
  await expect(startDirectorRuntime(f.options, f.ports)).rejects.toThrow();
  expect(f.ports.startBridge).not.toHaveBeenCalled();
});

test("normal composition snapshots config before bridge, polls only current binding, routes faults", async () => {
  const f = fixture();
  const runtime = (await startDirectorRuntime(f.options, f.ports))!;
  expect(f.order).toEqual(["config", "bridge", "createScheduler"]);
  expect(f.ports.createScheduler).toHaveBeenCalledWith(
    expect.objectContaining({
      bridge: f.base.bridge,
      executable: "pi",
      bundledExtension: "/trusted/directorBridge.mjs",
      model: { provider: "p", id: "m", apiKey: "SECRET_SENTINEL" },
    }),
  );
  f.sample();
  expect(f.scheduler.poll).not.toHaveBeenCalled();
  f.ready(world);
  f.sample();
  const next = { ...world, worldSessionId: "next" };
  f.ready(next);
  f.sample();
  expect(f.scheduler.poll.mock.calls).toEqual([[world], [next]]);
  const fault = new Error("fault");
  f.scheduler.emit("fault", fault);
  expect(f.onFault).toHaveBeenCalledExactlyOnceWith(fault);
  await runtime.close();
  f.sample();
  expect(f.scheduler.poll).toHaveBeenCalledTimes(2);
  expect(f.order.slice(-3)).toEqual(["timer", "scheduler", "base"]);
});

test("shutdown is published before reentry and waits for scheduler termination before base", async () => {
  const f = fixture();
  let release!: () => void;
  const termination = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = (await startDirectorRuntime(f.options, f.ports))!;
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
  expect(f.order.slice(-3)).toEqual(["timer", "scheduler", "base"]);
});

test("cleanup attempts base and retains all cleanup failures", async () => {
  const f = fixture();
  const first = new Error("termination unconfirmed");
  const second = new Error("base cleanup");
  f.scheduler.close.mockRejectedValue(first);
  f.base.close.mockRejectedValue(second);
  const runtime = (await startDirectorRuntime(f.options, f.ports))!;
  await expect(runtime.close()).rejects.toMatchObject({ errors: [first, second] });
  expect(f.base.close).toHaveBeenCalledTimes(1);
});

test.each(["scheduler", "timer", "aborted"])(
  "partial %s startup cleans owned resources",
  async (stage) => {
    const f = fixture();
    if (stage === "scheduler")
      f.ports.createScheduler = () => {
        throw new Error("create");
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
    await expect(startDirectorRuntime(f.options, f.ports)).rejects.toThrow();
    expect(f.base.close).toHaveBeenCalledTimes(1);
    expect(f.scheduler.close).toHaveBeenCalledTimes(stage === "scheduler" ? 0 : 1);
  },
);

test("trusted config and bundled path are captured before resource acquisition", async () => {
  const f = fixture();
  f.ports.startBridge = vi.fn(async () => {
    f.options.options.provider = "changed";
    f.options.options.executable = "changed";
    f.options.bundledExtension = "/changed.mjs";
    f.ports.readEnv = () => "changed";
    return f.base;
  });
  const runtime = (await startDirectorRuntime(f.options, f.ports))!;
  expect(f.ports.createScheduler).toHaveBeenCalledWith(
    expect.objectContaining({
      executable: "pi",
      bundledExtension: "/trusted/directorBridge.mjs",
      model: { provider: "p", id: "m", apiKey: "SECRET_SENTINEL" },
    }),
  );
  await runtime.close();
});

test("sampling faults route once through the stop callback; aborted samples do nothing", async () => {
  const f = fixture();
  const fault = new Error("SECRET_SENTINEL");
  f.options.onFault = vi.fn((error: Error) => {
    f.onFault(error);
    f.stop.abort(error);
  });
  const runtime = (await startDirectorRuntime(f.options, f.ports))!;
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
  const runtime = (await startDirectorRuntime(f.options, f.ports))!;
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
  await expect(startDirectorRuntime(f.options, f.ports)).rejects.toMatchObject({
    errors: [primary, expect.objectContaining({ errors: [cleanup] })],
  });
});
