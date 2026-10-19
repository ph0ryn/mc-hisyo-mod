import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { EventEmitter, once } from "node:events";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { BridgeServer } from "../bridge/bridgeServer.js";
import { EventCatalog } from "../events/eventCatalog.js";
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import { initializeEventDatabase } from "../storage/eventDatabase.js";
import { initializeActivityDatabase } from "../storage/activityDatabase.js";
import { initializeSummaryDatabase } from "../storage/summaryDatabase.js";
import { EventLog } from "../storage/eventLog.js";
import { ActivityLog } from "../storage/activityLog.js";
import { HookStore } from "../storage/hookStore.js";
import { SummaryStore } from "../storage/summaryStore.js";
import { RpcPeer } from "../transport/rpcPeer.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vite-plus/test";
import { startDurableAgent, type DurableBridge } from "./durableAgent.js";
import { hisyoToolNames } from "../protocol/hisyoTools.js";
import { sameRunBinding, type RunBinding, type SessionBinding } from "../protocol/bridge.js";
import { TokenUsageRequestSchema, type TokenUsageData } from "../protocol/tokenUsage.js";
import { Check } from "typebox/value";
import snapshot from "../protocol/fixtures/gameState.json" with { type: "json" };

const session: SessionBinding = { worldId: "world", playerId: "player", sessionId: "session" };
const model: Model<"openai-responses"> = {
  provider: "openai",
  id: "gpt-6-luna",
  name: "fake pinned model",
  api: "openai-responses",
  baseUrl: "https://fake.invalid",
  reasoning: true,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function message(
  content: AssistantMessage["content"] = [{ type: "text", text: "done" }],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    provider: model.provider,
    model: model.id,
    api: model.api,
    content,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class GameHost extends EventEmitter {
  currentSession = { binding: session, language: "ja_jp", paused: false, supportedEvents: [] };
  readySession = this.currentSession;
  binding: RunBinding | undefined;
  states = 0;
  failContext = false;
  tools: string[] = [];
  usage: TokenUsageData[] = [];
  summary = "latest summary";
  pendingRequests = 0;
  async beginRun() {
    this.binding = { ...this.currentSession.binding, runId: `run-${Date.now()}-${Math.random()}` };
    return this.binding;
  }
  finishRun(binding: RunBinding) {
    if (!this.binding || !sameRunBinding(binding, this.binding)) return false;
    this.binding = undefined;
    return true;
  }
  invalidateRun(reason = "native_run_withdrawn") {
    const binding = this.binding;
    this.binding = undefined;
    if (binding) this.emit("runInvalidated", binding, reason);
  }
  assertRun(binding: RunBinding) {
    if (!this.binding || !sameRunBinding(binding, this.binding)) throw new Error("stale run");
  }
  async getGameState(binding: RunBinding) {
    this.assertRun(binding);
    if (this.failContext) throw new Error("context unavailable");
    return { ...snapshot, tick: ++this.states, dayTime: 0 };
  }
  summaryContext(binding: RunBinding) {
    this.assertRun(binding);
    return this.summary;
  }
  async executeTool(binding: RunBinding, name: string, _args: unknown, signal?: AbortSignal) {
    this.assertRun(binding);
    signal?.throwIfAborted();
    this.tools.push(name);
    return name === "send_message" ? { ...binding, displayed: true } : { ok: true };
  }
  beginModelRequest() {
    this.pendingRequests++;
  }
  recordUsage(params: TokenUsageData) {
    if (!Check(TokenUsageRequestSchema, params)) throw new Error("invalid exact usage payload");
    this.usage.push(params);
    return { recorded: true as const };
  }
  finishModelRequest() {
    this.pendingRequests--;
    return true;
  }
}
type ProviderCall = { context: TranscriptContext; options: SimpleStreamOptions | undefined };
function fakeProvider(
  reply: (call: ProviderCall, index: number) => Promise<AssistantMessage> | AssistantMessage = () =>
    message(),
) {
  const calls: ProviderCall[] = [];
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const stream = (
    _model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ) => {
    const result = createAssistantMessageEventStream();
    const index = calls.length;
    const call = { context: structuredClone(context), options };
    calls.push(call);
    void (async () => {
      const response = await reply(call, index);
      await options?.onProviderStreamEvent?.(
        {
          type: "response.completed",
          response: { usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } },
        },
        _model,
      );
      result.push(
        response.stopReason === "error" || response.stopReason === "aborted"
          ? { type: "error", reason: response.stopReason, error: response }
          : {
              type: "done",
              reason: response.stopReason as "stop" | "length" | "toolUse",
              message: response,
            },
      );
    })().catch((error: unknown) => {
      result.push({
        type: "error",
        reason: "error",
        error: { ...message(), stopReason: "error", errorMessage: String(error) },
      });
    });
    return result;
  };
  models.setProvider(
    createProvider({
      id: "openai",
      name: "fake",
      auth: {
        apiKey: {
          name: "fake key",
          resolve: async () => ({ auth: { type: "api_key", apiKey: "fake" } }),
        },
      },
      models: [model],
      api: { stream, streamSimple: stream },
    }),
  );
  return { calls, modelAccess: { model, models } };
}
async function setup(
  reply: (call: ProviderCall, index: number) => Promise<AssistantMessage> | AssistantMessage = () =>
    message(),
) {
  const directory = mkdtempSync(join(tmpdir(), "hisyo-durable-test-"));
  const bridge = new GameHost();
  const { calls, modelAccess } = fakeProvider(reply);
  const options = {
    dataDirectory: directory,
    bridge: bridge as unknown as DurableBridge,
    session,
    modelAccess,
  };
  let agent = await startDurableAgent(options);
  onTestFinished(async () => {
    await agent.close();
    const resolved = directory;
    if (!resolved.startsWith(join(tmpdir(), "hisyo-durable-test-")))
      throw new Error("unexpected test cleanup path");
    rmSync(resolved, { recursive: true });
  });
  return {
    bridge,
    calls,
    options,
    get agent() {
      return agent;
    },
    async reopen() {
      await agent.close();
      agent = await startDurableAgent(options);
      return agent;
    },
  };
}

test("provider failures preserve unknown raw counters and never persist provider error secrets", async () => {
  const fixture = await setup(() => {
    throw new Error("credential-secret-must-not-persist");
  });
  await expect(fixture.agent.run("request", undefined, "provider-error")).rejects.toThrow(
    /model request/i,
  );
  expect(fixture.bridge.usage[0]).toMatchObject({
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    total: null,
    stopReason: "error",
  });
  const view = await fixture.agent.conversation.context(BACKGROUND_CONTEXT);
  expect(JSON.stringify(view)).not.toContain("credential-secret-must-not-persist");
});

test("real Durable SQLite persists the conversation and deduplicates a repeated request across reopen", async () => {
  const fixture = await setup();
  await expect(fixture.agent.run("accepted chat", undefined, "chat-1")).resolves.toMatchObject({
    status: "settled",
  });
  expect(fixture.calls).toHaveLength(1);
  const path = fixture.agent.conversationPath;
  await fixture.reopen();
  expect(fixture.agent.conversationPath).toBe(path);
  expect(fixture.calls).toHaveLength(1); // Opening is read-only scheduling, even with a prior conversation.
  await fixture.agent.run("accepted chat", undefined, "chat-1");
  expect(fixture.calls).toHaveLength(1);
  await fixture.agent.run("second chat", undefined, "chat-2");
  expect(JSON.stringify(fixture.calls[1]!.context)).toContain("accepted chat");
  expect(fixture.bridge.usage[0]).toMatchObject({
    input: 7,
    output: 2,
    cacheRead: null,
    cacheWrite: null,
    total: 9,
  });
});

test("offers exactly ten game tools and refreshes transient state and summary after tools", async () => {
  const fixture = await setup((_call, index) =>
    index === 0
      ? message(
          [
            {
              type: "toolCall",
              id: "display-1",
              name: "send_message",
              arguments: { text: "hello" },
            },
          ],
          "toolUse",
        )
      : message(),
  );
  await fixture.agent.run("chat", undefined, "tools-1");
  expect(fixture.calls).toHaveLength(2);
  expect(
    getCurrentTools(fixture.calls[0]!.context.messages)
      .map((tool) => tool.name)
      .toSorted(),
  ).toEqual(hisyoToolNames.toSorted());
  expect(fixture.calls[0]!.options?.reasoning).toBe("medium");
  expect(fixture.bridge.tools).toEqual(["send_message"]);
  expect(fixture.bridge.states).toBe(2);
  expect(JSON.stringify(fixture.calls[0]!.context)).toContain('\\"tick\\":1');
  expect(JSON.stringify(fixture.calls[1]!.context)).toContain('\\"tick\\":2');
  const durableContext = await fixture.agent.conversation.context(BACKGROUND_CONTEXT);
  expect(
    JSON.stringify(durableContext.messages.filter((message) => message.role === "user")),
  ).not.toContain("CURRENT_GAME_STATE");
  expect(JSON.stringify(durableContext.messages)).not.toContain("latest summary");
  expect(fixture.bridge.usage).toHaveLength(2);
});

test("context failure is fail-closed at provider dispatch, including the post-tool request", async () => {
  const fixture = await setup(() => {
    fixture.bridge.failContext = true;
    return message(
      [{ type: "toolCall", id: "read-1", name: "list_hooks", arguments: {} }],
      "toolUse",
    );
  });
  await expect(fixture.agent.run("chat", undefined, "blocked")).rejects.toThrow(/context|request/i);
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.bridge.tools).toEqual(["list_hooks"]);
  expect(fixture.bridge.pendingRequests).toBe(0);
});

