import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { EventCatalog } from "../events/eventCatalog.js";
import { gameEventDefinitions, type GameEvent } from "../protocol/gameEvent.js";
import { staleRunErrorCode, type RunBinding, type SessionBinding } from "../protocol/bridge.js";
import { hisyoTools } from "../protocol/hisyoTools.js";
import type { TokenUsageData } from "../protocol/tokenUsage.js";
import snapshot from "../protocol/fixtures/gameState.json" with { type: "json" };
import { initializeEventDatabase } from "../storage/eventDatabase.js";
import { initializeActivityDatabase } from "../storage/activityDatabase.js";
import { initializeSummaryDatabase } from "../storage/summaryDatabase.js";
import { EventLog } from "../storage/eventLog.js";
import { ActivityLog } from "../storage/activityLog.js";
import { HookStore, type Hook } from "../storage/hookStore.js";
import { SummaryStore } from "../storage/summaryStore.js";
import { RpcError, RpcPeer } from "../transport/rpcPeer.js";
import { BridgeServer } from "./bridgeServer.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const scope = ({ worldId, playerId }: SessionBinding) => ({ worldId, playerId });
const drain = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Real host, JSON-RPC/TCP and three SQLite stores; only the native game producer is fake. */
async function fixture(supportedEvents: string[] = []) {
  const rawDb = new DatabaseSync(":memory:");
  const activityDb = new DatabaseSync(":memory:");
  const summaryDb = new DatabaseSync(":memory:");
  initializeEventDatabase(rawDb);
  initializeActivityDatabase(activityDb);
  initializeSummaryDatabase(summaryDb);
  const catalog = new EventCatalog(gameEventDefinitions);
  const eventLog = new EventLog(rawDb, catalog);
  const activityLog = new ActivityLog(activityDb);
  const hooks = new HookStore(activityDb, catalog);
  const summaries = new SummaryStore(eventLog, summaryDb);
  const bridge = new BridgeServer({
    token: "a".repeat(43),
    eventLog,
    activityLog,
    hooks,
    summaries,
  });
  const faults: Error[] = [];
  bridge.on("fault", (error) => faults.push(error));
  const address = await bridge.listen();
  const clients: RpcPeer[] = [];
  onTestFinished(async () => {
    await bridge.close();
    for (const client of clients) client.close();
    rawDb.close();
    activityDb.close();
    summaryDb.close();
  });
  async function connect(role = "game", version = 2, token = "a".repeat(43)) {
    const socket = createConnection(address);
    await once(socket, "connect");
    const peer = new RpcPeer(socket);
    clients.push(peer);
    await peer.call("bridge.hello", { protocolVersion: version, role, token });
    return peer;
  }
  const game = await connect();
  const binds: RunBinding[] = [];
  const clears: RunBinding[] = [];
  const requests: {
    method: string;
    params: RunBinding & Record<string, unknown>;
    result: ReturnType<typeof deferred<unknown>>;
  }[] = [];
  const arrivals = new EventEmitter();
  game.handle("game.run.bind", (params) => {
    binds.push(params as RunBinding);
    return params;
  });
  game.handle("game.run.clear", (params) => {
    clears.push(params as RunBinding);
    return undefined;
  });
  for (const method of [
    "game.state.get",
    "game.message.send",
    "game.files.list",
    "game.files.read",
    "game.files.search",
  ]) {
    game.handle(method, (params) => {
      const result = deferred<unknown>();
      requests.push({ method, params: params as RunBinding & Record<string, unknown>, result });
      arrivals.emit("request");
      return result.promise;
    });
  }
  async function native(index = 0) {
    while (!requests[index]) await once(arrivals, "request");
    return requests[index]!;
  }
  async function attach(worldId = "w", playerId = "p") {
    const binding = (await game.call("game.attach", {
      worldId,
      playerId,
      language: "ja_jp",
      supportedEvents,
      paused: false,
    })) as SessionBinding;
    await game.call("game.ready", binding);
    return binding;
  }
  const world = await attach();
  const rows = (event?: string, scope = world) =>
    activityLog
      .search(
        { worldId: scope.worldId, playerId: scope.playerId },
        event ? { event, limit: 500 } : { limit: 500 },
      )
      .events.map(({ activity }) => activity);
  const observations = () =>
    eventLog.search(scope(world), { limit: 500 }).events.map(({ observation }) => observation);
  function failActivities(event?: string) {
    activityDb.exec(
      `CREATE TRIGGER fail_activity BEFORE INSERT ON activities ${event ? `WHEN NEW.event = '${event}'` : ""} BEGIN SELECT RAISE(ABORT, 'activity write failed'); END;`,
    );
  }
  return {
    bridge,
    game,
    world,
    connect,
    attach,
    native,
    requests,
    binds,
    clears,
    rows,
    observations,
    eventLog,
    activityLog,
    hooks,
    summaries,
    rawDb,
    activityDb,
    summaryDb,
    faults,
    failActivities,
  };
}

