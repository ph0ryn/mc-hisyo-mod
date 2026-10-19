import { referenceTools, validReferenceResult } from "../protocol/gameReferences.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import type { EventLog, StoredEvent } from "../storage/eventLog.js";
import type { ActivityLog } from "../storage/activityLog.js";
import {
  activity,
  activityCatalog,
  displayedActivity,
  isActivity,
  runRequestActivities,
} from "../events/activity.js";
import type { RunRequest } from "../runtime/runQueue.js";
import type { Hook, HookStore } from "../storage/hookStore.js";
import {
  EmptySchema,
  EventSearchRequestSchema,
  GameAttachSchema,
  GameEventsSchema,
  GameStateRequestSchema,
  GameStateResultSchema,
  GameStatusSchema,
  HelloSchema,
  HookAddSchema,
  HookListRequestSchema,
  HookRemoveSchema,
  PlayerMessageSchema,
  RunBindingSchema,
  SendMessageResultSchema,
  SendMessageSchema,
  SessionBindingSchema,
  protocolVersion,
  sameRunBinding,
  sameSessionBinding,
  staleRunErrorCode,
  type BridgeRole,
  type RunBinding,
  type SessionBinding,
} from "../protocol/bridge.js";
import { type GameEvent } from "../protocol/gameEvent.js";
import { RpcError, RpcPeer } from "../transport/rpcPeer.js";
import type { SummaryStore } from "../storage/summaryStore.js";
import { TokenUsageRequestSchema } from "../protocol/tokenUsage.js";
import type { SummaryRequest } from "../protocol/summary.js";
import {
  SummaryRequestSchema,
  SummaryResultSchema,
  summaryInputBytes,
  validateSummaryText,
} from "../protocol/summary.js";

export interface AttachedSession {
  binding: SessionBinding;
  language: string;
  supportedEvents: readonly string[];
  paused: boolean;
}
type PlayerMessageHandler = (binding: SessionBinding, text: string) => undefined;
interface Connection {
  peer: RpcPeer;
  role: BridgeRole | undefined;
  ready: boolean;
}
interface BridgeOptions {
  token: string;
  eventLog: EventLog;
  activityLog: ActivityLog;
  summaries: SummaryStore;
  hooks: HookStore;
  helloTimeoutMs?: number;
}