test("scheduler domain documents commit while paused and survive close/reopen without a provider call", async () => {
  const fixture = await setup();
  const Inbox = defineDoc({
    kind: "app.testInbox",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ messages: [] as string[] }),
  });
  await fixture.agent.conversation.commit(async (tx) => {
    (await tx.doc(Inbox, fixture.agent.conversation.id)).messages.push("admitted while paused");
  }, BACKGROUND_CONTEXT);
  await fixture.reopen();
  const pending = await fixture.agent.conversation.commit(
    async (tx) => [...(await tx.doc(Inbox, fixture.agent.conversation.id)).messages],
    BACKGROUND_CONTEXT,
  );
  expect(pending).toEqual(["admitted while paused"]);
  expect(fixture.calls).toHaveLength(0);
});

test("host close preserves pending generation; reopen does not request until a new native binding", async () => {
  const entered = deferred<void>();
  const fixture = await setup(async (call, index) => {
    if (index > 0) return message();
    entered.resolve();
    await new Promise<void>((resolve) => {
      call.options!.signal!.addEventListener("abort", () => resolve(), { once: true });
    });
    return { ...message(), stopReason: "aborted" };
  });
  const run = fixture.agent.run("durable pending", undefined, "pending-1");
  const observed = run.catch(() => undefined);
  await entered.promise;
  await fixture.reopen();
  await observed;
  expect(fixture.calls).toHaveLength(1);
  await fixture.agent.run("durable pending", undefined, "pending-1");
  expect(fixture.calls).toHaveLength(2);
  expect(fixture.bridge.states).toBe(2);
});

