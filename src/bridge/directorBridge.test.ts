import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import type { Server } from "node:net";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import type { EventLog } from "../events/eventLog.js";
import type { ActivityLog } from "../events/activityLog.js";
import type { HistorySummaries } from "../storage/historySummaries.js";
import type { ResponseHook, ResponseHooks } from "../hooks/responseHooks.js";
import type { GameEvent } from "../protocol/gameEvent.js";
import extension from "../pi/directorBridge.js";
import { directorToolNames } from "../pi/piPolicy.js";
import { staleRunErrorCode, type RunBinding, type WorldBinding } from "../protocol/bridge.js";
import snapshot from "../protocol/fixtures/gameSnapshot.json" with { type: "json" };
import { JudgmentScheduler } from "../runtime/judgmentScheduler.js";
import { HistoryWorker } from "../runtime/historyWorker.js";
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
  const observations: GameEvent[] = [];
  let storageError: Error | undefined;
  let activityError: Error | undefined;
  let appendsBeforeFailure = 0;
  const activityDb = {};
  const matchedHooks: ResponseHook[] = [];
  const registeredHooks: ResponseHook[] = [];
  const rawSearch = vi.fn(() => ({ events: [], through: 41, hasKnownGaps: true, nextCursor: 3 }));
  const activitySearch = vi.fn(() => ({
    events: [],
    through: 9,
    hasKnownGaps: false,
    nextCursor: 2,
  }));
  const eventLog = {
    db: {},
    atomic: <T>(mutate: () => T): T => {
      const before = observations.length;
      try {
        return mutate();
      } catch (error) {
        observations.splice(before);
        throw error;
      }
    },
    append: (value: GameEvent) => {
      if (storageError && appendsBeforeFailure-- <= 0) throw storageError;
      observations.push(value);
      return { id: observations.length, observation: value };
    },
    search: rawSearch,
    catalog: {
      list: () => supportedEvents.map((name) => ({ name })),
      validateFilter: vi.fn(),
    },
  } as unknown as EventLog;
  const activityLog = {
    db: activityDb,
    atomic: <T>(mutate: () => T): T => {
      const before = rows.length;
      const hooksBefore = [...registeredHooks];
      try {
        return mutate();
      } catch (error) {
        rows.splice(before);
        registeredHooks.splice(0, registeredHooks.length, ...hooksBefore);
        throw error;
      }
    },
    appendActivity: (value: unknown) => {
      if (activityError || storageError) throw activityError ?? storageError;
      rows.push(value);
      return { id: rows.length, observation: value };
    },
    appendActivities: (values: unknown[]) => {
      if (activityError || storageError) throw activityError ?? storageError;
      rows.push(...values);
    },
    search: activitySearch,
  } as unknown as ActivityLog;
  const hooks = {
    db: activityDb,
    catalog: eventLog.catalog,
    match: vi.fn(() => matchedHooks),
    add: (_scope: unknown, input: Omit<ResponseHook, "id">) => {
      const hook = { ...input, filter: input.filter ?? {}, id: "registered-hook" };
      registeredHooks.push(hook);
      return hook;
    },
    remove: (_scope: unknown, id: string) => {
      const index = registeredHooks.findIndex((hook) => hook.id === id);
      if (index < 0) return false;
      registeredHooks.splice(index, 1);
      return true;
    },
    list: () => ({ hooks: [...registeredHooks] }),
  } as unknown as ResponseHooks;
  const bridge = new DirectorBridge(
    {
      token: "a".repeat(43),
      eventLog,
      activityLog,
      history: {
        context: () => "",
        next: () => undefined,
        save: () => {},
      } as unknown as HistorySummaries,
      hooks,
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
  const memoryContext = vi.spyOn(bridge.history, "context").mockReturnValue("");
  const complete = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
    Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "石を採掘した。" }] }),
  );
  function context() {
    const controller = new AbortController();
    const ctx = {
      mode: "rpc",
      model: { api: "openai-completions", provider: "openai", id: "gpt-6-luna" },
      modelRegistry: {
        find: () => ({ api: "openai-completions", provider: "openai", id: "gpt-6-luna" }),
        complete,
      },
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
    observations,
    eventLog,
    activityLog,
    rawSearch,
    activitySearch,
    hooks,
    matchedHooks,
    world,
    context,
    emit,
    tools,
    complete,
    memoryContext,
    failActivities: (error: Error) => {
      activityError = error;
    },
    failStorage: (error: Error, afterObservations = 0) => {
      storageError = error;
      appendsBeforeFailure = afterObservations;
    },
  };
}