/** Owns authorization and binding, never model scheduling or Minecraft objects. */
export class BridgeServer extends EventEmitter<{
  attach: [session: AttachedSession];
  detach: [binding: SessionBinding];
  status: [session: AttachedSession];
  agentReady: [];
  runInvalidated: [binding: RunBinding, reason: string];
  observation: [stored: StoredEvent, hooks: Hook[]];
  runRequested: [batch: RunRequest];
  peerClosed: [role: BridgeRole | undefined, reason: Error];
  fault: [error: Error];
}> {
  readonly summaries: SummaryStore;
  #summaryRequest: SummaryRequest | undefined;
  readonly #options: BridgeOptions;
  readonly #server: ReturnType<typeof createServer>;
  readonly #connections = new Set<Connection>();
  #game: Connection | undefined;
  #availability: { game: Connection; promise: Promise<void>; resolve: () => void } | undefined;
  #agent: Connection | undefined;
  #session: AttachedSession | undefined;
  #playerMessageIntake: { accept: PlayerMessageHandler } | undefined;
  // Invalidated runs still occupy the single-flight slot until the owner observes settled.
  #run:
    | { binding: RunBinding; valid: boolean; agentBindingSent: boolean; wake: () => void }
    | undefined;
  #closing = false;
  #storageFailed = false;
  #starting: Promise<unknown[]> | undefined;
  #shutdown: Promise<void> | undefined;

  constructor(
    options: BridgeOptions,
    listener = (accept: (peer: RpcPeer) => void) =>
      createServer((socket) => accept(new RpcPeer(socket))),
  ) {
    super();
    this.#server = listener((peer) => this.#accept(peer));
    if (!Check(HelloSchema.properties.token, options.token))
      throw new Error("Invalid bridge token");
    const timeout = options.helloTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("Invalid hello timeout");
    if (options.eventLog.db === options.activityLog.db)
      throw new Error("Game observations and Hisyo activity require separate databases");
    if (options.activityLog.db !== options.hooks.db)
      throw new Error("Activity and hooks must share one database");
    this.#options = options;
    this.summaries = options.summaries;
    this.on("runRequested", (batch) => {
      this.#requireSession(batch.binding);
      this.#storage(() => options.activityLog.appendActivities(runRequestActivities(batch)));
    });
    this.#server.maxConnections = 4;
    this.#server.on("error", (error) => this.emit("fault", error));
  }

  async listen(): Promise<{ host: "127.0.0.1"; port: number }> {
    if (this.#closing) throw new Error("Bridge closed");
    if (this.#starting) throw new Error("Bridge already started");
    this.#starting = once(this.#server, "listening");
    this.#server.listen(0, "127.0.0.1");
    await this.#starting;
    if (this.#closing) throw new Error("Bridge closed during startup");
    const address = this.#server.address() as AddressInfo;
    return { host: "127.0.0.1", port: address.port };
  }

  get currentSession(): AttachedSession | undefined {
    return this.#session ? structuredClone(this.#session) : undefined;
  }

  get readySession(): AttachedSession | undefined {
    return !this.#closing && !this.#storageFailed && this.#game?.ready
      ? this.currentSession
      : undefined;
  }

  get isAgentReady(): boolean {
    return this.#agent?.ready === true;
  }

  /** Independent, session-bound completion. No main run or tool ownership is acquired. */
  async summarize(binding: SessionBinding, input: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    this.#requireSession(binding);
    if (!this.#agent?.ready || this.#summaryRequest)
      throw new Error("Summarization is not available");
    const agent = this.#agent;
    const request = { ...binding, requestId: randomUUID(), input };
    if (!Check(SummaryRequestSchema, request) || Buffer.byteLength(input) > summaryInputBytes)
      throw new Error("Invalid summary request");
    this.#summaryRequest = request;
    const cancel = () => {
      try {
        agent.peer.notify("hisyo.summary.cancel", { ...binding, requestId: request.requestId });
      } catch {
        agent.peer.close(new Error("Summary cancellation transport failed"));
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      // The normal transport deadline is only 5s. Keep it for tools, not model completions.
      const result = await agent.peer.call("hisyo.summary.create", request, 300_000);
      if (
        !Check(SummaryResultSchema, result) ||
        !sameSessionBinding(result, binding) ||
        result.requestId !== request.requestId
      )
        throw new Error("Invalid summary result or binding");
      signal.throwIfAborted();
      this.#requireSession(binding);
      if (agent !== this.#agent || result.cancelled) throw new Error("Summary became stale");
      validateSummaryText(result.summary);
      return result.summary;
    } finally {
      signal.removeEventListener("abort", cancel);
      this.#summaryRequest = undefined;
    }
  }

  /** Retain input synchronously before returning, or throw RpcError to refuse it. */
  handlePlayerMessages(accept: PlayerMessageHandler): () => void {
    if (this.#closing) throw new Error("Bridge closed");
    if (this.#playerMessageIntake) throw new Error("Player-message intake already registered");
    const intake = { accept };
    this.#playerMessageIntake = intake;
    return () => {
      if (this.#playerMessageIntake === intake) this.#playerMessageIntake = undefined;
    };
  }

  close(): Promise<void> {
    return (this.#shutdown ??= this.#close());
  }

  async #close(): Promise<void> {
    this.#closing = true;
    this.#resolveAvailability();
    this.#playerMessageIntake = undefined;
    // listen() retains its own startup error; disposal must wait for either outcome.
    if (this.#starting) await Promise.allSettled([this.#starting]);
    for (const connection of this.#connections)
      connection.peer.close(new Error("Bridge shutting down"));
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async beginRun(): Promise<RunBinding> {
    // The scheduler alone gates dispatch on pause. An admitted run may bind after
    // asynchronous preparation, even if a newer pause report has since arrived.
    if (this.#run) throw new Error("Previous run has not settled");
    const session = this.#session;
    const game = this.#game;
    const agent = this.#agent;
    if (this.#closing || this.#storageFailed || !session || !game?.ready || !agent?.ready)
      throw new Error("Game and agent are not ready for run");
    const binding = Object.freeze({ ...session.binding, runId: randomUUID() });
    const run = { binding, valid: true, agentBindingSent: false, wake: () => {} };
    this.#run = run;
    try {
      // Keep intake/clock factual while reserving the existing slot, but do not bind natively
      // until this game's authoritative status resolves its withdrawn-run uncertainty.
      if (this.#availability?.game === game) {
        const available = this.#availability.promise;
        await new Promise<void>((resolve) => {
          run.wake = resolve;
          void available.then(resolve);
        });
      }
      this.#requireRun(binding);
      await this.#bind(game.peer, "game.run.bind", binding);
      this.#requireRun(binding);
      run.agentBindingSent = true;
      await this.#bind(agent.peer, "hisyo.run.bind", binding);
      this.#requireRun(binding);
      return binding;
    } catch (error) {
      if (this.#run === run) {
        this.invalidateRun("binding_failed");
        this.#run = undefined; // No prompt was sent, so there is no run to await.
      }
      throw error;
    }
  }

  finishRun(binding: RunBinding): boolean {
    const run = this.#run;
    if (!run || !sameRunBinding(run.binding, binding)) return false;
    if (run.valid) this.#clearGameRun(binding);
    this.#run = undefined;
    return true;
  }

  invalidateRun(reason: string): void {
    const run = this.#run;
    if (!run?.valid) return;
    run.valid = false;
    run.wake();
    // Same authenticated pipe as state replies: cancellation precedes any late stale error.
    const peer = this.#agent?.peer;
    if (run.agentBindingSent && peer && !peer.isClosed) {
      try {
        peer.notify("hisyo.run.invalidate", run.binding);
      } catch (error) {
        peer.close(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.#clearGameRun(run.binding);
    this.emit("runInvalidated", run.binding, reason);
  }

  #clearGameRun(binding: RunBinding): void {
    const peer = this.#game?.peer;
    if (!peer || peer.isClosed) return;
    try {
      peer.notify("game.run.clear", binding);
    } catch (error) {
      peer.close(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #bind(peer: RpcPeer, method: string, binding: RunBinding): Promise<void> {
    const result = await peer.call(method, binding);
    if (!Check(RunBindingSchema, result) || !sameRunBinding(result, binding)) {
      const error = new Error("Invalid run binding acknowledgment");
      peer.close(error);
      throw error;
    }
  }

  #requireSession(binding: SessionBinding): AttachedSession {
    if (
      this.#closing ||
      this.#storageFailed ||
      !this.#session ||
      !sameSessionBinding(this.#session.binding, binding)
    )
      throw new RpcError(-32001, "Inactive or stale session binding");
    return this.#session;
  }

  #requireRun(binding: RunBinding): { worldId: string; playerId: string } {
    const run = this.#run;
    if (
      !this.#closing &&
      !this.#storageFailed &&
      run &&
      !run.valid &&
      sameRunBinding(run.binding, binding)
    )
      throw new RpcError(staleRunErrorCode, "Hisyo run invalidated", run.binding);
    const session = this.#requireSession(binding);
    if (!this.#run?.valid || !sameRunBinding(this.#run.binding, binding))
      throw new RpcError(-32001, "Inactive or stale execution binding");
    return { worldId: session.binding.worldId, playerId: session.binding.playerId };
  }

  #accept(peer: RpcPeer): void {
    if (this.#closing) {
      peer.close(new Error("Bridge closed"));
      return;
    }
    const connection: Connection = { peer, role: undefined, ready: false };
    this.#connections.add(connection);
    const timer = setTimeout(
      () => peer.close(new Error("Bridge hello timed out")),
      this.#options.helloTimeoutMs ?? 5_000,
    );
    timer.unref();
    peer.once("close", (reason) => {
      clearTimeout(timer);
      this.#connections.delete(connection);
      if (this.#game === connection) {
        this.#detach(this.#closing ? "bridge_shutdown" : "link_closed");
        this.#game = undefined;
      }
      if (this.#agent === connection) {
        this.#agent = undefined;
        this.invalidateRun("agent_disconnected");
      }
      this.emit("peerClosed", connection.role, reason);
    });
    peer.handle("bridge.hello", (params) => {
      if (connection.role) throw new RpcError(-32010, "Already authenticated");
      if (
        !Check(HelloSchema, params) ||
        !timingSafeEqual(Buffer.from(params.token), Buffer.from(this.#options.token))
      ) {
        peer.close(new Error("Bridge authentication failed"));
        throw new RpcError(-32010, "Authentication failed");
      }
      if (params.role === "game" ? this.#game : this.#agent)
        throw new RpcError(-32002, "Bridge role already connected");
      connection.role = params.role;
      if (params.role === "game") this.#game = connection;
      else this.#agent = connection;
      clearTimeout(timer);
      return { protocolVersion, role: params.role };
    });
    this.#register(connection, "hisyo.usage.record", "agent", TokenUsageRequestSchema, (params) => {
      const owned = params.source === "run" ? this.#run?.binding : this.#summaryRequest;
      const requestId =
        params.source === "run" ? this.#run?.binding.runId : this.#summaryRequest?.requestId;
      // Cancellation discards output, not usage. Retain the original scope until its slot settles.
      if (
        !connection.ready ||
        !owned ||
        !sameSessionBinding(params, owned) ||
        params.requestId !== requestId
      )
        throw new RpcError(-32001, "No matching model request for token usage");
      const { worldId, playerId, sessionId, ...data } = params;
      this.#storage(() =>
        this.#options.activityLog.appendActivity(
          activity({ worldId, playerId, sessionId }, "hisyo.token_usage", data),
        ),
      );
      return { recorded: true };
    });
    this.#register(connection, "hisyo.summary.get", "agent", RunBindingSchema, (params) => {
      const scope = this.#requireRun(params);
      return { ...params, text: this.#storage(() => this.summaries.context(scope)) };
    });
    this.#register(connection, "hisyo.ready", "agent", EmptySchema, () => {
      if (connection.ready) throw new RpcError(-32002, "Agent already ready");
      connection.ready = true;
      this.emit("agentReady");
      return { ready: true };
    });
    this.#register(connection, "game.attach", "game", GameAttachSchema, (params) => {
      if (this.#session) throw new RpcError(-32002, "Detach the current session before attaching");
      for (const name of params.supportedEvents) this.#requireEvent(name);
      const binding = Object.freeze({
        worldId: params.worldId,
        playerId: params.playerId,
        sessionId: randomUUID(),
      });
      this.#session = {
        binding,
        language: params.language,
        supportedEvents: [...params.supportedEvents],
        paused: params.paused,
      };
      connection.ready = false;
      return binding;
    });
    this.#register(connection, "game.ready", "game", SessionBindingSchema, (params) => {
      this.#requireSession(params);
      if (connection.ready) throw new RpcError(-32002, "Game already ready");
      this.#storage(() =>
        this.#options.activityLog.appendActivity(
          activity(params, "hisyo.session_attached", { beforeAttachment: "unknown" }),
        ),
      );
      connection.ready = true;
      this.emit("attach", this.currentSession!);
      return { ready: true };
    });
    this.#register(connection, "game.detach", "game", SessionBindingSchema, (params) => {
      this.#requireSession(params);
      this.#detach();
      return { detached: true };
    });
    this.#register(connection, "game.status", "game", GameStatusSchema, (params) => {
      const session = this.#requireSession(params);
      // Status can race startup readiness; it updates facts, never grants readiness.
      session.paused = params.paused;
      this.#storage(() =>
        this.#options.activityLog.appendActivity(
          activity(session.binding, "hisyo.status_reported", { paused: params.paused }),
        ),
      );
      this.#requireSession(params);
      if (!params.paused) this.#resolveAvailability();
      if (connection.ready) this.emit("status", this.currentSession!);
      return { paused: params.paused };
    });
    this.#register(connection, "game.events", "game", GameEventsSchema, (params) => {
      this.#storeEvents(params.events);
      return { stored: params.events.length };
    });
    this.#register(connection, "game.player_message", "game", PlayerMessageSchema, (params) => {
      const session = this.#requireSession(params);
      if (!params.text.trim()) throw new RpcError(-32602, "Player message is blank");
      if (this.#closing || !connection.ready || !this.#playerMessageIntake)
        throw new RpcError(-32003, "Hisyo is not accepting player messages");
      this.#storage(() =>
        this.#options.activityLog.appendActivity(
          activity(session.binding, "hisyo.player_input", { text: params.text }),
        ),
      );
      this.#playerMessageIntake.accept(session.binding, params.text);
      return { accepted: true };
    });
    this.#register(connection, "hisyo.hooks.add", "agent", HookAddSchema, (params) => {
      const scope = this.#requireRun(params);
      this.#requireEvent(params.event);
      const { event, filter, instruction } = params;
      if (!instruction.trim()) throw new RpcError(-32602, "Hook instruction is blank");
      this.#options.hooks.catalog.validateFilter(event, filter ?? {});
      const input = filter === undefined ? { event, instruction } : { event, filter, instruction };
      return this.#storage(() =>
        this.#options.activityLog.atomic(() => {
          const hook = this.#options.hooks.add(scope, input);
          this.#options.activityLog.appendActivity(
            activity(params, "hisyo.hook_added", {
              runId: params.runId,
              hookId: hook.id,
              event: hook.event,
              filter: hook.filter,
              instruction: hook.instruction,
            }),
          );
          return hook;
        }),
      );
    });
    this.#register(connection, "hisyo.hooks.remove", "agent", HookRemoveSchema, (params) => {
      const scope = this.#requireRun(params);
      return this.#storage(() =>
        this.#options.activityLog.atomic(() => {
          const removed = this.#options.hooks.remove(scope, params.id);
          if (removed)
            this.#options.activityLog.appendActivity(
              activity(params, "hisyo.hook_removed", { runId: params.runId, hookId: params.id }),
            );
          return { removed };
        }),
      );
    });
    this.#register(connection, "hisyo.hooks.list", "agent", HookListRequestSchema, (params) => {
      const scope = this.#requireRun(params);
      return this.#storage(() => this.#options.hooks.list(scope, params.query));
    });
    this.#register(
      connection,
      "hisyo.events.search",
      "agent",
      EventSearchRequestSchema,
      (params) => {
        const scope = this.#requireRun(params);
        const { event, filter } = params.query;
        if (filter !== undefined && event === undefined)
          throw new RpcError(-32602, "A filter requires an event");
        if (event !== undefined)
          (isActivity(event) ? activityCatalog : this.#options.eventLog.catalog).validateFilter(
            event,
            filter ?? {},
          );
        const log =
          event !== undefined && isActivity(event)
            ? this.#options.activityLog
            : this.#options.eventLog;
        return this.#storage(() => log.search(scope, params.query));
      },
    );
    this.#register(connection, "hisyo.events.list", "agent", RunBindingSchema, (params) => {
      this.#requireRun(params);
      return {
        events: [
          ...this.#options.eventLog.catalog
            .list()
            .filter((definition) => this.#session!.supportedEvents.includes(definition.name))
            .map((definition) => ({ ...definition, origin: "game", hookable: true })),
          ...activityCatalog
            .list()
            .map((definition) => ({ ...definition, origin: "cli", hookable: false })),
        ],
      };
    });
    for (const reference of referenceTools) {
      this.#register(connection, reference.method, "agent", reference.request, (params) =>
        this.#forward(reference.method, params, reference.result),
      );
    }
    this.#register(connection, "game.state.get", "agent", GameStateRequestSchema, (params) =>
      this.#forward("game.state.get", params, GameStateResultSchema),
    );
    this.#register(connection, "game.message.send", "agent", SendMessageSchema, (params) => {
      if (!params.text.trim()) throw new RpcError(-32602, "AI message is blank");
      return this.#forward("game.message.send", params, SendMessageResultSchema);
    });
  }

  #storeEvents(events: readonly GameEvent[]) {
    for (const event of events) {
      const session = this.#requireSession(event);
      if (!session.supportedEvents.includes(event.event))
        throw new RpcError(-32602, "Unadvertised event");
    }
    const results = this.#storage(() => {
      const storedEvents = this.#options.eventLog.atomic(() =>
        events.map((event) => this.#options.eventLog.append(event)),
      );
      // Independent databases: raw observations stay durable if later activity work fails.
      // Neither delivery nor the game ACK happens until both local transactions succeed.
      return this.#options.activityLog.atomic(() =>
        storedEvents.map((stored) => {
          const hooks = this.#options.hooks.match(stored.observation);
          for (const hook of hooks)
            this.#options.activityLog.appendActivity(
              activity(stored.observation, "hisyo.hook_matched", {
                hookId: hook.id,
                sourceEventId: stored.id,
              }),
            );
          return { stored, hooks };
        }),
      );
    });
    for (const { stored, hooks } of results) this.emit("observation", stored, hooks);
    return results;
  }

  #register<T extends TSchema>(
    connection: Connection,
    method: string,
    role: BridgeRole,
    schema: T,
    handler: (params: Static<T>) => unknown,
  ): void {
    connection.peer.handle(method, (params) => {
      if (connection.role !== role)
        throw new RpcError(-32010, "Unauthenticated or forbidden bridge role");
      if (
        this.#closing ||
        this.#storageFailed ||
        connection.peer.isClosed ||
        (role === "game" ? this.#game : this.#agent) !== connection
      )
        throw new RpcError(-32003, "Bridge connection is inactive");
      if (!Check(schema, params)) throw new RpcError(-32602, "Invalid method parameters");
      return handler(params);
    });
  }

  #requireEvent(name: string): void {
    if (isActivity(name))
      throw new RpcError(
        -32602,
        "Hisyo activities are searchable only, not game hook capabilities",
      );
    if (
      !(
        this.#session?.supportedEvents ??
        this.#options.eventLog.catalog.list().map((definition) => definition.name)
      ).includes(name)
    )
      throw new RpcError(-32602, "Unsupported event capability");
  }

  #resolveAvailability(): void {
    const pending = this.#availability;
    this.#availability = undefined;
    pending?.resolve();
  }

  #detach(reason = "game_detached"): void {
    this.#resolveAvailability();
    const session = this.#session;
    if (!session) return;
    const attached = this.#game?.ready === true;
    this.#session = undefined;
    if (this.#game) this.#game.ready = false;
    this.invalidateRun("world_detached");
    this.emit("detach", session.binding);
    if (attached && !this.#storageFailed) {
      try {
        this.#storage(() =>
          this.#options.activityLog.appendActivity(
            activity(session.binding, "hisyo.session_detached", {
              reason,
              afterLastObservation: "unknown",
            }),
          ),
        );
      } catch {
        // #storage reported the fatal failure; retirement and peer cleanup must finish.
      }
    }
  }

  #storage<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (!this.#storageFailed) {
        this.#storageFailed = true;
        this.#resolveAvailability();
        this.invalidateRun("storage_failed");
        this.emit(
          "fault",
          error instanceof Error ? error : new Error("Log storage failed", { cause: error }),
        );
      }
      throw error;
    }
  }

  async #forward(
    method: string,
    params: RunBinding & Record<string, unknown>,
    schema: TSchema,
  ): Promise<unknown> {
    this.#requireRun(params);
    // Capture literal request data before awaiting; never retarget a delayed display fact.
    const captured = structuredClone(params);
    const game = this.#game!;
    const agent = this.#agent!;
    const run = this.#run!;
    let result: unknown;
    try {
      result = await game.peer.call(method, captured);
    } catch (error) {
      // Only this authenticated native producer's owned capture is withdrawal evidence.
      if (
        error instanceof RpcError &&
        error.code === -32001 &&
        error.data === undefined &&
        !this.#closing &&
        !this.#storageFailed &&
        this.#game === game &&
        this.#agent === agent &&
        this.#run === run &&
        !game.peer.isClosed &&
        !agent.peer.isClosed &&
        sameRunBinding(run.binding, captured)
      ) {
        this.#requireSession(captured);
        if (run.valid) {
          let resolve!: () => void;
          const promise = new Promise<void>((yes) => {
            resolve = yes;
          });
          this.#availability = { game, promise, resolve };
          this.invalidateRun("native_run_withdrawn");
        }
        this.#requireRun(captured);
      }
      throw error;
    }
    if (
      !Check(schema, result) ||
      !sameRunBinding(result as RunBinding, captured) ||
      (method.startsWith("game.files.") &&
        !validReferenceResult({ method, result: schema }, result))
    )
      throw new RpcError(-32603, "Invalid game result or binding");
    if (method === "game.message.send")
      this.#storage(() =>
        this.#options.activityLog.appendActivity(displayedActivity(captured, result)),
      );
    this.#requireRun(captured);
    return result;
  }
}
