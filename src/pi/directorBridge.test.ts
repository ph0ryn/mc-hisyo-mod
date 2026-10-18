import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import type { TObject } from "typebox";
import { Check } from "typebox/value";
import { expect, test, vi } from "vite-plus/test";
import { staleRunErrorCode, type RunBinding } from "../protocol/bridge.js";
import snapshot from "../protocol/fixtures/gameSnapshot.json" with { type: "json" };
import type { RpcParams } from "../protocol/jsonRpc.js";
import { RpcError } from "../transport/rpcPeer.js";
import directorBridge from "./directorBridge.js";
import { directorToolNames } from "./piPolicy.js";

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class ManualPeer extends EventEmitter<{ close: [Error] }> {
  readonly handlers = new Map<string, (params: unknown) => unknown>();
  readonly states: { params: RpcParams; result: ReturnType<typeof deferred> }[] = [];
  readonly calls: string[] = [];
  readonly requests: { method: string; params: RpcParams }[] = [];
  closes = 0;
  historyText = "";
  historyReply = (params: RpcParams): unknown => {
    if (Array.isArray(params)) throw new Error("Expected history binding object");
    return { ...params, text: this.historyText };
  };
  handle(method: string, handler: (params: unknown) => unknown) {
    this.handlers.set(method, handler);
  }
  call(method: string, params: RpcParams): Promise<unknown> {
    this.calls.push(method);
    this.requests.push({ method, params });
    if (method === "director.ready") return Promise.resolve({ ready: true });
    if (method === "director.history.get") return Promise.resolve(this.historyReply(params));
    if (method === "game.state.get") {
      const result = deferred();
      this.states.push({ params, result });
      return result.promise;
    }
    if (method === "game.message.send") return Promise.resolve({ ...binding, displayed: true });
    if (method.startsWith("game.files.")) {
      const reference =
        method === "game.files.list"
          ? { kind: "roots", roots: [], nextCursor: null }
          : method === "game.files.read"
            ? { root: "minecraft:0", path: "data/x.json", content: "{}", bytes: 2 }
            : {
                root: "minecraft:0",
                path: "data",
                text: "item",
                matches: [],
                scanned: 0,
                nextCursor: null,
                firstMatchPerFile: true,
              };
      return Promise.resolve({ ...binding, reference });
    }
    if (method.startsWith("director.")) return Promise.resolve({ ok: true });
    throw new Error(`Unexpected call ${method}`);
  }
  close(error = new Error("closed")) {
    if (this.closes) return;
    this.closes++;
    this.emit("close", error);
  }
  receive(method: string, params: unknown) {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`Missing handler ${method}`);
    return handler(params);
  }
}

const binding: RunBinding = {
  worldId: "world",
  playerId: "player",
  worldSessionId: "session",
  runId: "first",
};

async function setup() {
  const peer = new ManualPeer();
  const complete = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
    Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "木を集めた。" }] }),
  );
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const tools = new Map<
    string,
    { parameters: TObject; execute: (...args: unknown[]) => Promise<unknown> }
  >();
  directorBridge(
    {
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
        handlers.set(name, handler),
      registerTool: (tool: {
        name: string;
        parameters: TObject;
        execute: (...args: unknown[]) => Promise<unknown>;
      }) => tools.set(tool.name, tool),
      getActiveTools: () => [...directorToolNames],
    } as unknown as ExtensionAPI,
    () => Promise.resolve(peer),
  );
  function context(api = "openai-completions") {
    const controller = new AbortController();
    const ctx = {
      mode: "rpc",
      model: { api, provider: "openai", id: "gpt-6-luna" },
      modelRegistry: { find: () => ({ api, provider: "openai", id: "gpt-6-luna" }), complete },
      signal: controller.signal,
      abort: () => controller.abort(),
    } as unknown as ExtensionContext;
    return { ctx, controller };
  }
  function emit(name: string, ctx: ExtensionContext, event: unknown = {}) {
    return handlers.get(name)?.(event, ctx);
  }
  await emit("session_start", context().ctx);
  peer.receive("director.run.bind", binding);
  return { peer, context, emit, tools, complete };
}