test("history completion is independent of run admission and rejects cancelled late results", async () => {
  const h = await fixture();
  expect(
    await h.bridge.summarizeHistory(h.world, "observed events", new AbortController().signal),
  ).toBe("石を採掘した。");
  expect(h.native).toHaveLength(0);
  expect(h.complete.mock.calls[0]![2]).toMatchObject({
    serviceTier: "priority",
    reasoningEffort: "low",
  });
  const response = deferred<unknown>();
  h.complete.mockImplementation(() => response.promise);
  const controller = new AbortController();
  const pending = h.bridge.summarizeHistory(h.world, "more observations", controller.signal);
  controller.abort();
  expect((h.complete.mock.calls[1]![2] as { signal: AbortSignal }).signal.aborted).toBe(true);
  await expect(
    h.bridge.summarizeHistory(h.world, "overlap", new AbortController().signal),
  ).rejects.toThrow("History summarizer is not available");
  const rejected = expect(pending).rejects.toThrow();
  response.resolve({ stopReason: "stop", content: [{ type: "text", text: "late" }] });
  await rejected;
});

test.each([false, true])(
  "real bridge stores in-flight memory across pause; resumed=%s",
  async (resume) => {
    const h = await fixture();
    const attached = h.bridge.readyWorld!;
    vi.spyOn(h.bridge.history, "next").mockReturnValue({
      source: {
        after: 0,
        through: 1,
        sourceSessionId: h.world.worldSessionId,
        sourceCount: 1,
        firstObservedAt: 1,
        lastObservedAt: 1,
        input: "attachment observed",
      },
      backlog: false,
    });
    const save = vi.spyOn(h.bridge.history, "save").mockImplementation(() => {});
    const response = deferred<unknown>();
    h.complete.mockImplementation(() => response.promise);
    let now = 0;
    const worker = new HistoryWorker({ bridge: h.bridge, now: () => now });
    try {
      now = 60_000;
      expect(worker.poll(h.world)).toBe(true);
      const signal = (h.complete.mock.calls[0]![2] as { signal: AbortSignal }).signal;
      await h.game.client.call("game.status", { ...h.world, paused: true });
      expect(signal.aborted).toBe(false);
      expect(attached.paused).toBe(false); // Host emits fresh snapshots, never its mutable world.
      expect(worker.poll(h.world)).toBe(false);
      if (resume) await h.game.client.call("game.status", { ...h.world, paused: false });
      response.resolve({ stopReason: "stop", content: [{ type: "text", text: "completed" }] });
      await drain();
      expect(save).toHaveBeenCalledOnce();
      expect(save.mock.calls[0]![2]).toBe("completed");
    } finally {
      response.resolve({ stopReason: "stop", content: [{ type: "text", text: "cleanup" }] });
      await worker.close();
    }
  },
);

test("saved history is authenticated, run-bound, fresh and not exposed as a new game tool", async () => {
  const h = await fixture();
  const run = await h.bridge.beginRun();
  h.memoryContext.mockReturnValue("saved memory");
  expect(await h.agent.client.call("director.history.get", run)).toEqual({
    ...run,
    text: "saved memory",
  });
  expect(h.memoryContext).toHaveBeenCalledWith({
    worldId: run.worldId,
    playerId: run.playerId,
  });
  await expect(h.game.client.call("director.history.get", run)).rejects.toThrow(
    "forbidden bridge role",
  );
  await expect(
    h.agent.client.call("director.history.get", { ...run, runId: "stale" }),
  ).rejects.toThrow();
  expect(h.tools.size).toBe(10);
});

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
    expect(h.observations.slice(0, events.length)).toEqual(events); // Whole raw batch persisted before its first delivery.
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
  const nextId = h.observations.length + 1;
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
  const before = { activities: [...h.rows], observations: [...h.observations] };
  for (const params of [
    { events: [] },
    { events: [event, { ...event, seq: 2, worldSessionId: "stale" }] },
    { events: [event, { ...event, seq: 2, event: "health_changed" }] },
    { events: [event, { ...event, seq: 2, observedAt: "now" }] },
    { events: [event], extra: true },
    { events: Array(1025).fill(event) },
  ]) {
    await expect(h.game.client.call("game.events", params)).rejects.toThrow();
    expect({ activities: h.rows, observations: h.observations }).toEqual(before);
  }
  await expect(h.agent.client.call("game.events", { events: [event] })).rejects.toMatchObject({
    code: -32010,
  });
  h.failStorage(new Error("write failed"));
  await expect(h.game.client.call("game.events", { events: [event] })).rejects.toThrow(
    "write failed",
  );
  expect({ activities: h.rows, observations: h.observations }).toEqual(before);
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
  const before = { activities: [...h.rows], observations: [...h.observations] };
  const delivered: unknown[] = [];
  h.bridge.on("observation", (stored) => delivered.push(stored));
  h.failStorage(new Error("second write failed"), 1);
  await expect(
    h.game.client.call("game.events", { events: [event, { ...event, seq: 2 }] }),
  ).rejects.toThrow("second write failed");
  expect({ activities: h.rows, observations: h.observations }).toEqual(before);
  expect(delivered).toEqual([]);
});

