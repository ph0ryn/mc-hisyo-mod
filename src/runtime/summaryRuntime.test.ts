import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type AssistantMessage,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { EventEmitter, once } from "node:events";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { BridgeServer } from "../bridge/bridgeServer.js";
import { parseOptions } from "../cliOptions.js";
import { EventCatalog } from "../events/eventCatalog.js";
import type { SessionBinding } from "../protocol/bridge.js";
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import observations from "../protocol/fixtures/gameEvents.json" with { type: "json" };
import { ActivityLog } from "../storage/activityLog.js";
import { initializeActivityDatabase } from "../storage/activityDatabase.js";
import { EventLog } from "../storage/eventLog.js";
import { initializeEventDatabase } from "../storage/eventDatabase.js";
import { HookStore } from "../storage/hookStore.js";
import { initializeSummaryDatabase } from "../storage/summaryDatabase.js";
import { SummaryStore } from "../storage/summaryStore.js";
import { RpcPeer } from "../transport/rpcPeer.js";
import { startHisyoRuntime, type HisyoRuntimePorts } from "./hisyoRuntime.js";
import { RunScheduler, type RunAgent } from "./runScheduler.js";
import { SummaryScheduler } from "./summaryScheduler.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const scope = ({ worldId, playerId }: SessionBinding) => ({ worldId, playerId });

async function fixture(
  reply: (options: SimpleStreamOptions | undefined) => AssistantMessage | Promise<AssistantMessage>,
) {
  const raw = new DatabaseSync(":memory:");
  const activity = new DatabaseSync(":memory:");
  const summary = new DatabaseSync(":memory:");
  initializeEventDatabase(raw);
  initializeActivityDatabase(activity);
  initializeSummaryDatabase(summary);
  const catalog = new EventCatalog(gameEventDefinitions);
  const eventLog = new EventLog(raw, catalog);
  const activityLog = new ActivityLog(activity);
  const summaries = new SummaryStore(eventLog, summary);
  const token = "a".repeat(43);
  const bridge = new BridgeServer({
    token,
    eventLog,
    activityLog,
    hooks: new HookStore(activity, catalog),
    summaries,
  });
  const provider = fauxProvider({
    api: "openai-responses",
    provider: "openai",
    models: [{ id: "gpt-6-luna" }],
  });
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider(provider.provider);
  const calls: string[] = [];
  const respond = async (context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
    const input = context.messages.at(-1)!.content;
    if (typeof input !== "string") throw new Error("Expected text-only summary input");
    calls.push(input);
    const response = await reply(options);
    await options?.onProviderStreamEvent?.(
      {
        type: "response.completed",
        response: { usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } },
      },
      provider.getModel(),
    );
    return response;
  };
  provider.setResponses(Array.from({ length: 12 }, () => respond));
  const order: string[] = [];
  const modelAccess = {
    models,
    model: provider.getModel(),
    close: vi.fn(async () => {
      order.push("modelAccess");
    }),
  };
  const startup = deferred();
  const enteredStartup = deferred();
  const harnesses: Harness[] = [];
  const scopes: SessionBinding[] = [];
  const usage = () =>
    scopes.flatMap(
      (binding) => activityLog.search(scope(binding), { event: "hisyo.token_usage" }).events,
    );
  const snapshot = { usage: [] as ReturnType<typeof usage>, summaries: 0 };
  const startAgent = vi.fn(async (): Promise<RunAgent> => {
    enteredStartup.resolve();
    await startup.promise;
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    harnesses.push(harness);
    return Object.assign(new EventEmitter<{ fault: [error: Error] }>(), {
      conversation: await harness.root(BACKGROUND_CONTEXT),
      run: vi.fn(async () => ({ status: "not_started" as const })),
      abort: async () => {},
      close: () => harness.close(BACKGROUND_CONTEXT),
    });
  });
  let now = 0;
  let sample!: () => void;
  const ports: HisyoRuntimePorts = {
    readEnv: () => undefined,
    createModelAccess: vi.fn(async () => modelAccess),
    startBridge: async () => ({
      bridge,
      connection: { ...(await bridge.listen()), protocolVersion: 2, token, pid: 1 },
      close: async () => {
        snapshot.usage = usage();
        snapshot.summaries = Number(
          summary.prepare("SELECT COUNT(*) AS count FROM summaries").get()!.count,
        );
        order.push("base");
        await bridge.close();
        raw.close();
        activity.close();
        summary.close();
      },
    }),
    createScheduler: (options) => new RunScheduler({ ...options, startAgent }),
    createSummaryScheduler: (options) => new SummaryScheduler({ ...options, wallNow: () => now }),
    everySecond: (callback) => {
      sample = callback;
      return () => {};
    },
  };
  const onFault = vi.fn();
  const runtime = (await startHisyoRuntime(
    {
      options: parseOptions([]),
      homeDirectory: "/unused",
      signal: new AbortController().signal,
      onFault,
    },
    ports,
  ))!;
  const socket = createConnection(runtime.connection);
  await once(socket, "connect");
  const game = new RpcPeer(socket);
  await game.call("bridge.hello", { protocolVersion: 2, role: "game", token });
  const sequences = new Map<string, number>();
  const append = (binding: SessionBinding, observedAt: number, blockId = "minecraft:stone") => {
    const seq = (sequences.get(binding.sessionId) ?? 0) + 1;
    sequences.set(binding.sessionId, seq);
    eventLog.append({
      ...observations.find((observation) => observation.event === "block_broken")!,
      ...binding,
      seq,
      observedAt,
      position: [0, 64, 0],
      data: { blockId, position: [0, 64, 0] },
    });
  };
  const attach = async (worldId: string, playerId: string) => {
    const binding = (await game.call("game.attach", {
      worldId,
      playerId,
      language: "ja_jp",
      supportedEvents: ["block_broken"],
      paused: true,
    })) as SessionBinding;
    scopes.push(binding);
    await game.call("game.ready", binding);
    append(binding, 1_000);
    return binding;
  };
  const pending: ReturnType<typeof deferred>[] = [];
  onTestFinished(async () => {
    for (const gate of pending) gate.resolve();
    const closing = runtime.close();
    startup.resolve();
    await closing;
    game.close();
    for (const harness of harnesses) await harness.close(BACKGROUND_CONTEXT);
  });
  const binding = await attach("world", "player");
  await enteredStartup.promise;
  return {
    runtime,
    bridge,
    game,
    binding,
    attach,
    append,
    calls,
    summaries,
    provider,
    modelAccess,
    ports,
    startAgent,
    onFault,
    order,
    snapshot,
    usage,
    startup,
    hold: () => {
      const gate = deferred();
      pending.push(gate);
      return gate;
    },
    at: (time: number) => {
      now = time;
      sample();
    },
  };
}