function observation(binding: SessionBinding, seq = 1): GameEvent {
  return {
    ...binding,
    seq,
    tick: 20,
    observedAt: 1000 + seq,
    event: "block_broken",
    dimension: "minecraft:overworld",
    position: [1, 2, 3],
    data: { blockId: "minecraft:stone", position: [1, 2, 3] },
  };
}
const tokens = { input: 140, output: 20, cacheRead: 40, cacheWrite: null, total: 160 };
const usage = (requestId: string, source: "run" | "summary" = "run"): TokenUsageData => ({
  source,
  requestId,
  provider: "openai",
  model: "gpt-6-luna",
  api: "openai-completions",
  stopReason: "stop",
  ...tokens,
});

test("trusted host begins without any agent socket and records each response into SQLite", async () => {
  const h = await fixture();
  const run = await h.bridge.beginRun();
  expect(h.binds).toEqual([run]);
  h.bridge.beginModelRequest(h.world, "run", run.runId);
  expect(h.bridge.recordUsage({ ...h.world, ...usage(run.runId) })).toEqual({ recorded: true });
  h.bridge.recordUsage({
    ...h.world,
    ...usage(run.runId),
    stopReason: "error",
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    total: null,
  });
  expect(h.rows("hisyo.token_usage").map(({ data }) => data)).toEqual([
    usage(run.runId),
    {
      ...usage(run.runId),
      stopReason: "error",
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      total: null,
    },
  ]);
  h.bridge.finishModelRequest(h.world, "run", run.runId);
  expect(() => h.bridge.recordUsage({ ...h.world, ...usage(run.runId) })).toThrow();
  expect(h.bridge.finishRun(run)).toBe(true);
  await drain();
  expect(h.clears).toEqual([run]);
});

test("agent role, old versions, wrong tokens and duplicate game connections are rejected", async () => {
  const h = await fixture();
  const ready = h.bridge.readySession;
  for (const args of [
    ["agent", 2],
    ["game", 1],
    ["game", 2, "b".repeat(43)],
  ] as const)
    await expect(h.connect(args[0], args[1], args[2])).rejects.toThrow();
  await expect(h.connect()).rejects.toMatchObject({ code: -32002 });
  expect(h.bridge.readySession).toEqual(ready);
  for (const method of [
    "hisyo.ready",
    "hisyo.run.bind",
    "hisyo.run.invalidate",
    "hisyo.usage.record",
    "hisyo.summary.get",
    "hisyo.summary.create",
    "hisyo.hooks.list",
    "game.state.get",
    "game.event",
    "director.ready",
  ]) {
    await expect(h.game.call(method, {})).rejects.toMatchObject({ code: -32601 });
  }
});

test("request lifecycle validates exact source, session, request ID and numeric counters", async () => {
  const h = await fixture();
  const run = await h.bridge.beginRun();
  const report = { ...h.world, ...usage(run.runId) };
  expect(() => h.bridge.recordUsage(report)).toThrow();
  expect(() => h.bridge.beginModelRequest(h.world, "run", "foreign")).toThrow();
  h.bridge.beginModelRequest(h.world, "run", run.runId);
  expect(() => h.bridge.beginModelRequest(h.world, "run", run.runId)).toThrow();
  for (const patch of [
    { sessionId: "foreign" },
    { requestId: "foreign" },
    { source: "summary" },
    { input: -1 },
    { total: 1.5 },
    { output: Number.MAX_SAFE_INTEGER + 1 },
    { secret: "PRIVATE_TOKEN" },
  ])
    expect(() => h.bridge.recordUsage({ ...report, ...patch })).toThrow();
  expect(h.rows("hisyo.token_usage")).toEqual([]);
  h.bridge.invalidateRun("cancelled");
  h.bridge.recordUsage({ ...report, stopReason: "aborted" });
  expect(h.rows("hisyo.token_usage")).toHaveLength(1);
  h.bridge.finishModelRequest(h.world, "run", run.runId);
  expect(() => h.bridge.recordUsage(report)).toThrow();
});

test("declared run settlement closes retained metering without touching independent summary ownership", async () => {
  const h = await fixture();
  const run = await h.bridge.beginRun();
  const summaryId = randomUUID();
  h.bridge.beginModelRequest(h.world, "run", run.runId);
  h.bridge.beginModelRequest(h.world, "summary", summaryId);
  h.bridge.invalidateRun("cancelled");
  h.bridge.recordUsage({ ...h.world, ...usage(run.runId), stopReason: "aborted" });
  h.bridge.finishRun(run);
  expect(() => h.bridge.recordUsage({ ...h.world, ...usage(run.runId) })).toThrow();
  expect(h.bridge.finishModelRequest(h.world, "run", run.runId)).toBe(false);
  h.bridge.recordUsage({ ...h.world, ...usage(summaryId, "summary") });
  expect(h.rows("hisyo.token_usage")).toHaveLength(2);
});

