import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import type { Server } from "node:net";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import type { EventLog } from "../events/eventLog.js";
import type { ResponseHook, ResponseHooks } from "../hooks/responseHooks.js";
import type { GameEvent } from "../protocol/gameEvent.js";
import extension from "../pi/directorBridge.js";
import { directorToolNames } from "../pi/piPolicy.js";
import { staleRunErrorCode, type RunBinding, type WorldBinding } from "../protocol/bridge.js";
import snapshot from "../protocol/fixtures/gameSnapshot.json" with { type: "json" };
import { JudgmentScheduler } from "../runtime/judgmentScheduler.js";
import { startPiSession } from "../runtime/piSession.js";
import { RpcError, type RpcPeer } from "../transport/rpcPeer.js";
import { DirectorBridge } from "./directorBridge.js";

vi.mock("../runtime/piSession.js", () => ({ startPiSession: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Value-only authenticated peers: no sockets, server, database, files or native resources.
class ManualPeer extends EventEmitter<{ close: [Error] }> {
  readonly handlers = new Map<string, (params: unknown) => unknown>();
  readonly calls: string[] = [];
  other!: ManualPeer;
  isClosed = false;
  handle(method: string, handler: (params: unknown) => unknown) {
    this.handlers.set(method, handler);
  }
  receive(method: string, params: unknown): unknown {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`Missing handler ${method}`);
    return handler(structuredClone(params));
  }
  async call(method: string, params: unknown): Promise<unknown> {
    this.calls.push(method);
    return await this.other.receive(method, params);
  }
  notify(method: string, params: unknown) {
    this.calls.push(method);
    this.other.receive(method, params);
  }
  close(error = new Error("closed")) {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emit("close", error);
    this.other.close(error);
  }
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
async function drain() {
  for (let i = 0; i < 30; i++) await tick();
}

async function fixture(supportedEvents: string[] = []) {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  let accept!: (peer: RpcPeer) => void;
  const rows: unknown[] = [];
  let storageError: Error | undefined;
  let appendsBeforeFailure = 0;
  const db = {};
  const matchedHooks: ResponseHook[] = [];
  const eventLog = {
    db,
    atomic: <T>(mutate: () => T): T => {
      const before = rows.length;
      try {
        return mutate();
      } catch (error) {
        rows.splice(before);
        throw error;
      }
    },
    append: (value: GameEvent) => {
      if (storageError && appendsBeforeFailure-- <= 0) throw storageError;
      rows.push(value);
      return { id: rows.length, observation: value };
    },
    appendActivity: (value: unknown) => {
      if (storageError) throw storageError;
      rows.push(value);
    },
    appendActivities: (values: unknown[]) => rows.push(...values),
    catalog: { list: () => supportedEvents.map((name) => ({ name })) },
  } as unknown as EventLog;
  const bridge = new DirectorBridge(
    {
      token: "a".repeat(43),
      eventLog,
      hooks: { db, match: () => matchedHooks } as unknown as ResponseHooks,
    },
    (register) => {
      accept = register;
      return new EventEmitter() as Server;
    },
  );
  onTestFinished(() => bridge.close());
  async function connect(role: "game" | "agent") {
    const host = new ManualPeer();
    const client = new ManualPeer();
    host.other = client;
    client.other = host;
    accept(host as unknown as RpcPeer);
    await client.call("bridge.hello", { protocolVersion: 1, role, token: "a".repeat(43) });
    return { host, client };
  }
  const game = await connect("game");
  const agent = await connect("agent");
  const native: {
    method: string;
    params: RunBinding;
    result: ReturnType<typeof deferred<unknown>>;
  }[] = [];
  game.client.handle("game.run.bind", (params) => params);
  game.client.handle("game.run.clear", (params) => params);
  for (const method of [
    "game.state.get",
    "game.message.send",
    "game.files.list",
    "game.files.read",
    "game.files.search",
  ]) {
    game.client.handle(method, (params) => {
      const result = deferred<unknown>();
      native.push({ method, params: params as RunBinding, result });
      return result.promise;
    });
  }
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  extension(
    {
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
        handlers.set(name, handler),
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
        tools.set(tool.name, tool),
      getActiveTools: () => [...directorToolNames],
    } as unknown as ExtensionAPI,
    () => Promise.resolve(agent.client),
  );
  function context() {
    const controller = new AbortController();
    const ctx = {
      mode: "rpc",
      model: { api: "openai-completions" },
      signal: controller.signal,
      abort: () => controller.abort(),
    } as unknown as ExtensionContext;
    return { ctx, controller };
  }
  const emit = (name: string, ctx: ExtensionContext, event: unknown = {}) =>
    handlers.get(name)?.(event, ctx);
  await emit("session_start", context().ctx);
  const world = (await game.client.call("game.attach", {
    worldId: "w",
    playerId: "p",
    language: "ja_jp",
    supportedEvents,
    paused: false,
  })) as WorldBinding;
  await game.client.call("game.ready", world);
  return {
    bridge,
    game,
    agent,
    native,
    rows,
    matchedHooks,
    world,
    context,
    emit,
    tools,
    failStorage: (error: Error, afterObservations = 0) => {
      storageError = error;
      appendsBeforeFailure = afterObservations;
    },
  };
}

test("event batches persist in order before observation delivery and retain single-event compatibility", async () => {
  const h = await fixture(["block_broken"]);
  const events = Array.from({ length: 100 }, (_, index) => ({
    ...h.world,
    seq: index + 1,
    tick: index + 20,
    observedAt: index + 1000,
    event: "block_broken",
    dimension: "minecraft:overworld",
    position: [1, 2, 3],
    data: { blockId: "minecraft:stone", position: [1, 2, 3] },
  }));
  h.matchedHooks.push({ id: "hook", event: "block_broken", filter: {}, instruction: "report" });
  const delivered: unknown[] = [];
  h.bridge.on("observation", (stored, hooks) => {
    expect(h.rows).toContainEqual(events.at(-1)); // Whole batch persisted before its first delivery.
    expect(hooks).toEqual(h.matchedHooks);
    expect(h.rows).toContainEqual(
      expect.objectContaining({
        event: "director.hook_matched",
        data: { hookId: "hook", sourceEventId: stored.id },
      }),
    );
    delivered.push(stored.observation);
  });
  await expect(h.game.client.call("game.events", { events })).resolves.toEqual({ stored: 100 });
  expect(delivered).toEqual(events);
  const single = { ...events[0], seq: 101 };
  const nextId = h.rows.length + 1;
  await expect(h.game.client.call("game.event", single)).resolves.toEqual({ stored: nextId });
  expect(delivered.at(-1)).toEqual(single);
});

test("event batches reject invalid scope, capabilities and malformed input without partial delivery", async () => {
  const h = await fixture(["block_broken"]);
  const event = {
    ...h.world,
    seq: 1,
    tick: 20,
    observedAt: 1000,
    event: "block_broken",
    dimension: "minecraft:overworld",
    position: [1, 2, 3],
    data: {},
  };
  const before = [...h.rows];
  for (const params of [
    { events: [] },
    { events: [event, { ...event, seq: 2, worldSessionId: "stale" }] },
    { events: [event, { ...event, seq: 2, event: "health_changed" }] },
    { events: [event, { ...event, seq: 2, observedAt: "now" }] },
    { events: [event], extra: true },
    { events: Array(1025).fill(event) },
  ]) {
    await expect(h.game.client.call("game.events", params)).rejects.toThrow();
    expect(h.rows).toEqual(before);
  }
  await expect(h.agent.client.call("game.events", { events: [event] })).rejects.toMatchObject({
    code: -32010,
  });
  h.failStorage(new Error("write failed"));
  await expect(h.game.client.call("game.events", { events: [event] })).rejects.toThrow(
    "write failed",
  );
  expect(h.rows).toEqual(before);
});

test("a failed event batch rolls back its earlier observations without delivering hooks", async () => {
  const h = await fixture(["block_broken"]);
  const event = {
    ...h.world,
    seq: 1,
    tick: 20,
    observedAt: 1000,
    event: "block_broken",
    dimension: "minecraft:overworld",
    position: [1, 2, 3],
    data: {},
  };
  const before = [...h.rows];
  const delivered: unknown[] = [];
  h.bridge.on("observation", (stored) => delivered.push(stored));
  h.failStorage(new Error("second write failed"), 1);
  await expect(
    h.game.client.call("game.events", { events: [event, { ...event, seq: 2 }] }),
  ).rejects.toThrow("second write failed");
  expect(h.rows).toEqual(before);
  expect(delivered).toEqual([]);
});

test("attachment retains the initial language and rejects missing or invalid language codes", async () => {
  const h = await fixture();
  expect(h.bridge.currentWorld).toMatchObject({ language: "ja_jp" });
  await h.game.client.call("game.detach", h.world);
  const attach = { worldId: "w", playerId: "p", supportedEvents: [], paused: false };
  for (const language of [undefined, null, "", 123, "a".repeat(17), "ja_jp\n"])
    await expect(h.game.client.call("game.attach", { ...attach, language })).rejects.toMatchObject({
      code: -32602,
    });
  expect(h.bridge.currentWorld).toBeUndefined();
  await h.game.client.call("game.attach", { ...attach, language: "en_us" });
  expect(h.bridge.currentWorld).toMatchObject({ language: "en_us" });
});

test("native withdrawal FIRST cancels without retirement; queued manual/tick wait for actual settlement and validated resume", async () => {
  const h = await fixture();
  const flights: {
    binding: RunBinding;
    ctx: ExtensionContext;
    controller: AbortController;
    settled: ReturnType<typeof deferred<void>>;
    context: Promise<unknown>;
  }[] = [];
  let providerDispatches = 0;
  let retired = false;
  const session = Object.assign(new EventEmitter(), {
    judge: vi.fn(async (_message: string) => {
      const { ctx, controller } = h.context();
      const invalidated = () => controller.abort();
      h.bridge.on("runInvalidated", invalidated);
      let binding: RunBinding | undefined;
      try {
        binding = await h.bridge.beginRun();
        if (controller.signal.aborted) return { status: "not_started" };
        h.emit("agent_start", ctx);
        const settled = deferred<void>();
        const context = Promise.resolve(h.emit("context", ctx, { messages: [] }))
          .catch((error: unknown) => error)
          .then((result) => {
            if (!controller.signal.aborted) providerDispatches++;
            return result;
          });
        flights.push({ binding, ctx, controller, settled, context });
        await settled.promise;
        return { status: "settled", aborted: controller.signal.aborted };
      } catch (error) {
        if (controller.signal.aborted && !binding) return { status: "not_started" };
        throw error;
      } finally {
        if (binding) h.bridge.finishRun(binding);
        h.bridge.off("runInvalidated", invalidated);
      }
    }),
    close: async () => {
      retired = true;
    },
  });
  // Existing owner resource port only; real scheduler, host and extension handlers are exercised.
  vi.mocked(startPiSession).mockResolvedValue(
    session as unknown as Awaited<ReturnType<typeof startPiSession>>,
  );
  let now = 0;
  const scheduler = new JudgmentScheduler({
    bridge: h.bridge,
    dataDirectory: "/unused",
    executable: "unused",
    bundledExtension: "/unused",
    model: { provider: "p", id: "m", apiKey: "unused" },
    connection: { protocolVersion: 1, host: "127.0.0.1", port: 1, token: "unused", pid: 1 },
    monotonicNow: () => now,
  });
  onTestFinished(() => scheduler.close());
  const faults: Error[] = [];
  scheduler.on("fault", (error) => faults.push(error));
  await drain();
  expect(flights).toHaveLength(1);
  await h.game.client.call("game.player_message", { ...h.world, text: "retained" });
  // Poll reason is queued behind the still-running context, not a separate judgment.
  now = 60_000;
  expect(scheduler.poll(h.world)).toBe(true);
  expect(flights[0]!.controller.signal.aborted).toBe(false);
  expect(h.agent.host.calls).not.toContain("director.run.invalidate");
  h.native[0]!.result.reject(new RpcError(-32001, "Inactive or stale execution binding"));
  await flights[0]!.context;
  expect(h.agent.client.isClosed).toBe(false);
  expect(retired).toBe(false);
  expect(providerDispatches).toBe(0);
  expect(flights[0]!.controller.signal.aborted).toBe(true);
  expect(h.bridge.currentWorld!.paused).toBe(false); // No fabricated pause fact/history.
  expect(h.rows).toHaveLength(3); // attach, first reasons, input, no inferred status row.
  await expect(
    h.tools
      .get("send_message")!
      .execute("id", { text: "stale" }, flights[0]!.controller.signal, undefined, flights[0]!.ctx),
  ).rejects.toThrow();
  h.emit("agent_end", flights[0]!.ctx);
  expect(session.judge).toHaveBeenCalledTimes(1);
  expect(() =>
    h.agent.client.receive("director.run.bind", { ...flights[0]!.binding, runId: "too-early" }),
  ).toThrow();
  h.emit("agent_settled", flights[0]!.ctx);
  flights[0]!.settled.resolve();
  await drain();
  expect(session.judge).toHaveBeenCalledTimes(2); // Host-only reservation waits, no native bind.
  expect(h.game.host.calls.filter((method) => method === "game.run.bind")).toHaveLength(1);
  expect(h.native).toHaveLength(1);
  await expect(
    h.game.client.call("game.status", { ...h.world, paused: false, extra: true }),
  ).rejects.toMatchObject({ code: -32602 });
  await drain();
  expect(session.judge).toHaveBeenCalledTimes(2);
  await h.game.client.call("game.status", { ...h.world, paused: true });
  await drain();
  expect(session.judge).toHaveBeenCalledTimes(2);
  await h.game.client.call("game.status", { ...h.world, paused: false });
  await drain();
  expect(flights).toHaveLength(2);
  expect(JSON.parse(session.judge.mock.calls[2]![0])).toMatchObject({
    playerMessages: ["retained"],
    poll: true,
  });
  expect(h.native[1]!.params.runId).not.toBe(flights[0]!.binding.runId);
  h.native[1]!.result.resolve({ ...flights[1]!.binding, state: { ...snapshot, tick: 999 } });
  expect(await flights[1]!.context).toMatchObject({
    messages: [{ content: expect.stringContaining('"tick":999') }],
  });
  expect(providerDispatches).toBe(1);
  expect(faults).toEqual([]);
  expect(retired).toBe(false);
  h.emit("agent_settled", flights[1]!.ctx);
  flights[1]!.settled.resolve();
  await drain();
});

const forwards = [
  ["game.state.get", { query: {} }],
  ["game.message.send", { text: "hello" }],
  ["game.files.list", { query: {} }],
  ["game.files.read", { query: { root: "minecraft:0", path: "data/a.json" } }],
  ["game.files.search", { query: { root: "minecraft:0", path: "data", text: "a" } }],
] as const;

test.each(forwards)(
  "owned native withdrawal before status is scoped for %s",
  async (method, args) => {
    const h = await fixture();
    const binding = await h.bridge.beginRun();
    const pending = h.agent.client
      .call(method, { ...binding, ...args })
      .catch((error: unknown) => error);
    expect(h.native).toHaveLength(1);
    h.native[0]!.result.reject(new RpcError(-32001, "native stale"));
    expect(await pending).toMatchObject({ code: staleRunErrorCode, data: binding });
    expect(h.agent.host.calls).toContain("director.run.invalidate");
    expect(h.bridge.readyWorld!.paused).toBe(false);
    expect(h.bridge.currentWorld!.paused).toBe(false);
  },
);

test("after-status native stale does not gate validated availability", async () => {
  const h = await fixture();
  const binding = await h.bridge.beginRun();
  const pending = h.agent.client
    .call("game.state.get", { ...binding, query: {} })
    .catch((error: unknown) => error);
  await h.game.client.call("game.status", { ...h.world, paused: true });
  await h.game.client.call("game.status", { ...h.world, paused: false });
  h.native[0]!.result.reject(new RpcError(-32001, "native stale"));
  expect(await pending).toMatchObject({ code: staleRunErrorCode, data: binding });
  expect(h.bridge.readyWorld!.paused).toBe(false);
  h.emit("agent_settled", h.context().ctx);
  expect(h.bridge.finishRun(binding)).toBe(true);
  let admitted: RunBinding | undefined;
  const admission = h.bridge.beginRun().then(
    (next) => {
      admitted = next;
    },
    (error: unknown) => error,
  );
  try {
    await drain();
    expect(h.game.host.calls.filter((method) => method === "game.run.bind")).toHaveLength(2);
    expect(h.agent.host.calls.filter((method) => method === "director.run.bind")).toHaveLength(2);
    expect(admitted).toMatchObject(h.world);
    expect(admitted!.runId).not.toBe(binding.runId);
  } finally {
    await h.bridge.close();
    await admission;
  }
});

test("old capture cannot invalidate or gate a new owner", async () => {
  const h = await fixture();
  const first = await h.bridge.beginRun();
  const pending = h.agent.client
    .call("game.state.get", { ...first, query: {} })
    .catch((error: unknown) => error);
  h.bridge.invalidateRun("cancelled");
  h.emit("agent_settled", h.context().ctx);
  h.bridge.finishRun(first);
  const next = await h.bridge.beginRun();
  const before = h.agent.host.calls.filter((method) => method === "director.run.invalidate").length;
  h.native[0]!.result.reject(new RpcError(-32001, "old native stale"));
  expect(await pending).toMatchObject({ code: -32001 });
  expect(h.agent.host.calls.filter((method) => method === "director.run.invalidate")).toHaveLength(
    before,
  );
  expect(h.bridge.readyWorld!.paused).toBe(false);
  const fresh = h.agent.client.call("game.state.get", { ...next, query: {} });
  h.native[1]!.result.resolve({ ...next, state: snapshot });
  await expect(fresh).resolves.toMatchObject({ runId: next.runId });
});

test.each([
  new RpcError(-32603, "data"),
  new RpcError(-32602, "params"),
  new RpcError(-32010, "auth"),
  new RpcError(-32004, "storage"),
  new RpcError(-32123, "arbitrary"),
  new RpcError(-32001, "non-native data", { runId: "foreign" }),
  new Error("transport"),
])("fatal native failure is unchanged despite cancellation: %s", async (failure) => {
  const h = await fixture();
  const binding = await h.bridge.beginRun();
  const pending = h.agent.client
    .call("game.state.get", { ...binding, query: {} })
    .catch((error: unknown) => error);
  h.bridge.invalidateRun("cancelled");
  h.native[0]!.result.reject(failure);
  expect(await pending).toBe(failure);
  expect(h.bridge.readyWorld!.paused).toBe(false);
});

test("captured displayed ACK is recorded before stale fence; storage failure remains latched", async () => {
  const h = await fixture();
  const binding = await h.bridge.beginRun();
  const pending = h.agent.client
    .call("game.message.send", { ...binding, text: "hello" })
    .catch((error: unknown) => error);
  h.bridge.invalidateRun("cancelled");
  h.native[0]!.result.resolve({ ...binding, displayed: true });
  expect(await pending).toMatchObject({ code: staleRunErrorCode });
  expect(h.rows.at(-1)).toMatchObject({
    event: "director.hud_displayed",
    data: { runId: binding.runId, text: "hello" },
  });
  h.emit("agent_settled", h.context().ctx);
  h.bridge.finishRun(binding);
  const next = await h.bridge.beginRun();
  const failed = h.agent.client
    .call("game.message.send", { ...next, text: "hello" })
    .catch((error: unknown) => error);
  const failure = new Error("storage");
  h.failStorage(failure);
  const faults: Error[] = [];
  h.bridge.on("fault", (error) => faults.push(error));
  h.native[1]!.result.resolve({ ...next, displayed: true });
  expect(await failed).toBe(failure);
  expect(faults).toEqual([failure]);
  expect(h.bridge.readyWorld).toBeUndefined();
});

test.each(["version1", "missing-visibility"])("rejects unsafe %s snapshots", async (kind) => {
  const h = await fixture();
  const binding = await h.bridge.beginRun();
  const pending = h.agent.client
    .call("game.state.get", { ...binding, query: {} })
    .catch((error: unknown) => error);
  const state =
    kind === "version1"
      ? { ...snapshot, version: 1 }
      : { ...snapshot, nearby: { ...snapshot.nearby, visibility: undefined } };
  h.native[0]!.result.resolve({ ...binding, state });
  expect(await pending).toMatchObject({ code: -32603 });
});

test.each(["malformed", "foreign"])(
  "fulfilled %s state stays fatal under cancellation",
  async (kind) => {
    const h = await fixture();
    const binding = await h.bridge.beginRun();
    const pending = h.agent.client
      .call("game.state.get", { ...binding, query: {} })
      .catch((error: unknown) => error);
    h.bridge.invalidateRun("cancelled");
    h.native[0]!.result.resolve({
      ...binding,
      runId: kind === "foreign" ? "foreign" : binding.runId,
      state: kind === "malformed" ? {} : snapshot,
    });
    expect(await pending).toMatchObject({ code: -32603 });
  },
);

test.each(["cancel", "detach", "closing", "storage"])(
  "unknown-availability admission wakes safely on %s without status",
  async (kind) => {
    const h = await fixture();
    const binding = await h.bridge.beginRun();
    const pending = h.agent.client
      .call("game.state.get", { ...binding, query: {} })
      .catch((error: unknown) => error);
    h.native[0]!.result.reject(new RpcError(-32001, "native stale"));
    expect(await pending).toMatchObject({ code: staleRunErrorCode });
    h.emit("agent_settled", h.context().ctx);
    h.bridge.finishRun(binding);
    let completed = false;
    const waiting = h.bridge.beginRun().catch((error: unknown) => {
      completed = true;
      return error;
    });
    await drain();
    expect(completed).toBe(false);
    expect(h.game.host.calls.filter((method) => method === "game.run.bind")).toHaveLength(1);
    if (kind === "cancel") h.bridge.invalidateRun("pi_session_closed");
    else if (kind === "detach") h.game.client.close();
    else if (kind === "closing") await h.bridge.close();
    else {
      h.bridge.on("fault", () => {});
      const failure = new Error("storage");
      h.failStorage(failure);
      await expect(h.game.client.call("game.status", { ...h.world, paused: false })).rejects.toBe(
        failure,
      );
    }
    expect(await waiting).toMatchObject({
      code: kind === "cancel" || kind === "detach" ? staleRunErrorCode : -32001,
    });
    expect(h.game.host.calls.filter((method) => method === "game.run.bind")).toHaveLength(1);
  },
);

test("closing never upgrades native stale to owned cancellation", async () => {
  const h = await fixture();
  const binding = await h.bridge.beginRun();
  const pending = h.agent.client
    .call("game.state.get", { ...binding, query: {} })
    .catch((error: unknown) => error);
  await h.bridge.close();
  h.native[0]!.result.reject(new RpcError(-32001, "native stale"));
  expect(await pending).not.toMatchObject({ code: staleRunErrorCode });
});
