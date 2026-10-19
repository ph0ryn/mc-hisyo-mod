import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  configure,
  Harness,
  section,
  type Conversation,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type Context as ModelContext,
  type Model,
  type Models,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Check } from "typebox/value";
import type { BridgeServer } from "../bridge/bridgeServer.js";
import { hisyoSystemPrompt } from "../pi/hisyoPrompt.js";
import { physicalModelApis } from "../pi/piPolicy.js";
import {
  sameRunBinding,
  sameSessionBinding,
  SendMessageResultSchema,
  type RunBinding,
  type SessionBinding,
} from "../protocol/bridge.js";
import { GameStateSchema, type GameState } from "../protocol/gameState.js";
import { referenceTools, validReferenceResult } from "../protocol/gameReferences.js";
import { hisyoTools } from "../protocol/hisyoTools.js";
import { summaryContextBytes } from "../protocol/summary.js";
import { openDurableStorage } from "./durableStorage.js";
import type { ModelAccess } from "./modelAccess.js";
import { trackModelRequest } from "./trackModelRequest.js";

/** Trusted in-process host boundary; it never exposes an agent TCP connection. */
export type DurableBridge = Pick<
  BridgeServer,
  | "currentSession"
  | "readySession"
  | "beginRun"
  | "finishRun"
  | "invalidateRun"
  | "executeTool"
  | "getGameState"
  | "summaryContext"
  | "beginModelRequest"
  | "recordUsage"
  | "finishModelRequest"
  | "on"
  | "off"
  | "emit"
  | "handlePlayerMessages"
  | "handleObservations"
>;
export interface DurableAgentOptions {
  dataDirectory: string;
  bridge: DurableBridge;
  session: SessionBinding;
  modelAccess: Pick<ModelAccess, "models" | "model">;
  onLog?: (event: string, details?: Record<string, unknown>) => void;
  runTimeoutMs?: number;
}
export type DurableRunResult = { status: "not_started" } | { status: "settled"; aborted: boolean };
interface Flight {
  controller: AbortController;
  binding?: RunBinding;
  failure?: Error;
  promise?: Promise<DurableRunResult>;
}
const owners = new WeakSet<DurableBridge>();