test("independent summary ownership starts paused, survives detach for late usage and ends explicitly", async () => {
  const h = await fixture();
  await h.game.call("game.status", { ...h.world, paused: true });
  const id = randomUUID();
  h.bridge.beginModelRequest(h.world, "summary", id);
  expect(h.binds).toEqual([]);
  expect(() => h.bridge.beginModelRequest(h.world, "summary", randomUUID())).toThrow();
  await h.game.call("game.detach", h.world);
  const replacement = await h.attach("new-world", "new-player");
  h.bridge.recordUsage({ ...h.world, ...usage(id, "summary"), stopReason: "aborted" });
  expect(h.rows("hisyo.token_usage")).toEqual([
    expect.objectContaining({
      ...h.world,
      data: { ...usage(id, "summary"), stopReason: "aborted" },
    }),
  ]);
  expect(h.rows("hisyo.token_usage", replacement)).toEqual([]);
  h.bridge.finishModelRequest(replacement, "summary", id);
  h.bridge.recordUsage({ ...h.world, ...usage(id, "summary") }); // Foreign finish never releases the owner.
  h.bridge.finishModelRequest(h.world, "summary", id);
  expect(() => h.bridge.recordUsage({ ...h.world, ...usage(id, "summary") })).toThrow();
  expect(() => h.bridge.beginModelRequest(h.world, "summary", randomUUID())).toThrow();
  h.bridge.beginModelRequest(replacement, "summary", randomUUID());
});

test.each(["run", "summary"] as const)(
  "%s usage storage failure is fatal and never acknowledged",
  async (source) => {
    const h = await fixture();
    const id = source === "run" ? (await h.bridge.beginRun()).runId : randomUUID();
    h.bridge.beginModelRequest(h.world, source, id);
    h.failActivities("hisyo.token_usage");
    expect(() => h.bridge.recordUsage({ ...h.world, ...usage(id, source) })).toThrow(
      "activity write failed",
    );
    expect(h.rows("hisyo.token_usage")).toEqual([]);
    expect(h.faults.map(({ message }) => message)).toEqual(["activity write failed"]);
    expect(h.bridge.readySession).toBeUndefined();
  },
);

test("saved summary context is run-bound, refreshed and not another game tool", async () => {
  const h = await fixture(["block_broken"]);
  const run = await h.bridge.beginRun();
  expect(h.bridge.summaryContext(run)).toBe("");
  await h.game.call("game.events", { events: [observation(h.world)] });
  const source = h.summaries.next(scope(h.world))!.source;
  h.summaries.save(scope(h.world), source, "saved summary", 2000);
  expect(h.bridge.summaryContext(run)).toContain("saved summary");
  expect(() => h.bridge.summaryContext({ ...run, runId: "stale" })).toThrow();
  expect(hisyoTools).toHaveLength(10);
  h.bridge.invalidateRun("cancelled");
  expect(() => h.bridge.summaryContext(run)).toThrow();
});

test("direct tool inputs enforce the exact ten-tool allowlist and schemas before side effects", async () => {
  const h = await fixture(["block_broken"]);
  const run = await h.bridge.beginRun();
  for (const [name, args] of [
    ["bash", {}],
    ["send_message", { text: " " }],
    ["send_message", { text: "hello", runId: "injected" }],
    ["get_game_state", { query: { nbt: true } }],
    ["list_game_files", { query: { root: "minecraft:0", path: "../secret" } }],
    ["add_hook", { event: "hisyo.status_reported", instruction: "bad" }],
    ["add_hook", { event: "block_broken", instruction: " " }],
    ["search_events", { query: { filter: {} } }],
  ] as const)
    await expect(h.bridge.executeTool(run, name, args)).rejects.toThrow();
  expect(h.requests).toEqual([]);
  expect(h.hooks.list(scope(h.world)).hooks).toEqual([]);
  const controller = new AbortController();
  controller.abort();
  await expect(
    h.bridge.executeTool(run, "send_message", { text: "cancelled" }, controller.signal),
  ).rejects.toThrow();
  expect(h.requests).toEqual([]);
});

test("async player intake must durably accept before the game receives an ACK", async () => {
  const h = await fixture();
  await expect(
    h.game.call("game.player_message", { ...h.world, text: "not accepted" }),
  ).rejects.toMatchObject({ code: -32003 });
  const retained = deferred<void>();
  const called = deferred<void>();
  const release = h.bridge.handlePlayerMessages((binding, text) => {
    expect(binding).toEqual(h.world);
    expect(text).toBe("hello");
    called.resolve();
    return retained.promise;
  });
  expect(() => h.bridge.handlePlayerMessages(() => {})).toThrow();
  let accepted = false;
  const pending = h.game
    .call("game.player_message", { ...h.world, text: "hello" })
    .then((result) => {
      accepted = true;
      return result;
    });
  await called.promise;
  await drain();
  expect(accepted).toBe(false);
  expect(h.rows("hisyo.player_input").at(-1)?.data).toEqual({ text: "hello" });
  retained.resolve();
  await expect(pending).resolves.toEqual({ accepted: true });
  release();
  await expect(
    h.game.call("game.player_message", { ...h.world, text: "late" }),
  ).rejects.toMatchObject({ code: -32003 });
});