test("interrupted native side effects settle before close and are not replayed after reopen", async () => {
  const toolEntered = deferred<void>();
  const releaseNative = deferred<void>();
  const fixture = await setup((_call, index) =>
    index === 0
      ? message(
          [
            {
              type: "toolCall",
              id: "native-side-effect",
              name: "send_message",
              arguments: { text: "exactly one dispatch" },
            },
          ],
          "toolUse",
        )
      : message(),
  );
  let dispatches = 0;
  fixture.bridge.executeTool = async (binding) => {
    fixture.bridge.assertRun(binding);
    dispatches++;
    toolEntered.resolve();
    // A native side effect may ignore cancellation; retain ownership until its acknowledgement settles.
    await releaseNative.promise;
    return { ...binding, displayed: true };
  };
  const pending = fixture.agent.run("effect", undefined, "effect-1").catch(() => undefined);
  await toolEntered.promise;
  let closed = false;
  const closing = fixture.agent.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  await expect(startDurableAgent(fixture.options)).rejects.toThrow(/owned|owner/);
  releaseNative.resolve();
  await closing;
  await pending;
  await fixture.reopen();
  await fixture.agent.run("effect", undefined, "effect-1");
  expect(dispatches).toBe(1);
  const view = await fixture.agent.conversation.context(BACKGROUND_CONTEXT);
  expect(JSON.stringify(view.messages)).toContain("interrupted");
});

test("invalidated native binding cannot execute late provider tool calls", async () => {
  const entered = deferred<void>();
  const fixture = await setup(async (call) => {
    entered.resolve();
    await new Promise<void>((resolve) => {
      call.options!.signal!.addEventListener("abort", () => resolve(), { once: true });
    });
    return message(
      [
        {
          type: "toolCall",
          id: "late-effect",
          name: "send_message",
          arguments: { text: "must not display" },
        },
      ],
      "toolUse",
    );
  });
  const run = fixture.agent.run("late", undefined, "late-1");
  const observed = run.catch(() => undefined);
  await entered.promise;
  fixture.bridge.invalidateRun();
  await observed;
  expect(fixture.bridge.tools).toEqual([]);
  expect(fixture.bridge.usage).toHaveLength(1);
});