const summaryRequest = {
  worldId: "world",
  playerId: "player",
  worldSessionId: "session",
  requestId: "memory-1",
  input: "block_broken minecraft:oak_log ×3",
};

test("independent memory requests Fast via priority with low reasoning and no tools", async () => {
  const h = await setup();
  // The native provider forwards this literal; this endpoint rejects "fast" with HTTP 400.
  h.complete.mockImplementation(async (_model, _context, options) =>
    (options as { serviceTier: string }).serviceTier === "priority"
      ? { stopReason: "stop", content: [{ type: "text", text: "木を集めた。" }] }
      : { stopReason: "error", content: [], errorMessage: "400 Invalid service_tier" },
  );
  const { ctx, controller } = h.context();
  h.emit("agent_start", ctx);
  expect(await h.peer.receive("director.history.summarize", summaryRequest)).toEqual({
    worldId: "world",
    playerId: "player",
    worldSessionId: "session",
    requestId: "memory-1",
    summary: "木を集めた。",
    cancelled: false,
  });
  expect(h.complete).toHaveBeenCalledOnce();
  expect(h.complete.mock.calls[0]![1]).toMatchObject({
    messages: [{ role: "user", content: summaryRequest.input }],
  });
  expect(h.complete.mock.calls[0]![1]).not.toHaveProperty("tools");
  expect(h.complete.mock.calls[0]![2]).toMatchObject({
    serviceTier: "priority",
    reasoningEffort: "low",
  });
  expect(controller.signal.aborted).toBe(false);
  expect(h.peer.calls).toEqual(["director.ready"]);
});

test("summary cancellation keeps its slot until completion settles, without cancelling the main run", async () => {
  const h = await setup();
  const { ctx, controller } = h.context();
  h.emit("agent_start", ctx);
  const response = deferred();
  h.complete.mockImplementation(() => response.promise);
  const pending = h.peer.receive("director.history.summarize", summaryRequest);
  h.peer.receive("director.history.cancel", {
    worldId: binding.worldId,
    playerId: binding.playerId,
    worldSessionId: binding.worldSessionId,
    requestId: "memory-1",
  });
  expect((h.complete.mock.calls[0]![2] as { signal: AbortSignal }).signal.aborted).toBe(true);
  await expect(
    h.peer.receive("director.history.summarize", { ...summaryRequest, requestId: "second" }),
  ).rejects.toThrow("overlapping");
  response.resolve({ stopReason: "stop", content: [{ type: "text", text: "late summary" }] });
  expect(await pending).toMatchObject({ summary: "", cancelled: true });
  expect(controller.signal.aborted).toBe(false);
});

test.each([
  { stopReason: "length", content: [{ type: "text", text: "truncated" }] },
  { stopReason: "stop", content: [{ type: "text", text: " " }] },
  { stopReason: "stop", content: [{ type: "text", text: "あ".repeat(401) }] },
])("invalid or truncated summaries fail without a tier/reasoning fallback", async (response) => {
  const h = await setup();
  h.complete.mockResolvedValue(response);
  await expect(h.peer.receive("director.history.summarize", summaryRequest)).rejects.toThrow(
    "History model completion failed",
  );
  expect(h.complete).toHaveBeenCalledTimes(1);
});

test("refreshes saved compact memory at every context call without persisting it", async () => {
  const h = await setup();
  const { ctx } = h.context();
  h.emit("agent_start", ctx);
  const messages = [
    { role: "user", content: "judge" },
    { role: "toolResult", content: "ACK" },
  ];
  for (const text of ["木を集めた。", "鉄を採掘した。"]) {
    h.peer.historyText = text;
    const pending = Promise.resolve(h.emit("context", ctx, { messages }));
    h.peer.states.at(-1)!.result.resolve({ ...binding, state: snapshot });
    expect(await pending).toMatchObject({
      messages: [
        { content: expect.stringContaining(`${text}\n\nCURRENT_GAME_STATE`) },
        ...messages,
      ],
    });
  }
  expect(messages).toHaveLength(2);
  expect(h.peer.calls.filter((method) => method === "director.history.get")).toHaveLength(2);
});