test("failed asynchronous intake never claims player input was accepted", async () => {
  const h = await fixture();
  h.bridge.handlePlayerMessages(async () => {
    throw new Error("durable intake failed");
  });
  await expect(
    h.game.call("game.player_message", { ...h.world, text: "retained fact only" }),
  ).rejects.toMatchObject({ code: -32603 });
  expect(h.rows("hisyo.player_input")).toHaveLength(1);
});

test("event batches commit raw observations and hook audits before ordered delivery", async () => {
  const h = await fixture(["block_broken"]);
  const run = await h.bridge.beginRun();
  const hook = (await h.bridge.executeTool(run, "add_hook", {
    event: "block_broken",
    instruction: "report",
  })) as Hook;
  const events = Array.from({ length: 100 }, (_, index) => observation(h.world, index + 1));
  const delivered: GameEvent[] = [];
  h.bridge.on("observation", (stored, hooks) => {
    expect(h.observations().slice(0, 100)).toEqual(events);
    expect(hooks).toEqual([hook]);
    expect(h.rows("hisyo.hook_matched")).toContainEqual(
      expect.objectContaining({ data: { hookId: hook.id, sourceEventId: stored.id } }),
    );
    delivered.push(stored.observation);
  });
  await expect(h.game.call("game.events", { events })).resolves.toEqual({ stored: 100 });
  expect(delivered).toEqual(events);
  await expect(
    h.game.call("game.events", { events: [observation(h.world, 101)] }),
  ).resolves.toEqual({ stored: 1 });
  expect(delivered).toHaveLength(101);
});

test("observation intake is awaited once before diagnostics and the stored ACK", async () => {
  const h = await fixture(["block_broken"]);
  const entered = deferred<void>();
  const retained = deferred<void>();
  const admitted: number[] = [];
  const delivered: number[] = [];
  const release = h.bridge.handleObservations(async (stored) => {
    expect(h.observations()).toHaveLength(2);
    admitted.push(stored.id);
    entered.resolve();
    if (stored.id === 1) await retained.promise;
  });
  expect(() => h.bridge.handleObservations(() => {})).toThrow();
  h.bridge.on("observation", (stored) => delivered.push(stored.id));
  let acknowledged = false;
  const pending = h.game
    .call("game.events", { events: [observation(h.world), observation(h.world, 2)] })
    .then((result) => {
      acknowledged = true;
      return result;
    });
  await entered.promise;
  await drain();
  expect(admitted).toEqual([1]);
  expect(delivered).toEqual([]);
  expect(acknowledged).toBe(false);
  retained.resolve();
  await expect(pending).resolves.toEqual({ stored: 2 });
  expect(admitted).toEqual([1, 2]);
  expect(delivered).toEqual([1, 2]);
  release();
  await h.game.call("game.events", { events: [observation(h.world, 3)] });
  expect(admitted).toEqual([1, 2]);
  expect(delivered).toEqual([1, 2, 3]);
});

test.each([false, true])(
  "observation admission failure leaves raw persistence factual; owner handles stored ACK=%s",
  async (handled) => {
    const h = await fixture(["block_broken"]);
    const schedulerFaults: Error[] = [];
    h.bridge.handleObservations(async () => {
      const failure = new Error("durable queue failed");
      if (!handled) throw failure;
      schedulerFaults.push(failure); // Owner reports failure yet retains the already-stored ACK policy.
    });
    const pending = h.game.call("game.events", { events: [observation(h.world)] });
    if (handled) await expect(pending).resolves.toEqual({ stored: 1 });
    else await expect(pending).rejects.toMatchObject({ code: -32603 });
    expect(h.observations()).toEqual([observation(h.world)]);
    expect(schedulerFaults).toHaveLength(handled ? 1 : 0);
    expect(h.bridge.readySession).toBeDefined(); // No fictional storage rollback or storage-fault latch.
  },
);

test("event batches reject malformed input, foreign scope and unadvertised capabilities without partial persistence", async () => {
  const h = await fixture(["block_broken"]);
  const event = observation(h.world);
  for (const params of [
    { events: [] },
    { events: [event, { ...event, seq: 2, sessionId: "stale" }] },
    { events: [event, { ...event, seq: 2, event: "health_changed" }] },
    { events: [event, { ...event, seq: 2, observedAt: "now" }] },
    { events: [event], extra: true },
    { events: Array(1025).fill(event) },
  ]) {
    await expect(h.game.call("game.events", params)).rejects.toThrow();
    expect(h.observations()).toEqual([]);
    expect(h.rows()).toHaveLength(1);
  }
});