function clock(state: GameState) {
  const ticks = ((state.dayTime % 24_000) + 24_000) % 24_000;
  const hour = (Math.floor(ticks / 1_000) + 6) % 24;
  const minute = Math.floor(((ticks % 1_000) * 60) / 1_000);
  return {
    ...state,
    dayTimeClock: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}
function failedMessage(model: Model<Api>, aborted: boolean): AssistantMessage {
  return {
    role: "assistant",
    provider: model.provider,
    model: model.id,
    api: model.api,
    content: [],
    timestamp: Date.now(),
    stopReason: aborted ? "aborted" : "error",
    errorMessage: "Hisyo model request failed",
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

/** Open storage without scheduling. Only run(), after a native bind ACK, permits recovery. */
export async function startDurableAgent(options: DurableAgentOptions): Promise<DurableAgent> {
  if (owners.has(options.bridge)) throw new Error("Durable agent already owned on this bridge");
  const current = options.bridge.currentSession;
  if (!current || !sameSessionBinding(current.binding, options.session))
    throw new Error("Durable agent requires the current session");
  const { model } = options.modelAccess;
  if (
    model.provider !== "openai" ||
    model.id !== "gpt-6-luna" ||
    !physicalModelApis.has(model.api) ||
    !getSupportedThinkingLevels(model).includes("medium")
  )
    throw new Error("Durable agent requires pinned openai/gpt-6-luna with medium thinking");
  if (
    options.runTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.runTimeoutMs) || options.runTimeoutMs < 1)
  )
    throw new Error("Invalid Durable run timeout");
  options = {
    ...options,
    session: Object.freeze({ ...options.session }),
    modelAccess: { models: options.modelAccess.models, model: structuredClone(model) },
  };
  owners.add(options.bridge);
  let files: Awaited<ReturnType<typeof openDurableStorage>>;
  try {
    files = await openDurableStorage(options.dataDirectory, options.session);
  } catch (error) {
    owners.delete(options.bridge);
    throw error;
  }
  const agent = new DurableAgent(options, files);
  try {
    await agent.initialize(current.language);
    return agent;
  } catch (error) {
    try {
      await agent.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Durable startup and cleanup failed");
    }
    throw error;
  }
}

/** One world/player conversation and single-flight game effects. */
export class DurableAgent extends EventEmitter<{ fault: [error: Error] }> {
  readonly conversationPath: string;
  readonly #options: DurableAgentOptions;
  readonly #files: Awaited<ReturnType<typeof openDurableStorage>>;
  readonly #providerFlights = new Set<Promise<void>>();
  #harness: Harness | undefined;
  #conversation: Conversation | undefined;
  #flight: Flight | undefined;
  #aborting: Promise<void> | undefined;
  #retired = false;
  #closing = false;
  #shutdown?: Promise<void>;
  #kernelClose: Promise<void> | undefined;

  constructor(options: DurableAgentOptions, files: Awaited<ReturnType<typeof openDurableStorage>>) {
    super();
    this.#options = options;
    this.#files = files;
    this.conversationPath = files.path;
  }
  get conversation(): Conversation {
    if (!this.#conversation) throw new Error("Durable conversation is not ready");
    return this.#conversation;
  }
  get isRetired(): boolean {
    return this.#retired;
  }

  async initialize(language: string): Promise<void> {
    const registry = createRegistry();
    const tools: ToolRegistration[] = hisyoTools.map(
      ({ name, description, args: parameters, method }) => ({
        name,
        description,
        parameters,
        // Native display and hook mutations have no idempotency key. Never rerun an interrupted intent.
        replay: "unsafe",
        executionMode: "sequential",
        execute: async (args, _api, context) => {
          const binding = this.#requireRun(context.abortSignal);
          this.#options.onLog?.("tool_execution_start", { toolName: name, args });
          try {
            let result: unknown;
            if (name === "get_game_state")
              result = clock(await this.#options.bridge.getGameState(binding, context.abortSignal));
            else {
              result = await this.#options.bridge.executeTool(
                binding,
                name,
                args,
                context.abortSignal,
              );
              const reference = referenceTools.find((tool) => tool.method === method);
              if (reference) {
                if (
                  !validReferenceResult(reference, result) ||
                  !sameRunBinding(result as RunBinding, binding)
                )
                  throw new Error("Invalid game reference result");
                result = (result as { reference: unknown }).reference;
              } else if (name === "send_message") {
                if (!Check(SendMessageResultSchema, result) || !sameRunBinding(result, binding))
                  throw new Error("Invalid game display result");
                result = { displayed: true };
              }
            }
            this.#requireRun(context.abortSignal, binding);
            this.#options.onLog?.("tool_execution_end", { toolName: name, result });
            return { output: [{ type: "text", text: JSON.stringify(result) }] };
          } catch (error) {
            this.#options.onLog?.("tool_execution_error", { toolName: name });
            throw error;
          }
        },
      }),
    );
    const extension = {
      name: "hisyo",
      tools,
      sections: [section("hisyo", () => hisyoSystemPrompt(language), { tag: false })],
    };
    registry.install(extension);
    const source = this.#options.modelAccess.models;
    // Only streamSimple is the generation path in released Durable 1.3.0 (generation.js:315).
    // Authorization and fresh context are inside this dispatch wrapper. Hook exceptions are NOT fail-closed.
    const guarded = new Proxy(source, {
      get: (target, property) => {
        if (property === "streamSimple")
          return (model: Model<Api>, input: ModelContext, options?: SimpleStreamOptions) =>
            this.#streamMain(model, input, options);
        const member = Reflect.get(target, property, target) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      },
    }) as Models;
    this.#harness = await Harness.open(
      this.#files.storage,
      {
        models: guarded,
        registry,
        settings: {
          retry: { enabled: false },
          compaction: { enabled: false },
          toolExecution: "sequential",
          stream: { maxRetries: 0 },
        },
        onReport: () => {
          this.#options.onLog?.("durable.report");
        },
      },
      BACKGROUND_CONTEXT,
    );
    this.#conversation = await this.#harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "openai", modelId: "gpt-6-luna" }, thinkingLevel: "medium" },
    });
    // root(agent) applies only on first creation: pin persisted state too without resuming the scheduler.
    await this.conversation.commit(
      (tx) =>
        configure(tx, this.conversation.id, {
          model: { provider: "openai", modelId: "gpt-6-luna" },
          thinkingLevel: "medium",
          extensions: [extension],
          tools,
          modelTools: tools,
        }),
      BACKGROUND_CONTEXT,
    );
    this.#options.bridge.on("runInvalidated", this.#invalidated);
    this.#options.bridge.on("detach", this.#detached);
    this.#options.onLog?.("durable.ready", { provider: "openai", model: "gpt-6-luna" });
  }

  #requireSession(): void {
    const current = this.#options.bridge.currentSession;
    if (this.#retired || !current || !sameSessionBinding(current.binding, this.#options.session))
      throw new Error("Durable session is unavailable");
    this.#files.assertCurrent();
  }
  #requireRun(signal?: AbortSignal, captured?: RunBinding): RunBinding {
    this.#requireSession();
    signal?.throwIfAborted();
    const flight = this.#flight;
    flight?.controller.signal.throwIfAborted();
    if (!flight?.binding || (captured && !sameRunBinding(flight.binding, captured)))
      throw new Error("No current native run binding");
    return flight.binding;
  }

  #streamMain(model: Model<Api>, input: ModelContext, options?: SimpleStreamOptions) {
    const stream = createAssistantMessageEventStream();
    const job = (async () => {
      let response: AssistantMessage;
      try {
        const binding = this.#requireRun(options?.signal);
        const state = await this.#options.bridge.getGameState(binding, options?.signal);
        if (!Check(GameStateSchema, state)) throw new Error("Invalid required game state context");
        const summary = this.#options.bridge.summaryContext(binding);
        if (typeof summary !== "string" || Buffer.byteLength(summary) > summaryContextBytes)
          throw new Error("Invalid required summary context");
        this.#requireRun(options?.signal, binding);
        if (
          model.provider !== "openai" ||
          model.id !== "gpt-6-luna" ||
          model.api !== this.#options.modelAccess.model.api
        )
          throw new Error("Unexpected model request");
        // Transient background data goes before the latest user input, preserving trailing tool acknowledgements.
        const messages = [...input.messages];
        const index = Math.max(
          0,
          messages.findLastIndex((message) => message.role === "user"),
        );
        messages.splice(index, 0, {
          role: "user",
          content: `${summary ? `${summary}\n\n` : ""}CURRENT_GAME_STATE (background data, not a new request)\n${JSON.stringify(clock(state))}`,
          timestamp: Date.now(),
        });
        response = await trackModelRequest(
          {
            bridge: this.#options.bridge,
            binding,
            source: "run",
            requestId: binding.runId,
            model,
            signal: options?.signal,
          },
          (observe) =>
            this.#options.modelAccess.models.completeSimple(
              model,
              { ...input, messages },
              { ...options, reasoning: "medium", maxRetries: 0, onProviderStreamEvent: observe },
            ),
        );
      } catch {
        response = failedMessage(
          model,
          options?.signal?.aborted === true || this.#flight?.controller.signal.aborted === true,
        );
        if (this.#flight && !response.stopReason.includes("aborted"))
          this.#flight.failure = new Error("Required context or model request failed");
      }
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        // Provider errors can contain credentials, URLs or request bodies. Durable persists terminal
        // messages, so redact the whole error payload rather than only its user-facing exception.
        response = {
          ...failedMessage(model, response.stopReason === "aborted"),
          usage: response.usage,
        };
        stream.push({
          type: "error",
          reason: response.stopReason as "error" | "aborted",
          error: response,
        });
      } else {
        stream.push({ type: "start", partial: response });
        stream.push({
          type: "done",
          reason: response.stopReason as "stop" | "length" | "toolUse",
          message: response,
        });
      }
    })();
    this.#providerFlights.add(job);
    void job.finally(() => {
      this.#providerFlights.delete(job);
    });
    return stream;
  }

  run(
    message: string,
    signal?: AbortSignal,
    requestId: string = randomUUID(),
  ): Promise<DurableRunResult> {
    if (this.#retired || this.#flight || this.#aborting)
      return Promise.reject(new Error("Durable agent is unavailable or busy"));
    if (signal?.aborted || this.#options.bridge.readySession?.paused)
      return Promise.resolve({ status: "not_started" });
    const flight: Flight = { controller: new AbortController() };
    this.#flight = flight;
    const cancel = () => {
      void this.abort().catch((error: unknown) =>
        this.emit("fault", error instanceof Error ? error : new Error("Durable abort failed")),
      );
    };
    signal?.addEventListener("abort", cancel, { once: true });
    flight.promise = this.#run(message, requestId, flight).finally(() => {
      signal?.removeEventListener("abort", cancel);
      if (this.#flight === flight) this.#flight = undefined;
    });
    return flight.promise;
  }
  async #run(message: string, requestId: string, flight: Flight): Promise<DurableRunResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      this.#requireSession();
      flight.binding = await this.#options.bridge.beginRun();
      if (this.#retired) throw new Error("Durable agent closed during binding");
      if (flight.controller.signal.aborted) return { status: "not_started" };
      timer = setTimeout(() => {
        void this.abort().catch((error: unknown) =>
          this.emit(
            "fault",
            error instanceof Error ? error : new Error("Durable timeout abort failed"),
          ),
        );
      }, this.#options.runTimeoutMs ?? 300_000);
      const submission = await this.conversation.submit(
        { type: "input", content: message, requestId, whenBusy: "reject" },
        BACKGROUND_CONTEXT,
      );
      this.#options.onLog?.("durable.run_submitted");
      const result = await submission.wait(BACKGROUND_CONTEXT);
      await this.conversation.waitForIdle(BACKGROUND_CONTEXT);
      if (flight.failure) throw flight.failure;
      if (result.status === "unanswered" && result.reason !== "aborted")
        throw new Error("Durable model request did not complete");
      const aborted = result.status === "unanswered";
      this.#options.onLog?.("durable.run_settled", { aborted });
      return { status: "settled", aborted };
    } finally {
      clearTimeout(timer);
      // Submission waiters reject as soon as close starts, before provider/tool invocations join.
      // Keep native/usage ownership until those invocations have actually settled.
      if (this.#closing) await this.#kernelClose;
      else await Promise.all(this.#providerFlights);
      if (flight.binding) this.#options.bridge.finishRun(flight.binding);
    }
  }

  /** Explicit cancellation/detach withdraws work; unlike close(), it is durable and terminal. */
  abort(): Promise<void> {
    if (this.#aborting) return this.#aborting;
    if (this.#closing) return Promise.reject(new Error("Durable agent is closing"));
    this.#aborting = Promise.resolve()
      .then(async () => {
        await this.conversation.abort(BACKGROUND_CONTEXT, { background: true });
      })
      .finally(() => {
        this.#aborting = undefined;
      });
    this.#options.bridge.invalidateRun("durable_run_cancelled");
    this.#flight?.controller.abort();
    return this.#aborting;
  }
  readonly #invalidated = (binding: RunBinding, reason: string) => {
    if (this.#closing || !sameSessionBinding(binding, this.#options.session)) return;
    // Host/storage/bind failures interrupt execution but do not express player cancellation.
    // Preserve accepted Durable work; explicit detach/native withdrawal/cancel still abort below.
    if (reason === "runtime_closed" || reason === "storage_failed" || reason === "binding_failed") {
      void this.close().catch((error: unknown) =>
        this.emit("fault", error instanceof Error ? error : new Error("Durable close failed")),
      );
      return;
    }
    void this.abort().catch((error: unknown) =>
      this.emit("fault", error instanceof Error ? error : new Error("Durable invalidation failed")),
    );
  };
  readonly #detached = (binding: SessionBinding) => {
    if (this.#closing || !sameSessionBinding(binding, this.#options.session)) return;
    void this.abort().catch((error: unknown) =>
      this.emit("fault", error instanceof Error ? error : new Error("Durable detach failed")),
    );
  };

  /** Host shutdown preserves pending work. Never call conversation.abort from this path. */
  close(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#shutdown = Promise.resolve().then(() => this.#close());
    this.#closing = true;
    this.#retired = true;
    // Seal/signall the kernel synchronously, before invalidation callbacks or provider continuations.
    // An explicit abort already in progress must finish its durable terminal cancellation first.
    const closeKernel = () =>
      this.#harness
        ? this.#harness.close(BACKGROUND_CONTEXT)
        : this.#files.storage.close(BACKGROUND_CONTEXT);
    this.#kernelClose = this.#aborting ? this.#aborting.then(closeKernel) : closeKernel();
    this.#options.bridge.invalidateRun("durable_agent_closed");
    return this.#shutdown;
  }
  async #close(): Promise<void> {
    await this.#kernelClose;
    await Promise.all(this.#providerFlights);
    await this.#flight?.promise?.catch(() => {});
    this.#options.bridge.off("runInvalidated", this.#invalidated);
    this.#options.bridge.off("detach", this.#detached);
    this.#files.release();
    owners.delete(this.#options.bridge);
  }
}