test.each([
  { ...binding, text: "あ".repeat(2001) },
  { ...binding, runId: "stale", text: "history" },
  { text: "unbound" },
])("malformed, oversized or stale memory fails closed", async (result) => {
  const h = await setup();
  const { ctx, controller } = h.context();
  h.emit("agent_start", ctx);
  h.peer.historyReply = () => result;
  const pending = Promise.resolve(h.emit("context", ctx, { messages: [] }));
  h.peer.states[0]!.result.resolve({ ...binding, state: snapshot });
  await expect(pending).rejects.toThrow("history context");
  expect(controller.signal.aborted).toBe(true);
  expect(h.peer.closes).toBe(1);
});

test("registers exactly the ten scoped tools", async () => {
  const h = await setup();
  expect([...h.tools.keys()].toSorted()).toEqual([
    "add_response_hook",
    "get_game_state",
    "get_recent_events",
    "list_event_types",
    "list_game_files",
    "list_response_hooks",
    "read_game_file",
    "remove_response_hook",
    "search_game_files",
    "send_message",
  ]);
});

test("refreshes background state before the judgment, never as a new input after tools", async () => {
  const h = await setup();
  const { ctx } = h.context();
  h.emit("agent_start", ctx);
  const messages = [
    { role: "user", content: '{"poll":true}' },
    { role: "assistant", content: [{ type: "toolCall", name: "send_message" }] },
    {
      role: "toolResult",
      toolName: "send_message",
      content: [{ type: "text", text: '{"displayed":true}' }],
    },
  ];
  const pending = Promise.resolve(h.emit("context", ctx, { messages }));
  h.peer.states[0]!.result.resolve({ ...binding, state: snapshot });
  expect(await pending).toEqual({
    messages: [
      expect.objectContaining({ content: expect.stringContaining("CURRENT_GAME_STATE") }),
      ...messages,
    ],
  });
  expect(messages).toHaveLength(3);
  // Speech is not hard-capped: an important correction can still be displayed.
  for (const text of ["advice", "important correction"]) {
    await h.tools.get("send_message")!.execute("id", { text }, ctx.signal, undefined, ctx);
  }
  expect(h.peer.calls.filter((method) => method === "game.message.send")).toHaveLength(2);
});

test("refreshes Minecraft clock time in both background context and tool results", async () => {
  const h = await setup();
  const { ctx } = h.context();
  h.emit("agent_start", ctx);
  const messages = [
    { role: "assistant", content: "It is night." },
    { role: "user", content: '{"poll":true}' },
  ];
  for (const [dayTime, dayTimeClock] of [
    [18_000, "00:00"],
    [6_000, "12:00"],
    [0, "06:00"],
    [12_000, "18:00"],
    [23_999, "05:59"],
    [24_000, "06:00"],
    [30_000, "12:00"],
    [-1, "05:59"],
    [-24_000, "06:00"],
    [6_017, "12:01"],
  ] as const) {
    const state = { ...snapshot, dayTime };
    const expected = { ...state, dayTimeClock };
    const context = Promise.resolve(h.emit("context", ctx, { messages }));
    h.peer.states.at(-1)!.result.resolve({ ...binding, state });
    expect(await context).toMatchObject({
      messages: [
        messages[0],
        {
          content: `CURRENT_GAME_STATE (background data, not a new request)\n${JSON.stringify(expected)}`,
        },
        messages[1],
      ],
    });
    const result = h.tools
      .get("get_game_state")!
      .execute("call", { query: {} }, ctx.signal, undefined, ctx);
    h.peer.states.at(-1)!.result.resolve({ ...binding, state });
    expect(await result).toEqual({
      content: [{ type: "text", text: JSON.stringify(expected) }],
      details: expected,
    });
    expect(state).not.toHaveProperty("dayTimeClock");
  }
});