test("failed second raw insert rolls back the complete batch and delivers nothing", async () => {
  const h = await fixture(["block_broken"]);
  h.rawDb.exec(
    "CREATE TRIGGER fail_raw BEFORE INSERT ON events WHEN NEW.seq = 2 BEGIN SELECT RAISE(ABORT, 'second raw write failed'); END;",
  );
  const delivered = vi.fn();
  h.bridge.on("observation", delivered);
  await expect(
    h.game.call("game.events", { events: [observation(h.world), observation(h.world, 2)] }),
  ).rejects.toMatchObject({ code: -32603 });
  expect(h.observations()).toEqual([]);
  expect(delivered).not.toHaveBeenCalled();
  expect(h.faults[0]?.message).toBe("second raw write failed");
});

test.each(["match", "audit"])(
  "%s failure preserves committed raw batch but emits no delivery or ACK",
  async (stage) => {
    const h = await fixture(["block_broken"]);
    const run = await h.bridge.beginRun();
    await h.bridge.executeTool(run, "add_hook", { event: "block_broken", instruction: "report" });
    if (stage === "match")
      h.activityDb.exec("UPDATE hooks SET filter_json = '{\"unknownField\":true}';");
    else
      h.activityDb.exec(
        "CREATE TRIGGER fail_match BEFORE INSERT ON activities WHEN NEW.event = 'hisyo.hook_matched' AND json_extract(NEW.activity_json,'$.data.sourceEventId') = 2 BEGIN SELECT RAISE(ABORT, 'match audit failed'); END;",
      );
    const delivered = vi.fn();
    h.bridge.on("observation", delivered);
    const events = [observation(h.world), observation(h.world, 2)];
    await expect(h.game.call("game.events", { events })).rejects.toMatchObject({ code: -32603 });
    expect(h.observations()).toEqual(events);
    expect(h.rows("hisyo.hook_matched")).toEqual([]);
    expect(delivered).not.toHaveBeenCalled();
    expect(h.faults).toHaveLength(1);
    expect(h.bridge.readySession).toBeUndefined();
  },
);

test("event and activity searches retain separate high-water/cursor namespaces", async () => {
  const h = await fixture(["block_broken"]);
  const run = await h.bridge.beginRun();
  await h.game.call("game.events", { events: [observation(h.world, 2), observation(h.world, 3)] });
  await h.game.call("game.status", { ...h.world, paused: true });
  const raw = (await h.bridge.executeTool(run, "search_events", { query: { limit: 1 } })) as {
    through: number;
    nextCursor: number;
    hasKnownGaps: boolean;
  };
  expect(raw).toMatchObject({ through: 2, nextCursor: 1, hasKnownGaps: true });
  const logged = (await h.bridge.executeTool(run, "search_events", {
    query: { event: "hisyo.status_reported", filter: { paused: true } },
  })) as { events: unknown[]; through: number };
  expect(logged.events).toEqual([
    expect.objectContaining({
      activity: expect.objectContaining({ event: "hisyo.status_reported" }),
    }),
  ]);
  expect(logged.through).toBe(2);
  const catalog = (await h.bridge.executeTool(run, "list_event_types", {})) as {
    events: unknown[];
  };
  expect(catalog.events).toContainEqual(
    expect.objectContaining({ name: "block_broken", origin: "game", hookable: true }),
  );
  expect(catalog.events).toContainEqual(
    expect.objectContaining({ name: "hisyo.status_reported", origin: "cli", hookable: false }),
  );
});

test.each(["add_hook", "remove_hook"])(
  "%s mutation rolls back with a failed audit in real SQLite",
  async (name) => {
    const h = await fixture(["block_broken"]);
    const run = await h.bridge.beginRun();
    const hook = (await h.bridge.executeTool(run, "add_hook", {
      event: "block_broken",
      instruction: "report",
    })) as Hook;
    expect(h.rows("hisyo.hook_added")[0]?.data).toMatchObject({ hookId: hook.id });
    const before = h.hooks.list(scope(h.world));
    h.failActivities();
    const args =
      name === "add_hook" ? { event: "block_broken", instruction: "again" } : { id: hook.id };
    await expect(h.bridge.executeTool(run, name, args)).rejects.toThrow("activity write failed");
    expect(h.hooks.list(scope(h.world))).toEqual(before);
    expect(h.observations()).toEqual([]);
  },
);

test("list/remove hook tools preserve scoped results and audit only successful removals", async () => {
  const h = await fixture(["block_broken"]);
  const run = await h.bridge.beginRun();
  const hook = (await h.bridge.executeTool(run, "add_hook", {
    event: "block_broken",
    instruction: "report",
  })) as Hook;
  expect(await h.bridge.executeTool(run, "list_hooks", { limit: 1 })).toEqual({ hooks: [hook] });
  expect(await h.bridge.executeTool(run, "remove_hook", { id: hook.id })).toEqual({
    removed: true,
  });
  expect(await h.bridge.executeTool(run, "remove_hook", { id: hook.id })).toEqual({
    removed: false,
  });
  expect(h.rows("hisyo.hook_removed")).toHaveLength(1);
});

