import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { once } from "node:events";
import { createConnection } from "node:net";
import { Type, type Static, type TObject } from "typebox";
import { Check } from "typebox/value";
import { HookInputSchema, HookListOptionsSchema } from "../hooks/responseHooks.js";
import {
  EmptySchema,
  EventSearchRequestSchema,
  GameStateResultSchema,
  HelloSchema,
  HookRemoveSchema,
  protocolVersion,
  RunBindingSchema,
  sameRunBinding,
  SendMessageResultSchema,
  SendMessageSchema,
  type RunBinding,
} from "../protocol/bridge.js";
import { RpcError, RpcPeer } from "../transport/rpcPeer.js";
import { directorToolNames, physicalModelApis } from "./piPolicy.js";

const strict = { additionalProperties: false } as const;
const BootstrapSchema = Type.Object(
  {
    protocolVersion: Type.Literal(protocolVersion),
    host: Type.Literal("127.0.0.1"),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    token: HelloSchema.properties.token,
  },
  strict,
);
const stateArgs = Type.Object({ query: EmptySchema }, strict);
const eventArgs = Type.Object({ query: EventSearchRequestSchema.properties.query }, strict);
const messageArgs = Type.Object({ text: SendMessageSchema.properties.text }, strict);
const removeArgs = Type.Object({ id: HookRemoveSchema.properties.id }, strict);