test.each([
  ["get_game_state", "game.state.get", { query: {} }, { query: {} }],
  ["send_message", "game.message.send", { text: "hello" }, { text: "hello" }],
  ["list_event_types", "director.events.list", {}, {}],
  ["get_recent_events", "director.events.get", { query: { limit: 1 } }, { query: { limit: 1 } }],
  [
    "add_response_hook",
    "director.hooks.add",
    { event: "health_changed", filter: {}, instruction: "help" },
    { event: "health_changed", filter: {}, instruction: "help" },
  ],
  ["remove_response_hook", "director.hooks.remove", { id: "hook" }, { id: "hook" }],
  ["list_response_hooks", "director.hooks.list", {}, { query: {} }],
  [
    "list_response_hooks",
    "director.hooks.list",
    { after: "hook", limit: 8 },
    { query: { after: "hook", limit: 8 } },
  ],
  ["list_game_files", "game.files.list", { query: {} }, { query: {} }],
  [
    "read_game_file",
    "game.files.read",
    { query: { root: "minecraft:0", path: "data/x.json" } },
    { query: { root: "minecraft:0", path: "data/x.json" } },
  ],
  [
    "search_game_files",
    "game.files.search",
    { query: { root: "minecraft:0", path: "data", text: "item" } },
    { query: { root: "minecraft:0", path: "data", text: "item" } },
  ],
] as const)(
  "%s retains its arguments, RPC method and run binding",
  async (name, method, args, payload) => {
    const h = await setup();
    const { ctx } = h.context();
    const tool = h.tools.get(name)!;
    expect(Check(tool.parameters, args)).toBe(true);
    expect(Check(tool.parameters, { ...args, runId: "forged" })).toBe(false);
    const result = tool.execute("call", args, undefined, undefined, ctx);
    if (method === "game.state.get")
      h.peer.states[0]!.result.resolve({ ...binding, state: snapshot });
    const value = (await result) as { content: { text: string }[]; details: unknown };
    expect(h.peer.requests.at(-1)).toEqual({ method, params: { ...payload, ...binding } });
    expect(JSON.parse(value.content[0]!.text)).toEqual(value.details);
    if (method === "game.state.get")
      expect(value.details).toEqual({ ...snapshot, dayTimeClock: "12:00" });
    if (method === "game.message.send") expect(value.details).toEqual({ displayed: true });
    if (method.startsWith("game.files.")) expect(value.details).not.toHaveProperty("runId");
    await expect(
      tool.execute("forged", { ...args, runId: "forged" }, undefined, undefined, ctx),
    ).rejects.toMatchObject({ code: -32602 });
    expect(h.peer.closes).toBe(0);
  },
);

test.each([false, true])(
  "owned cancellation rejects late state without retiring; stdio abort first=%s",
  async (stdioFirst) => {
    const h = await setup();
    const first = h.context();
    h.emit("agent_start", first.ctx);
    const pending = Promise.resolve(h.emit("context", first.ctx, { messages: [] }));
    const observed = pending.catch((error: unknown) => error);
    let providerDispatches = 0;
    // Pi catches context exceptions; only synchronous abort prevents the provider boundary.
    const dispatch = observed.then(() => {
      if (!first.controller.signal.aborted) providerDispatches++;
    });
    expect(h.peer.states).toHaveLength(1);
    if (stdioFirst) first.controller.abort();
    // The authenticated TCP control arrives before its stale RPC error, independently of stdio.
    h.peer.receive("director.run.invalidate", binding);
    h.peer.states[0]!.result.reject(
      new RpcError(staleRunErrorCode, "Director run invalidated", binding),
    );
    expect(await observed).toBeInstanceOf(Error);
    await dispatch;
    expect(providerDispatches).toBe(0);
    expect(h.peer.closes).toBe(0);
    expect(first.controller.signal.aborted).toBe(true);
    await expect(
      h.tools
        .get("send_message")!
        .execute("id", { text: "stale" }, first.controller.signal, undefined, first.ctx),
    ).rejects.toThrow();
    expect(h.peer.calls).toEqual(["director.ready", "game.state.get"]);
    const next = { ...binding, runId: "second" };
    expect(() => h.peer.receive("director.run.bind", next)).toThrow();
    h.emit("agent_end", first.ctx);
    expect(() => h.peer.receive("director.run.bind", next)).toThrow();
    h.emit("agent_settled", first.ctx);
    h.peer.receive("director.run.bind", next);
    const second = h.context();
    h.emit("agent_start", second.ctx);
    const fresh = Promise.resolve(h.emit("context", second.ctx, { messages: [] }));
    expect(h.peer.states).toHaveLength(2);
    expect(h.peer.states[1]!.params).toEqual({ ...next, query: {} });
    h.peer.states[1]!.result.resolve({ ...next, state: { ...snapshot, tick: 999 } });
    expect(await fresh).toMatchObject({
      messages: [{ content: expect.stringContaining('"tick":999') }],
    });
    expect(second.controller.signal.aborted).toBe(false);
    expect(h.peer.closes).toBe(0);
  },
);