test("attachment retains language; legacy binding fields and invalid languages cannot replace it", async () => {
  const h = await fixture();
  const ready = h.bridge.readySession;
  await expect(
    h.game.call("game.status", {
      worldId: "w",
      playerId: "p",
      worldSessionId: h.world.sessionId,
      paused: true,
    }),
  ).rejects.toMatchObject({ code: -32602 });
  expect(h.bridge.readySession).toEqual(ready);
  await h.game.call("game.detach", h.world);
  const attach = { worldId: "w", playerId: "p", supportedEvents: [], paused: false };
  for (const language of [undefined, null, "", 123, "a".repeat(17), "ja_jp\n"])
    await expect(h.game.call("game.attach", { ...attach, language })).rejects.toMatchObject({
      code: -32602,
    });
  expect(h.bridge.currentSession).toBeUndefined();
  await h.game.call("game.attach", { ...attach, language: "en_us" });
  expect(h.bridge.currentSession).toMatchObject({ language: "en_us" });
});

const forwards = [
  ["get_game_state", "game.state.get", { query: {} }, { state: snapshot }],
  ["send_message", "game.message.send", { text: "hello" }, { displayed: true }],
  [
    "list_game_files",
    "game.files.list",
    { query: {} },
    { reference: { kind: "roots", roots: [], nextCursor: null } },
  ],
  [
    "read_game_file",
    "game.files.read",
    { query: { root: "minecraft:0", path: "data/a.json" } },
    { reference: { root: "minecraft:0", path: "data/a.json", content: "{}", bytes: 2 } },
  ],
  [
    "search_game_files",
    "game.files.search",
    { query: { root: "minecraft:0", path: "data", text: "a" } },
    {
      reference: {
        root: "minecraft:0",
        path: "data",
        text: "a",
        matches: [],
        scanned: 0,
        nextCursor: null,
        firstMatchPerFile: true,
      },
    },
  ],
] as const;

test.each(forwards)(
  "pause preserves admitted %s, exact native wire and fresh context",
  async (name, method, args, result) => {
    const h = await fixture();
    const binding = await h.bridge.beginRun();
    const invalidated = vi.fn();
    h.bridge.on("runInvalidated", invalidated);
    const pending = h.bridge.executeTool(binding, name, args);
    const call = await h.native();
    expect(call.method).toBe(method);
    expect(call.params).toEqual({ ...binding, ...args });
    await h.game.call("game.status", { ...h.world, paused: true });
    call.result.resolve({ ...binding, ...result });
    expect(await pending).toEqual({ ...binding, ...result });
    const next = h.bridge.getGameState(binding);
    (await h.native(1)).result.resolve({ ...binding, state: { ...snapshot, tick: 999 } });
    expect(await next).toEqual({ ...snapshot, tick: 999 });
    expect(h.bridge.summaryContext(binding)).toBe("");
    expect(invalidated).not.toHaveBeenCalled();
    expect(h.bridge.finishRun(binding)).toBe(true);
  },
);

test("startup pause updates facts but never grants readiness; admitted preparation may bind paused", async () => {
  const h = await fixture();
  await h.game.call("game.detach", h.world);
  const binding = (await h.game.call("game.attach", {
    worldId: "w",
    playerId: "p",
    language: "ja_jp",
    supportedEvents: [],
    paused: false,
  })) as SessionBinding;
  const attach = vi.fn();
  const status = vi.fn();
  h.bridge.on("attach", attach);
  h.bridge.on("status", status);
  await h.game.call("game.status", { ...binding, paused: true });
  expect(h.bridge.readySession).toBeUndefined();
  expect(attach).not.toHaveBeenCalled();
  expect(status).not.toHaveBeenCalled();
  await expect(h.bridge.beginRun()).rejects.toThrow();
  await h.game.call("game.ready", binding);
  expect(attach).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ paused: true }));
  const run = await h.bridge.beginRun(); // Scheduler, not bridge, owns admission pause gate.
  expect(h.binds).toEqual([run]);
});

test.each(forwards)(
  "owned native withdrawal cancels first for %s without fabricating pause",
  async (name, _method, args) => {
    const h = await fixture();
    const binding = await h.bridge.beginRun();
    const invalidated: unknown[] = [];
    h.bridge.on("runInvalidated", (run, reason) => invalidated.push({ run, reason }));
    const pending = h.bridge.executeTool(binding, name, args).catch((error: unknown) => error);
    (await h.native()).result.reject(new RpcError(-32001, "native stale"));
    expect(await pending).toMatchObject({ code: staleRunErrorCode, data: binding });
    expect(invalidated).toEqual([{ run: binding, reason: "native_run_withdrawn" }]);
    expect(h.bridge.readySession?.paused).toBe(false);
    expect(h.rows("hisyo.status_reported")).toEqual([]);
    await expect(h.bridge.beginRun()).rejects.toThrow("Previous run has not settled");
    await expect(
      h.bridge.executeTool(binding, "add_hook", { event: "block_broken", instruction: "stale" }),
    ).rejects.toMatchObject({ code: staleRunErrorCode });
  },
);