test("paused summary saves while Durable startup is unresolved", async () => {
  const f = await fixture(() => fauxAssistantMessage("石を採掘した。"));
  expect(f.startAgent).toHaveBeenCalledOnce();
  f.at(60_000);
  await tick();
  expect(f.provider.state.callCount).toBe(1);
  expect(f.summaries.next(scope(f.binding), 60_000)).toBeUndefined();
  expect(f.summaries.context(scope(f.binding))).toContain("石を採掘した。");
  expect(f.usage()[0]!.activity.data).toMatchObject({ source: "summary", input: 7 });
  expect(f.ports.createModelAccess).toHaveBeenCalledOnce();
  expect(f.onFault).not.toHaveBeenCalled();
});

test("replacement discards old output but retains its late usage until provider settlement", async () => {
  const entered = deferred();
  let release!: ReturnType<typeof deferred>;
  let oldSignal!: AbortSignal;
  let requests = 0;
  const f = await fixture(async (options) => {
    if (++requests === 1) {
      oldSignal = options!.signal!;
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage("old output");
    }
    return fauxAssistantMessage("new output");
  });
  release = f.hold();
  f.at(60_000);
  await entered.promise;
  await f.game.call("game.detach", f.binding);
  const next = await f.attach("other-world", "other-player");
  expect(oldSignal.aborted).toBe(true);
  f.at(120_000);
  expect(f.provider.state.callCount).toBe(1);
  expect(f.usage()).toEqual([]);
  release.resolve();
  await tick();
  expect(f.summaries.context(scope(f.binding))).toBe("");
  const oldUsage = f.usage().filter(({ activity }) => activity.sessionId === f.binding.sessionId);
  expect(oldUsage).toHaveLength(1);
  expect(oldUsage[0]!.activity).toMatchObject({
    ...f.binding,
    data: { source: "summary", input: 7 },
  });
  // Replacement starts as soon as the retained old flight settles, without another timer tick.
  expect(f.provider.state.callCount).toBe(2);
  expect(f.summaries.next(scope(next), 120_000)).toBeUndefined();
  expect(f.summaries.context(scope(next))).toContain("new output");
  expect(f.summaries.context(scope(f.binding))).toBe("");
  expect(f.onFault).not.toHaveBeenCalled();
});