test.each(["storage_failed", "binding_failed"])(
  "host failure %s preserves accepted generation for reopen rather than terminal abort",
  async (reason) => {
    const entered = deferred<void>();
    const fixture = await setup(async (call, index) => {
      if (index > 0) return message();
      entered.resolve();
      await new Promise<void>((resolve) => {
        call.options!.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      return { ...message(), stopReason: "aborted" };
    });
    const run = fixture.agent
      .run("accepted work", undefined, `host-failure-${reason}`)
      .catch(() => undefined);
    await entered.promise;
    fixture.bridge.invalidateRun(reason);
    await fixture.agent.close();
    await run;
    await fixture.reopen();
    await fixture.agent.run("accepted work", undefined, `host-failure-${reason}`);
    expect(fixture.calls).toHaveLength(2);
  },
);

test("pause during native bind preparation does not revoke an already admitted run", async () => {
  const fixture = await setup();
  const entered = deferred<void>();
  const release = deferred<void>();
  const beginRun = fixture.bridge.beginRun.bind(fixture.bridge);
  fixture.bridge.beginRun = async () => {
    entered.resolve();
    await release.promise;
    return beginRun();
  };
  const run = fixture.agent.run("already admitted", undefined, "pause-after-admission");
  await entered.promise;
  fixture.bridge.currentSession.paused = true;
  release.resolve();
  await expect(run).resolves.toMatchObject({ status: "settled", aborted: false });
  expect(fixture.calls).toHaveLength(1);
});

test("real bridge retains cancelled provider usage ownership until close has joined the call", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hisyo-durable-test-"));
  const raw = new DatabaseSync(":memory:");
  const activity = new DatabaseSync(":memory:");
  const summary = new DatabaseSync(":memory:");
  initializeEventDatabase(raw);
  initializeActivityDatabase(activity);
  initializeSummaryDatabase(summary);
  const catalog = new EventCatalog(gameEventDefinitions);
  const eventLog = new EventLog(raw, catalog);
  const activityLog = new ActivityLog(activity);
  const bridge = new BridgeServer({
    token: "a".repeat(43),
    eventLog,
    activityLog,
    hooks: new HookStore(activity, catalog),
    summaries: new SummaryStore(eventLog, summary),
  });
  const address = await bridge.listen();
  const socket = createConnection(address);
  await once(socket, "connect");
  const game = new RpcPeer(socket);
  game.handle("game.run.bind", (params) => params);
  game.handle("game.run.clear", () => undefined);
  game.handle("game.state.get", (params) => {
    const { worldId, playerId, sessionId, runId } = params as unknown as RunBinding;
    return { worldId, playerId, sessionId, runId, state: snapshot };
  });
  await game.call("bridge.hello", { protocolVersion: 2, role: "game", token: "a".repeat(43) });
  const binding = (await game.call("game.attach", {
    worldId: "world",
    playerId: "player",
    language: "ja_jp",
    supportedEvents: [],
    paused: false,
  })) as SessionBinding;
  await game.call("game.ready", binding);
  const entered = deferred<void>();
  const providerAborted = deferred<void>();
  const release = deferred<void>();
  const { modelAccess } = fakeProvider(async (call) => {
    entered.resolve();
    await new Promise<void>((resolve) => {
      call.options!.signal!.addEventListener(
        "abort",
        () => {
          providerAborted.resolve();
          resolve();
        },
        { once: true },
      );
    });
    await release.promise; // Raw final usage may arrive after the cancellation signal.
    return { ...message(), stopReason: "aborted" };
  });
  const agent = await startDurableAgent({
    dataDirectory: directory,
    bridge,
    session: binding,
    modelAccess,
  });
  onTestFinished(async () => {
    release.resolve();
    await agent.close();
    await bridge.close();
    game.close();
    raw.close();
    activity.close();
    summary.close();
    if (!directory.startsWith(join(tmpdir(), "hisyo-durable-test-")))
      throw new Error("unexpected cleanup path");
    rmSync(directory, { recursive: true });
  });
  const run = agent.run("cancelled call", undefined, "native-metering").catch(() => undefined);
  await entered.promise;
  const closing = agent.close();
  await providerAborted.promise;
  // Let the rejected submission waiter release its finally block before the provider settles.
  await new Promise<void>((resolve) => setImmediate(resolve));
  release.resolve();
  await closing;
  await run;
  const rows = activityLog.search(
    { worldId: binding.worldId, playerId: binding.playerId },
    { event: "hisyo.token_usage" },
  ).events;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.activity.data).toMatchObject({
    source: "run",
    input: 7,
    output: 2,
    cacheRead: null,
    stopReason: "aborted",
  });
});

test("explicit abort settles pending work rather than replaying it on reopen", async () => {
  const entered = deferred<void>();
  const fixture = await setup(async (call) => {
    entered.resolve();
    await new Promise<void>((resolve) => {
      call.options!.signal!.addEventListener("abort", () => resolve(), { once: true });
    });
    return { ...message(), stopReason: "aborted" };
  });
  const run = fixture.agent.run("cancel", undefined, "cancel-1");
  const observed = run.catch(() => undefined);
  await entered.promise;
  await fixture.agent.abort();
  await observed;
  await fixture.reopen();
  await fixture.agent.run("cancel", undefined, "cancel-1");
  expect(fixture.calls).toHaveLength(1);
});