test("withdrawn slot remains until settlement, then binding waits for a subsequent valid resume", async () => {
  const h = await fixture();
  const binding = await h.bridge.beginRun();
  const pending = h.bridge.getGameState(binding).catch((error: unknown) => error);
  await h.native();
  await h.game.call("game.status", { ...h.world, paused: true });
  await h.game.call("game.status", { ...h.world, paused: false });
  h.requests[0]!.result.reject(new RpcError(-32001, "native stale"));
  expect(await pending).toMatchObject({ code: staleRunErrorCode });
  expect(h.bridge.finishRun({ ...binding, runId: "foreign" })).toBe(false);
  await expect(h.bridge.beginRun()).rejects.toThrow("Previous run has not settled");
  expect(h.bridge.finishRun(binding)).toBe(true);
  let admitted: RunBinding | undefined;
  const admission = h.bridge.beginRun().then((run) => {
    admitted = run;
    return run;
  });
  await drain();
  expect(admitted).toBeUndefined();
  expect(h.binds).toHaveLength(1);
  await expect(
    h.game.call("game.status", { ...h.world, paused: false, extra: true }),
  ).rejects.toThrow();
  await h.game.call("game.status", { ...h.world, paused: true });
  expect(admitted).toBeUndefined();
  await h.game.call("game.status", { ...h.world, paused: false });
  const next = await admission;
  expect(next.runId).not.toBe(binding.runId);
  expect(h.binds).toHaveLength(2);
});

test("late old capture cannot invalidate a new run or route a tool into it", async () => {
  const h = await fixture();
  const first = await h.bridge.beginRun();
  const pending = h.bridge.getGameState(first).catch((error: unknown) => error);
  await h.native();
  h.bridge.invalidateRun("cancelled");
  h.bridge.finishRun(first);
  const next = await h.bridge.beginRun();
  const invalidated = vi.fn();
  h.bridge.on("runInvalidated", invalidated);
  h.requests[0]!.result.reject(new RpcError(-32001, "old native stale"));
  expect(await pending).toMatchObject({ code: -32001 });
  expect(invalidated).not.toHaveBeenCalled();
  await expect(
    h.bridge.executeTool(first, "send_message", { text: "wrong world" }),
  ).rejects.toThrow();
  const fresh = h.bridge.getGameState(next);
  (await h.native(1)).result.resolve({ ...next, state: snapshot });
  expect(await fresh).toEqual(snapshot);
});

test.each([
  new RpcError(-32603, "data"),
  new RpcError(-32602, "params"),
  new RpcError(-32010, "auth"),
  new RpcError(-32004, "storage"),
  new RpcError(-32123, "arbitrary"),
  new RpcError(-32001, "foreign data", { runId: "foreign" }),
])("fatal native error remains fatal despite cancellation: %s", async (failure) => {
  const h = await fixture();
  const binding = await h.bridge.beginRun();
  const pending = h.bridge.getGameState(binding).catch((error: unknown) => error);
  const native = await h.native();
  h.bridge.invalidateRun("cancelled");
  native.result.reject(failure);
  expect(await pending).toMatchObject({
    code: failure.code,
    message: failure.message,
    data: failure.data,
  });
});

test.each(["invalidate", "abort", "detach"])(
  "displayed native ACK is recorded in original scope before %s fence",
  async (kind) => {
    const h = await fixture();
    const binding = await h.bridge.beginRun();
    const controller = new AbortController();
    const args = { text: "literal displayed text" };
    const pending = h.bridge
      .executeTool(binding, "send_message", args, controller.signal)
      .catch((error: unknown) => error);
    const call = await h.native();
    args.text = "mutated";
    if (kind === "invalidate") h.bridge.invalidateRun("cancelled");
    else if (kind === "abort") controller.abort();
    else {
      await h.game.call("game.detach", h.world);
      await h.attach("other", "player");
    }
    call.result.resolve({ ...binding, displayed: true });
    expect(await pending).toBeInstanceOf(Error);
    expect(h.rows("hisyo.hud_displayed")).toEqual([
      expect.objectContaining({
        ...h.world,
        data: { runId: binding.runId, text: "literal displayed text" },
      }),
    ]);
  },
);

test("displayed ACK storage failure is fatal and remains latched", async () => {
  const h = await fixture();
  const binding = await h.bridge.beginRun();
  const pending = h.bridge
    .executeTool(binding, "send_message", { text: "hello" })
    .catch((error: unknown) => error);
  const call = await h.native();
  h.failActivities("hisyo.hud_displayed");
  call.result.resolve({ ...binding, displayed: true });
  expect(await pending).toMatchObject({ message: "activity write failed" });
  expect(h.faults).toHaveLength(1);
  expect(h.bridge.readySession).toBeUndefined();
  expect(h.rows("hisyo.hud_displayed")).toEqual([]);
});