test("latest minute, idle reverse-minute backfill, then new latest priority use one API flight", async () => {
  const backfillEntered = deferred();
  let release!: ReturnType<typeof deferred>;
  let backfillSignal!: AbortSignal;
  let active = 0;
  let peak = 0;
  let requests = 0;
  const f = await fixture(async (options) => {
    active++;
    peak = Math.max(peak, active);
    try {
      if (++requests === 2) {
        backfillSignal = options!.signal!;
        backfillEntered.resolve();
        await release.promise;
      }
      return fauxAssistantMessage("saved minute");
    } finally {
      active--;
    }
  });
  release = f.hold();
  f.append(f.binding, 61_000, "minecraft:dirt");
  f.append(f.binding, 121_000, "minecraft:diamond_ore");
  f.at(180_000);
  await backfillEntered.promise;
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]).toContain("blockId=diamond_ore");
  expect(f.calls[1]).toContain("blockId=dirt");

  f.append(f.binding, 181_000, "minecraft:gold_ore");
  f.at(240_000);
  expect(backfillSignal.aborted).toBe(false);
  expect(f.calls).toHaveLength(2);
  release.resolve();
  await tick();
  expect(f.calls).toHaveLength(4);
  expect(f.calls[2]).toContain("blockId=gold_ore");
  expect(f.calls[3]).toContain("blockId=stone");
  expect(peak).toBe(1);
  expect(f.summaries.next(scope(f.binding), 240_000)).toBeUndefined();

  f.at(300_000); // No eligible work: do not call the API or self-pump.
  await tick();
  expect(f.calls).toHaveLength(4);
  f.append(f.binding, 300_001, "minecraft:iron_ore");
  f.at(359_999);
  await tick();
  expect(f.calls).toHaveLength(4);
  f.at(360_000);
  await tick();
  expect(f.calls).toHaveLength(5);
  expect(f.calls[4]).toContain("blockId=iron_ore");
  expect(f.usage()).toHaveLength(5);
  expect(f.onFault).not.toHaveBeenCalled();
});

test("runtime close drains late summary usage before closing shared models and databases", async () => {
  const entered = deferred();
  let release!: ReturnType<typeof deferred>;
  let providerSignal!: AbortSignal;
  const f = await fixture(async (options) => {
    providerSignal = options!.signal!;
    entered.resolve();
    await release.promise;
    return fauxAssistantMessage("discarded", { stopReason: "aborted" });
  });
  release = f.hold();
  f.at(60_000);
  await entered.promise;
  let closed = false;
  const closing = f.runtime.close();
  void closing.then(() => {
    closed = true;
  });
  expect(f.runtime.close()).toBe(closing);
  f.startup.resolve();
  await tick();
  expect(providerSignal.aborted).toBe(true);
  expect(closed).toBe(false);
  expect(f.modelAccess.close).not.toHaveBeenCalled();
  expect(f.order).toEqual([]);
  release.resolve();
  await closing;
  expect(f.snapshot.usage).toHaveLength(1);
  expect(f.snapshot.usage[0]!.activity).toMatchObject({
    ...f.binding,
    data: { source: "summary", input: 7, stopReason: "aborted" },
  });
  expect(f.snapshot.summaries).toBe(0);
  expect(f.order).toEqual(["modelAccess", "base"]);
  expect(f.onFault).not.toHaveBeenCalled();
});
