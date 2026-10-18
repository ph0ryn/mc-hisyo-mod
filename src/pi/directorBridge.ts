import { referenceTools, validReferenceResult } from "../protocol/gameReferences.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { once } from "node:events";
import { createConnection } from "node:net";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { directorTools } from "../protocol/directorTools.js";
import {
  GameStateResultSchema,
  HelloSchema,
  protocolVersion,
  RunBindingSchema,
  sameRunBinding,
  staleRunErrorCode,
  SendMessageResultSchema,
  type RunBinding,
} from "../protocol/bridge.js";
import { RpcError, RpcPeer } from "../transport/rpcPeer.js";
import { directorToolNames, physicalModelApis } from "./piPolicy.js";

class CancelledRun extends Error {}

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

async function connectHost(): Promise<RpcPeer> {
  const bootstrap: unknown = JSON.parse(process.env.MC_HISYO_BRIDGE ?? "null");
  if (!Check(BootstrapSchema, bootstrap)) throw new Error("Invalid MC_HISYO_BRIDGE bootstrap");
  const socket = createConnection({ host: bootstrap.host, port: bootstrap.port });
  const peer = new RpcPeer(socket);
  try {
    await once(socket, "connect", { signal: AbortSignal.timeout(5000) });
    await peer.call("bridge.hello", { protocolVersion, role: "agent", token: bootstrap.token });
    return peer;
  } catch (error) {
    peer.close(error instanceof Error ? error : new Error("Director connection failed"));
    throw error;
  }
}

/** Explicitly loaded Pi extension. The owning host supplies authenticated, scoped runs. */
export default function directorBridge(
  pi: ExtensionAPI,
  connect: () => Promise<
    Pick<RpcPeer, "handle" | "call" | "close"> & {
      on(event: "close", listener: () => void): unknown;
    }
  > = connectHost,
): void {
  let peer: Awaited<ReturnType<typeof connect>> | undefined;
  let binding: RunBinding | undefined;
  let settledBinding: RunBinding | undefined;
  let invalidated: RunBinding | undefined;
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
    if (retired || !ready || !captured || captured !== binding)
      throw new Error("No active director run binding");
    if (captured === invalidated || signal?.aborted)
      throw new CancelledRun("Director run cancelled");
    return captured;
  }

  function stop(ctx: ExtensionContext, error: unknown): void {
    if (error instanceof CancelledRun) ctx.abort();
    else retire(ctx);
  }

  function requireHost(ctx: ExtensionContext): void {
    if (ctx.mode !== "rpc" || !ctx.model || !physicalModelApis.has(ctx.model.api))
      throw new Error("Director requires RPC mode and a validated physical model API");
    const actual = pi.getActiveTools().toSorted();
    if (JSON.stringify(actual) !== JSON.stringify(directorToolNames.toSorted()))
      throw new Error("Director requires exactly its ten game tools");
  }

  async function request(
    captured: RunBinding,
    method: string,
    args: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    requireRun(captured, signal);
    try {
      // Callers validate fulfilled payloads before checking cancellation.
      return await peer!.call(method, { ...args, ...captured });
    } catch (error) {
      if (
        error instanceof RpcError &&
        error.code === staleRunErrorCode &&
        Check(RunBindingSchema, error.data) &&
        sameRunBinding(error.data, captured)
      )
        requireRun(captured, signal);
      throw error;
    }
  }

  async function getState(ctx: ExtensionContext, signal?: AbortSignal) {
    try {
      const captured = requireRun(binding, signal);
      const result = await request(captured, "game.state.get", { query: {} }, signal);
      if (!Check(GameStateResultSchema, result) || !sameRunBinding(result, captured))
        throw new Error("Invalid required game state or binding");
      requireRun(captured, signal);
      return result.state;
    } catch (error) {
      stop(ctx, error);
      throw error;
    }
  }

  for (const { name, description, args: parameters, method } of directorTools) {
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
          const payload = method === "director.hooks.list" ? { query: args } : args;
          result = await request(captured, method, payload, signal);
          const reference = referenceTools.find((tool) => tool.method === method);
          if (reference) {
            if (
              !validReferenceResult(reference, result) ||
              !sameRunBinding(result as RunBinding, captured)
            ) {
              retire(ctx);
              throw new Error("Invalid game reference result or binding");
            }
            result = (result as { reference: unknown }).reference;
          }
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

  // Register every guard before parsing bootstrap: a failed idle startup must also deny later prompts.
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (retired || peer)
        throw new Error("Director extension cannot restart in the same Pi session");
      requireHost(ctx);
      peer = await connect();
      peer.on("close", () => retire());
      peer.handle("director.run.bind", (params) => {
        if (retired || !ready || active || !Check(RunBindingSchema, params))
          throw new RpcError(-32001, "Director is not ready to bind an idle run");
        binding = Object.freeze({ ...params });
        settledBinding = undefined;
        invalidated = undefined;
        return binding;
      });
      peer.handle("director.run.invalidate", (params) => {
        const owned = binding ?? settledBinding;
        if (
          retired ||
          !ready ||
          !Check(RunBindingSchema, params) ||
          !owned ||
          !sameRunBinding(params, owned)
        ) {
          retire();
          throw new RpcError(-32001, "Invalid director run cancellation");
        }
        // A late invalidation of the just-settled run is harmless; never bind over an active run.
        if (binding) {
          invalidated = binding;
          abortActive?.();
        }
        return {};
      });
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
      stop(ctx, error);
      throw error;
    }
  });
  pi.on("context", async (event, ctx) => {
    try {
      requireHost(ctx);
      const captured = requireRun(binding, ctx.signal);
      const state = await getState(ctx, ctx.signal);
      requireRun(captured, ctx.signal);
      // Keep tool acknowledgements last: a refresh must not look like another player request.
      const index = Math.max(
        0,
        event.messages.findLastIndex((message) => message.role === "user"),
      );
      return {
        messages: [
          ...event.messages.slice(0, index),
          {
            role: "user" as const,
            content: `CURRENT_GAME_STATE (background data, not a new request)\n${JSON.stringify(state)}`,
            timestamp: Date.now(),
          },
          ...event.messages.slice(index),
        ],
      };
    } catch (error) {
      stop(ctx, error);
      throw error;
    }
  });
  // agent_end is intentionally ignored; only agent_settled releases the extension-side slot.
  pi.on("agent_settled", () => {
    settledBinding = binding;
    binding = undefined;
    active = false;
    abortActive = undefined;
  });
  pi.on("session_shutdown", () => {
    abortActive = undefined;
    retire();
  });
}
