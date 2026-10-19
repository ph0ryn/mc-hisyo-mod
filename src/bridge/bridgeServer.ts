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
import { hisyoTools } from "../protocol/hisyoTools.js";
import { type GameEvent } from "../protocol/gameEvent.js";
import { RpcError, RpcPeer } from "../transport/rpcPeer.js";
import type { SummaryStore } from "../storage/summaryStore.js";
import { TokenUsageRequestSchema, type TokenUsageData } from "../protocol/tokenUsage.js";

export interface AttachedSession {
  binding: SessionBinding;
  language: string;
  supportedEvents: readonly string[];
  paused: boolean;
}
type PlayerMessageHandler = (binding: SessionBinding, text: string) => Promise<void> | void;
type ObservationHandler = (stored: StoredEvent, hooks: Hook[]) => Promise<void> | void;
type ModelRequestSource = TokenUsageData["source"];
interface ModelRequest {
  binding: SessionBinding;
  requestId: string;
}
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

/** Trusted in-process host API and authenticated game wire. Never schedules or runs models. */
export class BridgeServer extends EventEmitter<{
  attach: [session: AttachedSession];
  detach: [binding: SessionBinding];
  status: [session: AttachedSession];
  runInvalidated: [binding: RunBinding, reason: string];
  observation: [stored: StoredEvent, hooks: Hook[]];
  runRequested: [batch: RunRequest];
  peerClosed: [role: BridgeRole | undefined, reason: Error];
  fault: [error: Error];
}> {
  readonly summaries: SummaryStore;
  readonly #options: BridgeOptions;
  readonly #server: ReturnType<typeof createServer>;
  readonly #connections = new Set<Connection>();
  readonly #modelRequests = new Map<ModelRequestSource, ModelRequest>();
  #game: Connection | undefined;
  #availability: { game: Connection; promise: Promise<void>; resolve: () => void } | undefined;
  #session: AttachedSession | undefined;
  #playerMessageIntake: { accept: PlayerMessageHandler } | undefined;
  #observationIntake: { accept: ObservationHandler } | undefined;
  // Invalidated runs retain the single-flight slot until their owner observes settlement.
  #run: { binding: RunBinding; valid: boolean; wake: () => void } | undefined;
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

  /** Scope usage independently from result validity, retaining ownership through cancellation. */
  beginModelRequest(binding: SessionBinding, source: ModelRequestSource, requestId: string): void {
    this.#requireSession(binding);
    if (!this.#game?.ready || !Check(TokenUsageRequestSchema.properties.requestId, requestId))
      throw new RpcError(-32001, "No ready session for model request");
    if (source !== "run" && source !== "summary") throw new Error("Invalid model request source");
    if (this.#modelRequests.has(source)) throw new Error("Previous model request has not settled");
    if (source === "run") {
      const run = this.#run;
      if (!run || requestId !== run.binding.runId || !sameSessionBinding(binding, run.binding))
        throw new RpcError(-32001, "No matching run for model request");
      this.#requireRun(run.binding);
    }
    const { worldId, playerId, sessionId } = binding;
    this.#modelRequests.set(source, { binding: { worldId, playerId, sessionId }, requestId });
  }

  finishModelRequest(
    binding: SessionBinding,
    source: ModelRequestSource,
    requestId: string,
  ): boolean {
    const request = this.#modelRequests.get(source);
    if (
      !request ||
      request.requestId !== requestId ||
      !sameSessionBinding(request.binding, binding)
    )
      return false;
    return this.#modelRequests.delete(source);
  }

  recordUsage(params: unknown): { recorded: true } {
    if (!Check(TokenUsageRequestSchema, params)) throw new RpcError(-32602, "Invalid token usage");
    const request = this.#modelRequests.get(params.source);
    // Detached/cancelled output is discarded; its metering still belongs to the original scope.
    if (
      this.#closing ||
      this.#storageFailed ||
      !request ||
      !sameSessionBinding(request.binding, params) ||
      request.requestId !== params.requestId
    )
      throw new RpcError(-32001, "No matching model request for token usage");
    const { worldId, playerId, sessionId, ...data } = params;
    this.#storage(() =>
      this.#options.activityLog.appendActivity(
        activity({ worldId, playerId, sessionId }, "hisyo.token_usage", data),
      ),
    );
    return { recorded: true };
  }

  summaryContext(binding: RunBinding): string {
    this.#parameters(RunBindingSchema, binding);
    const scope = this.#requireRun(binding);
    return this.#storage(() => this.summaries.context(scope));
  }

  async getGameState(
    binding: RunBinding,
    signal?: AbortSignal,
  ): Promise<Static<typeof GameStateResultSchema>["state"]> {
    const result = await this.executeTool(binding, "get_game_state", { query: {} }, signal);
    return (result as Static<typeof GameStateResultSchema>).state;
  }

  /** Only the ten canonical game tools cross this trusted boundary; no agent TCP role exists. */
  async executeTool(
    binding: RunBinding,
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    this.#parameters(RunBindingSchema, binding);
    this.#requireRun(binding);
    const tool = hisyoTools.find((candidate) => candidate.name === name);
    if (!tool || !Check(tool.args, args))
      throw new RpcError(-32602, "Invalid game tool or arguments");
    const input = args as Record<string, unknown>;
    const params = { ...binding, ...input };
    switch (tool.method) {
      case "game.state.get":
        return this.#forward(
          tool.method,
          this.#parameters(GameStateRequestSchema, params),
          GameStateResultSchema,
          signal,
        );
      case "game.message.send": {
        const request = this.#parameters(SendMessageSchema, params);
        if (!request.text.trim()) throw new RpcError(-32602, "AI message is blank");
        return this.#forward(tool.method, request, SendMessageResultSchema, signal);
      }
      case "hisyo.hooks.add": {
        const request = this.#parameters(HookAddSchema, params);
        const scope = this.#requireRun(request);
        this.#requireEvent(request.event);
        const { event, filter, instruction } = request;
        if (!instruction.trim()) throw new RpcError(-32602, "Hook instruction is blank");
        this.#options.hooks.catalog.validateFilter(event, filter ?? {});
        const hookInput =
          filter === undefined ? { event, instruction } : { event, filter, instruction };
        return this.#storage(() =>
          this.#options.activityLog.atomic(() => {
            const hook = this.#options.hooks.add(scope, hookInput);
            this.#options.activityLog.appendActivity(
              activity(request, "hisyo.hook_added", {
                runId: request.runId,
                hookId: hook.id,
                event: hook.event,
                filter: hook.filter,
                instruction: hook.instruction,
              }),
            );
            return hook;
          }),
        );
      }
      case "hisyo.hooks.remove": {
        const request = this.#parameters(HookRemoveSchema, params);
        const scope = this.#requireRun(request);
        return this.#storage(() =>
          this.#options.activityLog.atomic(() => {
            const removed = this.#options.hooks.remove(scope, request.id);
            if (removed)
              this.#options.activityLog.appendActivity(
                activity(request, "hisyo.hook_removed", {
                  runId: request.runId,
                  hookId: request.id,
                }),
              );
            return { removed };
          }),
        );
      }
      case "hisyo.hooks.list": {
        const request = this.#parameters(HookListRequestSchema, { ...binding, query: input });
        const scope = this.#requireRun(request);
        return this.#storage(() => this.#options.hooks.list(scope, request.query));
      }
      case "hisyo.events.search": {
        const request = this.#parameters(EventSearchRequestSchema, params);
        const scope = this.#requireRun(request);
        const { event, filter } = request.query;
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
        return this.#storage(() => log.search(scope, request.query));
      }
      case "hisyo.events.list":
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
      default: {
        const reference = referenceTools.find((candidate) => candidate.method === tool.method);
        if (!reference) throw new Error("Unknown game tool implementation");
        return this.#forward(
          reference.method,
          this.#parameters(reference.request, params),
          reference.result,
          signal,
        );
      }
    }
  }

  /** Completion means the owner has retained the input, not merely scheduled a later write. */
  handlePlayerMessages(accept: PlayerMessageHandler): () => void {
    if (this.#closing) throw new Error("Bridge closed");
    if (this.#playerMessageIntake) throw new Error("Player-message intake already registered");
    const intake = { accept };
    this.#playerMessageIntake = intake;
    return () => {
      if (this.#playerMessageIntake === intake) this.#playerMessageIntake = undefined;
    };
  }

  /** Persisted observations enter the scheduler once; the observation event is diagnostic only. */
  handleObservations(accept: ObservationHandler): () => void {
    if (this.#closing) throw new Error("Bridge closed");
    if (this.#observationIntake) throw new Error("Observation intake already registered");
    const intake = { accept };
    this.#observationIntake = intake;
    return () => {
      if (this.#observationIntake === intake) this.#observationIntake = undefined;
    };
  }

  close(): Promise<void> {
    return (this.#shutdown ??= this.#close());
  }

  async #close(): Promise<void> {
    this.#closing = true;
    this.#resolveAvailability();
    this.#playerMessageIntake = undefined;
    this.#observationIntake = undefined;
    if (this.#starting) await Promise.allSettled([this.#starting]);
    for (const connection of this.#connections)
      connection.peer.close(new Error("Bridge shutting down"));
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async beginRun(): Promise<RunBinding> {
    // Scheduler alone gates pause admission; previously admitted preparation may finish paused.
    if (this.#run) throw new Error("Previous run has not settled");
    const session = this.#session;
    const game = this.#game;
    if (this.#closing || this.#storageFailed || !session || !game?.ready)
      throw new Error("Game is not ready for run");
    const binding = Object.freeze({ ...session.binding, runId: randomUUID() });
    const run = { binding, valid: true, wake: () => {} };
    this.#run = run;
    try {
      // A native withdrawal creates uncertainty, not a fabricated pause fact.
      if (this.#availability?.game === game) {
        const available = this.#availability.promise;
        await new Promise<void>((resolve) => {
          run.wake = resolve;
          void available.then(resolve);
        });
      }
      this.#requireRun(binding);
      await this.#bind(game.peer, binding);
      this.#requireRun(binding);
      return binding;
    } catch (error) {
      if (this.#run === run) {
        this.invalidateRun("binding_failed");
        this.#run = undefined; // No model work was admitted for this failed binding.
      }
      throw error;
    }
  }

  finishRun(binding: RunBinding): boolean {
    const run = this.#run;
    if (!run || !sameRunBinding(run.binding, binding)) return false;
    if (run.valid) this.#clearGameRun(binding);
    this.finishModelRequest(binding, "run", binding.runId);
    this.#run = undefined;
    return true;
  }

  invalidateRun(reason: string): void {
    const run = this.#run;
    if (!run?.valid) return;
    run.valid = false;
    run.wake();
    this.#clearGameRun(run.binding);
    // Synchronous event delivery fences the host before a pending native stale rejection returns.
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

  async #bind(peer: RpcPeer, binding: RunBinding): Promise<void> {
    const result = await peer.call("game.run.bind", binding);
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
    if (!run?.valid || !sameRunBinding(run.binding, binding))
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
      if (this.#game) throw new RpcError(-32002, "Bridge role already connected");
      connection.role = params.role;
      this.#game = connection;
      clearTimeout(timer);
      return { protocolVersion, role: params.role };
    });
    this.#register(connection, "game.attach", GameAttachSchema, (params) => {
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
    this.#register(connection, "game.ready", SessionBindingSchema, (params) => {
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
    this.#register(connection, "game.detach", SessionBindingSchema, (params) => {
      this.#requireSession(params);
      this.#detach();
      return { detached: true };
    });
    this.#register(connection, "game.status", GameStatusSchema, (params) => {
      const session = this.#requireSession(params);
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
    this.#register(connection, "game.events", GameEventsSchema, async (params) => {
      const results = this.#storeEvents(params.events);
      const intake = this.#observationIntake;
      for (const { stored, hooks } of results) {
        await intake?.accept(stored, hooks);
        this.emit("observation", stored, hooks);
      }
      return { stored: params.events.length };
    });
    this.#register(connection, "game.player_message", PlayerMessageSchema, async (params) => {
      const session = this.#requireSession(params);
      if (!params.text.trim()) throw new RpcError(-32602, "Player message is blank");
      const intake = this.#playerMessageIntake;
      if (this.#closing || !connection.ready || !intake)
        throw new RpcError(-32003, "Hisyo is not accepting player messages");
      this.#storage(() =>
        this.#options.activityLog.appendActivity(
          activity(session.binding, "hisyo.player_input", { text: params.text }),
        ),
      );
      await intake.accept(session.binding, params.text);
      return { accepted: true };
    });
  }

  #storeEvents(events: readonly GameEvent[]) {
    for (const event of events) {
      const session = this.#requireSession(event);
      if (!session.supportedEvents.includes(event.event))
        throw new RpcError(-32602, "Unadvertised event");
    }
    return this.#storage(() => {
      const storedEvents = this.#options.eventLog.atomic(() =>
        events.map((event) => this.#options.eventLog.append(event)),
      );
      // Independent databases: raw observations remain durable if later activity/admission fails.
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
  }

  #parameters<T extends TSchema>(schema: T, params: unknown): Static<T> {
    if (!Check(schema, params)) throw new RpcError(-32602, "Invalid method parameters");
    return params;
  }

  #register<T extends TSchema>(
    connection: Connection,
    method: string,
    schema: T,
    handler: (params: Static<T>) => unknown,
  ): void {
    connection.peer.handle(method, (params) => {
      if (connection.role !== "game")
        throw new RpcError(-32010, "Unauthenticated or forbidden bridge role");
      if (
        this.#closing ||
        this.#storageFailed ||
        connection.peer.isClosed ||
        this.#game !== connection
      )
        throw new RpcError(-32003, "Bridge connection is inactive");
      return handler(this.#parameters(schema, params));
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
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const { worldId, playerId, sessionId, runId } = params;
    const binding = { worldId, playerId, sessionId, runId };
    this.#requireRun(binding);
    // Capture literal request data before awaiting; never retarget a delayed display fact.
    const captured = structuredClone(params);
    const game = this.#game!;
    const run = this.#run!;
    let result: unknown;
    try {
      result = await game.peer.call(method, captured);
    } catch (error) {
      // Only this authenticated native producer's current owned capture proves withdrawal.
      if (
        error instanceof RpcError &&
        error.code === -32001 &&
        error.data === undefined &&
        !this.#closing &&
        !this.#storageFailed &&
        this.#game === game &&
        this.#run === run &&
        !game.peer.isClosed &&
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
        this.#requireRun(binding);
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
    this.#requireRun(binding);
    signal?.throwIfAborted();
    return result;
  }
}