test.each(["context", "tool"])(
  "malformed required state remains fatal through %s",
  async (path) => {
    const h = await setup();
    const { ctx, controller } = h.context();
    h.emit("agent_start", ctx);
    const pending =
      path === "context"
        ? Promise.resolve(h.emit("context", ctx, { messages: [] }))
        : h.tools
            .get("get_game_state")!
            .execute("id", { query: {} }, controller.signal, undefined, ctx);
    const observed = pending.catch((error: unknown) => error);
    h.peer.states[0]!.result.resolve({ ...binding, state: {} });
    expect(await observed).toBeInstanceOf(Error);
    expect(controller.signal.aborted).toBe(true);
    expect(h.peer.closes).toBe(1);
    h.emit("agent_settled", ctx);
    expect(() => h.peer.receive("director.run.bind", { ...binding, runId: "second" })).toThrow();
  },
);

test.each([
  ["context", "error-first", new RpcError(-32603, "Invalid game result or binding")],
  ["context", "signal-first", new RpcError(-32603, "Invalid game result or binding")],
  ["context", "error-first", new Error("Director run cancelled")],
  ["context", "signal-first", new Error("Director run cancelled")],
  ["tool", "error-first", new RpcError(-32603, "Invalid game result or binding")],
  ["tool", "signal-first", new RpcError(-32603, "Invalid game result or binding")],
] as const)("%s fatal failure survives %s cancellation: %s", async (path, order, failure) => {
  const h = await setup();
  const { ctx, controller } = h.context();
  h.emit("agent_start", ctx);
  const pending =
    path === "context"
      ? Promise.resolve(h.emit("context", ctx, { messages: [] }))
      : h.tools
          .get("get_game_state")!
          .execute("id", { query: {} }, controller.signal, undefined, ctx);
  const observed = pending.catch((error: unknown) => error);
  if (order === "signal-first") controller.abort();
  h.peer.states[0]!.result.reject(failure);
  // Same-chunk parsing rejects the RPC then runs owner control before any await continuation.
  h.peer.receive("director.run.invalidate", binding);
  expect(await observed).toBe(failure);
  expect(controller.signal.aborted).toBe(true);
  expect(h.peer.closes).toBe(1);
  h.emit("agent_settled", ctx);
  expect(() => h.peer.receive("director.run.bind", { ...binding, runId: "second" })).toThrow();
});

test.each(["context", "tool"])(
  "malformed fulfilled %s state remains fatal after owned cancellation",
  async (path) => {
    const h = await setup();
    const { ctx, controller } = h.context();
    h.emit("agent_start", ctx);
    const pending =
      path === "context"
        ? Promise.resolve(h.emit("context", ctx, { messages: [] }))
        : h.tools
            .get("get_game_state")!
            .execute("id", { query: {} }, controller.signal, undefined, ctx);
    const observed = pending.catch((error: unknown) => error);
    h.peer.states[0]!.result.resolve({ ...binding, state: {} });
    h.peer.receive("director.run.invalidate", binding);
    expect(await observed).toBeInstanceOf(Error);
    expect(controller.signal.aborted).toBe(true);
    expect(h.peer.closes).toBe(1);
  },
);