test.each(["match", "audit"])(
  "%s failure leaves the raw batch durable but emits no observation or ACK",
  async (stage) => {
    const h = await fixture(["block_broken"]);
    const events = [1, 2].map((seq) => ({
      ...h.world,
      seq,
      tick: 20,
      observedAt: 1000,
      event: "block_broken",
      dimension: "minecraft:overworld",
      position: [1, 2, 3],
      data: {},
    }));
    h.matchedHooks.push({ id: "hook", event: "block_broken", filter: {}, instruction: "report" });
    const before = [...h.rows];
    const failure = new Error(`${stage} failed`);
    if (stage === "match")
      vi.spyOn(h.hooks, "match").mockImplementation(() => {
        expect(h.observations).toEqual(events); // Raw commit precedes activity work.
        throw failure;
      });
    else {
      const append = h.activityLog.appendActivity.bind(h.activityLog);
      vi.spyOn(h.activityLog, "appendActivity")
        .mockImplementationOnce(append)
        .mockImplementationOnce(() => {
          throw failure;
        });
    }
    const delivered = vi.fn();
    const faults = vi.fn();
    h.bridge.on("observation", delivered);
    h.bridge.on("fault", faults);
    await expect(h.game.client.call("game.events", { events })).rejects.toBe(failure);
    expect(h.observations).toEqual(events);
    expect(h.rows).toEqual(before); // The whole activity audit batch rolls back.
    expect(delivered).not.toHaveBeenCalled();
    expect(faults).toHaveBeenCalledExactlyOnceWith(failure);
    expect(h.bridge.readyWorld).toBeUndefined();
  },
);

test("event queries keep raw and explicit Director activity cursors independent", async () => {
  const h = await fixture(["block_broken"]);
  const run = await h.bridge.beginRun();
  for (const query of [{}, { event: "block_broken", after: 3, through: 41, limit: 1 }]) {
    await expect(h.agent.client.call("director.events.get", { ...run, query })).resolves.toEqual({
      events: [],
      through: 41,
      hasKnownGaps: true,
      nextCursor: 3,
    });
    expect(h.rawSearch).toHaveBeenLastCalledWith({ worldId: "w", playerId: "p" }, query);
  }
  const query = {
    event: "director.status_reported",
    filter: { paused: true },
    after: 2,
    through: 9,
    limit: 1,
  };
  await expect(h.agent.client.call("director.events.get", { ...run, query })).resolves.toEqual({
    events: [],
    through: 9,
    hasKnownGaps: false,
    nextCursor: 2,
  });
  expect(h.activitySearch).toHaveBeenCalledExactlyOnceWith({ worldId: "w", playerId: "p" }, query);
  expect(h.rawSearch).toHaveBeenCalledTimes(2);
  const result = (await h.agent.client.call("director.events.list", run)) as { events: unknown[] };
  expect(result.events).toContainEqual(
    expect.objectContaining({ name: "block_broken", origin: "game", hookable: true }),
  );
  expect(result.events).toContainEqual(
    expect.objectContaining({ name: "director.status_reported", origin: "cli", hookable: false }),
  );
});