/** Explicitly loaded Pi extension. The owning host supplies authenticated, scoped runs. */
export default function directorBridge(pi: ExtensionAPI): void {
  let peer: RpcPeer | undefined;
  let binding: RunBinding | undefined;
  let ready = false;
  let retired = false;
  let active = false;
  let abortActive: (() => void) | undefined;

  function retire(ctx?: ExtensionContext): void {
    // Abort is synchronous; throwing from a Pi context handler alone is not fail-closed.
    retired = true;
    ready = false;
    binding = undefined;
    if (ctx) ctx.abort();
    else abortActive?.();
    peer?.close(new Error("Director bridge retired"));
  }

  function requireRun(captured = binding, signal?: AbortSignal): RunBinding {
    if (retired || !ready || !captured || captured !== binding || signal?.aborted)
      throw new Error("No active director run binding");
    return captured;
  }

  function requireHost(ctx: ExtensionContext): void {
    if (ctx.mode !== "rpc" || !ctx.model || !physicalModelApis.has(ctx.model.api))
      throw new Error("Director requires RPC mode and a validated physical model API");
    const actual = pi.getActiveTools().toSorted();
    if (JSON.stringify(actual) !== JSON.stringify(directorToolNames.toSorted()))
      throw new Error("Director requires exactly its seven game tools");
  }

  async function request(
    captured: RunBinding,
    method: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    requireRun(captured, signal);
    const result = await peer!.call(method, { ...args, ...captured });
    requireRun(captured, signal);
    return result;
  }

  async function getState(ctx: ExtensionContext, signal?: AbortSignal) {
    try {
      const captured = requireRun(binding, signal);
      const result = await request(captured, "game.state.get", { query: {} }, signal);
      if (!Check(GameStateResultSchema, result) || !sameRunBinding(result, captured))
        throw new Error("Invalid required game state or binding");
      return result.state;
    } catch (error) {
      retire(ctx);
      throw error;
    }
  }

  function tool<T extends TObject>(
    name: (typeof directorToolNames)[number],
    description: string,
    parameters: T,
    method: string,
    payload: (args: Static<T>) => Record<string, unknown> = (args) => args,
  ) {
    pi.registerTool({
      name,
      label: name,
      description,
      parameters,
      async execute(_id, args, signal, _update, ctx) {
        if (!Check(parameters, args)) throw new RpcError(-32602, "Invalid tool arguments");
        const captured = requireRun(binding, signal);
        let result: unknown;
        if (method === "game.state.get") result = await getState(ctx, signal);
        else {
          result = await request(captured, method, payload(args), signal);
          if (method === "game.message.send") {
            if (!Check(SendMessageResultSchema, result) || !sameRunBinding(result, captured)) {
              retire(ctx);
              throw new Error("Invalid game display result or binding");
            }
            result = { displayed: true };
          }
        }
        requireRun(captured, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
  }

  tool(
    "get_game_state",
    "Get a fresh bounded snapshot of the current game. Query must be {}. Nulls and incomplete coverage are explicit.",
    stateArgs,
    "game.state.get",
  );
  tool(
    "send_message",
    "Display text to the player. This is the only way to speak in game; ordinary assistant text is not displayed.",
    messageArgs,
    "game.message.send",
  );
  tool(
    "list_event_types",
    "List attached-game hook capabilities and searchable-only CLI Director activities, with explicit origin, hookability, filters and observation limitations.",
    EmptySchema,
    "director.events.list",
  );
  tool(
    "get_recent_events",
    "Search game and Director activity history for this world/player across sessions. Pages are byte-bounded; preserve through and resume nextCursor. Scalar filters are type-sensitive AND matches; inspect gap flags. Requests/matches do not prove provider execution.",
    eventArgs,
    "director.events.get",
  );
  tool(
    "add_response_hook",
    "Persist an event response instruction for this world/player. Use advertised event types and filter fields.",
    HookInputSchema,
    "director.hooks.add",
  );
  tool(
    "remove_response_hook",
    "Remove a response hook by its ID from this world/player.",
    removeArgs,
    "director.hooks.remove",
  );
  tool(
    "list_response_hooks",
    "List persistent response hooks with keyset pagination. Default and maximum page size is 8; pages are not a snapshot.",
    HookListOptionsSchema,
    "director.hooks.list",
    (query) => ({ query }),
  );

  // Register every guard before parsing bootstrap: a failed idle startup must also deny later prompts.
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (retired || peer)
        throw new Error("Director extension cannot restart in the same Pi session");
      requireHost(ctx);
      const bootstrap: unknown = JSON.parse(process.env.MC_HISYO_BRIDGE ?? "null");
      if (!Check(BootstrapSchema, bootstrap)) throw new Error("Invalid MC_HISYO_BRIDGE bootstrap");
      const socket = createConnection({ host: bootstrap.host, port: bootstrap.port });
      peer = new RpcPeer(socket);
      peer.on("close", () => retire());
      peer.handle("director.run.bind", (params) => {
        if (retired || !ready || active || !Check(RunBindingSchema, params))
          throw new RpcError(-32001, "Director is not ready to bind an idle run");
        binding = Object.freeze({ ...params });
        return binding;
      });
      await once(socket, "connect", { signal: AbortSignal.timeout(5000) });
      await peer.call("bridge.hello", { protocolVersion, role: "agent", token: bootstrap.token });
      // No stdio ACK here: Pi installs its RPC stdin reader only after session_start completes.
      // The host can bind as soon as it handles ready, before this call's ACK arrives.
      ready = true;
      await peer.call("director.ready", {});
      if (retired) throw new Error("Director disconnected during startup");
    } catch (error) {
      retire(ctx);
      throw error;
    }
  });
  pi.on("agent_start", (_event, ctx) => {
    active = true;
    abortActive = () => ctx.abort();
    try {
      requireHost(ctx);
      requireRun();
    } catch (error) {
      retire(ctx);
      throw error;
    }
  });
  pi.on("context", async (event, ctx) => {
    try {
      requireHost(ctx);
      const captured = requireRun(binding, ctx.signal);
      const state = await getState(ctx, ctx.signal);
      requireRun(captured, ctx.signal);
      return {
        messages: [
          ...event.messages,
          {
            role: "user" as const,
            content: `CURRENT_GAME_STATE\n${JSON.stringify(state)}`,
            timestamp: Date.now(),
          },
        ],
      };
    } catch (error) {
      retire(ctx);
      throw error;
    }
  });
  // agent_end is intentionally ignored; only agent_settled releases the extension-side slot.
  pi.on("agent_settled", () => {
    binding = undefined;
    active = false;
    abortActive = undefined;
  });
  pi.on("session_shutdown", () => {
    abortActive = undefined;
    retire();
  });
}