test.each(["version1", "missing-visibility", "foreign", "malformed"])(
  "unsafe %s state remains fatal even after cancellation",
  async (kind) => {
    const h = await fixture();
    const binding = await h.bridge.beginRun();
    const pending = h.bridge.getGameState(binding).catch((error: unknown) => error);
    const call = await h.native();
    h.bridge.invalidateRun("cancelled");
    const state =
      kind === "version1"
        ? { ...snapshot, version: 1 }
        : kind === "missing-visibility"
          ? { ...snapshot, nearby: { ...snapshot.nearby, visibility: undefined } }
          : kind === "malformed"
            ? {}
            : snapshot;
    call.result.resolve({
      ...binding,
      runId: kind === "foreign" ? "foreign" : binding.runId,
      state,
    });
    expect(await pending).toMatchObject({ code: -32603 });
  },
);

test.each(["bytes", "unicode", "control", "foreign"])(
  "reference %s result validation survives the direct API",
  async (kind) => {
    const h = await fixture();
    const binding = await h.bridge.beginRun();
    const pending = h.bridge
      .executeTool(binding, "read_game_file", {
        query: { root: "minecraft:0", path: "data/a.json" },
      })
      .catch((error: unknown) => error);
    const call = await h.native();
    const content = kind === "unicode" ? "\ud800" : kind === "control" ? "\u0001" : "{}";
    call.result.resolve({
      ...binding,
      runId: kind === "foreign" ? "foreign" : binding.runId,
      reference: {
        root: "minecraft:0",
        path: "data/a.json",
        content,
        bytes: kind === "bytes" ? 99 : Buffer.byteLength(content),
      },
    });
    expect(await pending).toMatchObject({ code: -32603 });
  },
);

test.each(["cancel", "detach", "closing", "storage"])(
  "unknown-availability binding wakes safely on %s without a status report",
  async (kind) => {
    const h = await fixture();
    const binding = await h.bridge.beginRun();
    const pending = h.bridge.getGameState(binding).catch((error: unknown) => error);
    (await h.native()).result.reject(new RpcError(-32001, "native stale"));
    expect(await pending).toMatchObject({ code: staleRunErrorCode });
    h.bridge.finishRun(binding);
    let completed = false;
    const waiting = h.bridge.beginRun().catch((error: unknown) => {
      completed = true;
      return error;
    });
    await drain();
    expect(completed).toBe(false);
    expect(h.binds).toHaveLength(1);
    if (kind === "cancel") h.bridge.invalidateRun("owner_closed");
    else if (kind === "detach") await h.game.call("game.detach", h.world);
    else if (kind === "closing") await h.bridge.close();
    else {
      h.failActivities();
      await expect(h.game.call("game.status", { ...h.world, paused: false })).rejects.toThrow();
    }
    expect(await waiting).toMatchObject({
      code: kind === "cancel" || kind === "detach" ? staleRunErrorCode : -32001,
    });
    expect(h.binds).toHaveLength(1);
  },
);

test("closing never promotes a native stale result to owned cancellation", async () => {
  const h = await fixture();
  const binding = await h.bridge.beginRun();
  const pending = h.bridge.getGameState(binding).catch((error: unknown) => error);
  await h.native();
  await h.bridge.close();
  expect(await pending).not.toMatchObject({ code: staleRunErrorCode });
});

test("malformed native bind ACK fails closed without acquiring a run", async () => {
  const h = await fixture();
  // A second real host connection supplies a deliberately malformed native acknowledgment.
  await h.game.call("game.detach", h.world);
  h.game.close();
  await drain();
  const replacement = await h.connect();
  replacement.handle("game.run.bind", (params) => ({
    ...(params as RunBinding),
    runId: "foreign",
  }));
  replacement.handle("game.run.clear", () => undefined);
  const world = (await replacement.call("game.attach", {
    worldId: "w",
    playerId: "p",
    language: "ja_jp",
    supportedEvents: [],
    paused: false,
  })) as SessionBinding;
  await replacement.call("game.ready", world);
  await expect(h.bridge.beginRun()).rejects.toThrow("Invalid run binding acknowledgment");
});

test.each(["raw", "hooks"])("bridge rejects invalid %s database ownership", async (invalid) => {
  const h = await fixture();
  expect(
    () =>
      new BridgeServer({
        token: "a".repeat(43),
        eventLog: h.eventLog,
        activityLog: invalid === "raw" ? new ActivityLog(h.rawDb) : h.activityLog,
        hooks: invalid === "hooks" ? new HookStore(h.rawDb, h.eventLog.catalog) : h.hooks,
        summaries: h.summaries,
      }),
  ).toThrow(invalid === "raw" ? /separate/ : /Activity.*hooks/);
});