test.each(["add", "remove"])(
  "hook %s rolls back its mutation when activity audit fails",
  async (method) => {
    const h = await fixture(["block_broken"]);
    const run = await h.bridge.beginRun();
    const added = (await h.agent.client.call("director.hooks.add", {
      ...run,
      event: "block_broken",
      instruction: "report",
    })) as ResponseHook;
    expect(h.rows.at(-1)).toMatchObject({
      event: "director.hook_added",
      data: { hookId: added.id },
    });
    const before = h.hooks.list(h.world);
    const rawAtomic = vi.spyOn(h.eventLog, "atomic");
    const failure = new Error("audit failed");
    h.failActivities(failure);
    const params =
      method === "add"
        ? { ...run, event: "block_broken", instruction: "report again" }
        : { ...run, id: added.id };
    await expect(h.agent.client.call(`director.hooks.${method}`, params)).rejects.toBe(failure);
    expect(h.hooks.list(h.world)).toEqual(before);
    expect(h.observations).toEqual([]);
    expect(rawAtomic).not.toHaveBeenCalled();
  },
);

test.each(["raw", "hooks"])("bridge rejects invalid %s database ownership", (invalid) => {
  const raw = {};
  const activities = {};
  expect(
    () =>
      new DirectorBridge(
        {
          token: "a".repeat(43),
          eventLog: { db: raw } as EventLog,
          activityLog: { db: invalid === "raw" ? raw : activities } as ActivityLog,
          hooks: { db: invalid === "hooks" ? raw : activities } as ResponseHooks,
          history: {} as HistorySummaries,
        },
        () => new EventEmitter() as Server,
      ),
  ).toThrow(invalid === "raw" ? /separate/ : /Activity.*hooks/);
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
  expect(h.game.host.calls.filter((method) => method === "game.run.bind")).toHaveLength(1);
  await h.game.client.call("game.status", { ...h.world, paused: false });
  await drain();
  expect(flights).toHaveLength(2);
  expect(JSON.parse(session.judge.mock.calls[1]![0])).toMatchObject({
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
  "pause preserves admitted %s and subsequent state access",
  async (method, args) => {
    const h = await fixture();
    const binding = await h.bridge.beginRun();
    const invalidated = vi.fn();
    h.bridge.on("runInvalidated", invalidated);
    const pending = h.agent.client
      .call(method, { ...binding, ...args })
      .catch((error: unknown) => error);
    await h.game.client.call("game.status", { ...h.world, paused: true });
    const result =
      method === "game.state.get"
        ? { state: snapshot }
        : method === "game.message.send"
          ? { displayed: true }
          : method === "game.files.list"
            ? { reference: { kind: "roots", roots: [], nextCursor: null } }
            : method === "game.files.read"
              ? { reference: { root: "minecraft:0", path: "data/a.json", content: "{}", bytes: 2 } }
              : {
                  reference: {
                    root: "minecraft:0",
                    path: "data",
                    text: "a",
                    matches: [],
                    scanned: 0,
                    nextCursor: null,
                    firstMatchPerFile: true,
                  },
                };
    h.native[0]!.result.resolve({ ...binding, ...result });
    expect(await pending).toEqual({ ...binding, ...result });
    const nextState = h.agent.client.call("game.state.get", { ...binding, query: {} });
    h.native[1]!.result.resolve({ ...binding, state: snapshot });
    expect(await nextState).toEqual({ ...binding, state: snapshot });
    await h.game.client.call("game.status", { ...h.world, paused: false });
    expect(await h.agent.client.call("director.history.get", binding)).toEqual({
      ...binding,
      text: "",
    });
    expect(invalidated).not.toHaveBeenCalled();
    expect(h.agent.host.calls).not.toContain("director.run.invalidate");
    expect(h.bridge.finishRun(binding)).toBe(true);
  },
);

test("pause still prevents admission of a new run", async () => {
  const h = await fixture();
  await h.game.client.call("game.status", { ...h.world, paused: true });
  await expect(h.bridge.beginRun()).rejects.toThrow();
  expect(h.game.host.calls).not.toContain("game.run.bind");
});

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

test("earlier pause/resume cannot mask a later genuine native withdrawal", async () => {
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
    expect(admitted).toBeUndefined();
    expect(h.game.host.calls.filter((method) => method === "game.run.bind")).toHaveLength(1);
    await h.game.client.call("game.status", { ...h.world, paused: false });
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
