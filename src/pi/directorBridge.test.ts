import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { expect, test } from "vite-plus/test";
import type { RunBinding } from "../protocol/bridge.js";
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
  closes = 0;
  handle(method: string, handler: (params: unknown) => unknown) {
    this.handlers.set(method, handler);
  }
  call(method: string, params: RpcParams): Promise<unknown> {
    this.calls.push(method);
    if (method === "director.ready") return Promise.resolve({ ready: true });
    if (method !== "game.state.get") throw new Error(`Unexpected call ${method}`);
    const result = deferred();
    this.states.push({ params, result });
    return result.promise;
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
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  directorBridge(
    {
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
        handlers.set(name, handler),
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
        tools.set(tool.name, tool),
      getActiveTools: () => [...directorToolNames],
    } as unknown as ExtensionAPI,
    () => Promise.resolve(peer),
  );
  function context(api = "openai-completions") {
    const controller = new AbortController();
    const ctx = {
      mode: "rpc",
      model: { api },
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
  return { peer, context, emit, tools };
}

test.each([false, true])(
  "owned pause rejects late state without retiring; stdio abort first=%s",
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
    h.peer.states[0]!.result.reject(new RpcError(-32001, "late stale result"));
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