test.each([
  new RpcError(staleRunErrorCode, "stale", undefined),
  new RpcError(staleRunErrorCode, "stale", { ...binding, extra: true }),
  new RpcError(staleRunErrorCode, "stale", { ...binding, runId: "foreign" }),
  new RpcError(-32001, "stale", binding),
])("owned cancellation cannot downgrade unclassified RPC failure: %s", async (failure) => {
  const h = await setup();
  const { ctx, controller } = h.context();
  h.emit("agent_start", ctx);
  const observed = Promise.resolve(h.emit("context", ctx, { messages: [] })).catch(
    (error: unknown) => error,
  );
  h.peer.receive("director.run.invalidate", binding);
  h.peer.states[0]!.result.reject(failure);
  expect(await observed).toBe(failure);
  expect(controller.signal.aborted).toBe(true);
  expect(h.peer.closes).toBe(1);
});

test("typed stale error without owned cancellation remains fatal", async () => {
  const h = await setup();
  const { ctx, controller } = h.context();
  h.emit("agent_start", ctx);
  const observed = Promise.resolve(h.emit("context", ctx, { messages: [] })).catch(
    (error: unknown) => error,
  );
  const failure = new RpcError(staleRunErrorCode, "Director run invalidated", binding);
  h.peer.states[0]!.result.reject(failure);
  expect(await observed).toBe(failure);
  expect(controller.signal.aborted).toBe(true);
  expect(h.peer.closes).toBe(1);
});

test.each(["context", "tool"])(
  "valid fulfilled %s state after owned cancellation is denied without retirement",
  async (path) => {
    const h = await setup();
    const { ctx, controller } = h.context();
    h.emit("agent_start", ctx);
    const pending =
      path === "context"
        ? Promise.resolve(h.emit("context", ctx, { messages: [] }))
        : h.tools
            .get("get_game_state")!
            .execute("id", { query: {} }, controller.signal, undefined, ctx);
    const observed = pending.catch((error: unknown) => error);
    h.peer.states[0]!.result.resolve({ ...binding, state: snapshot });
    h.peer.receive("director.run.invalidate", binding);
    expect(await observed).toBeInstanceOf(Error);
    expect(controller.signal.aborted).toBe(true);
    expect(h.peer.closes).toBe(0);
  },
);

test("owned cancellation before agent_start aborts without dispatch or retirement", async () => {
  const h = await setup();
  h.peer.receive("director.run.invalidate", binding);
  const { ctx, controller } = h.context();
  expect(() => h.emit("agent_start", ctx)).toThrow();
  expect(controller.signal.aborted).toBe(true);
  expect(h.peer.states).toHaveLength(0);
  expect(h.peer.closes).toBe(0);
});

test("late owned invalidation after settlement cannot abort a fresh binding", async () => {
  const h = await setup();
  const { ctx } = h.context();
  h.emit("agent_start", ctx);
  h.emit("agent_settled", ctx);
  h.peer.receive("director.run.invalidate", binding);
  h.peer.receive("director.run.bind", { ...binding, runId: "second" });
  const second = h.context();
  h.emit("agent_start", second.ctx);
  expect(second.controller.signal.aborted).toBe(false);
  expect(h.peer.closes).toBe(0);
});

test.each([
  { ...binding, runId: "foreign" },
  { ...binding, extra: true },
])("unowned or malformed cancellation is fatal: %j", async (params) => {
  const h = await setup();
  const { ctx, controller } = h.context();
  h.emit("agent_start", ctx);
  expect(() => h.peer.receive("director.run.invalidate", params)).toThrow();
  expect(controller.signal.aborted).toBe(true);
  expect(h.peer.closes).toBe(1);
});

test("unowned RPC errors remain fatal regardless of cancellation-looking text", async () => {
  const h = await setup();
  const { ctx, controller } = h.context();
  h.emit("agent_start", ctx);
  const observed = Promise.resolve(h.emit("context", ctx, { messages: [] })).catch(
    (error: unknown) => error,
  );
  const failure = new Error("Director run cancelled");
  h.peer.states[0]!.result.reject(failure);
  expect(await observed).toBe(failure);
  expect(controller.signal.aborted).toBe(true);
  expect(h.peer.closes).toBe(1);
});
