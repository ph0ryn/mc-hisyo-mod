import { referenceTools, validReferenceResult } from "../protocol/gameReferences.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createServer, type AddressInfo, type Socket } from "node:net";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import type { EventLog, StoredEvent } from "../events/eventLog.js";
import {
  activity,
  directorActivityCatalog,
  displayedActivity,
  isDirectorActivity,
  judgmentActivities,
} from "../events/directorActivity.js";
import type { JudgmentBatch } from "../runtime/judgmentQueue.js";
import type { ResponseHook, ResponseHooks } from "../hooks/responseHooks.js";
import {
  EmptySchema,
  EventSearchRequestSchema,
  GameAttachSchema,
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
  WorldBindingSchema,
  protocolVersion,
  sameRunBinding,
  sameWorldBinding,
  type BridgeRole,
  type RunBinding,
  type WorldBinding,
} from "../protocol/bridge.js";
import { GameEventSchema } from "../protocol/gameEvent.js";
import { RpcError, RpcPeer } from "../transport/rpcPeer.js";

export interface AttachedWorld {
  binding: WorldBinding;
  supportedEvents: readonly string[];
  paused: boolean;
}
type PlayerMessageHandler = (binding: WorldBinding, text: string) => undefined;
interface Connection {
  peer: RpcPeer;
  role: BridgeRole | undefined;
  ready: boolean;
}
interface BridgeOptions {
  token: string;
  eventLog: EventLog;
  hooks: ResponseHooks;
  helloTimeoutMs?: number;
}

/** Owns authorization and binding, never model scheduling or Minecraft objects. */
export class DirectorBridge extends EventEmitter<{
  attach: [world: AttachedWorld];
  detach: [binding: WorldBinding];
  status: [world: AttachedWorld];
  agentReady: [];
  runInvalidated: [binding: RunBinding, reason: string];
  observation: [stored: StoredEvent, hooks: ResponseHook[]];
  judgmentRequested: [batch: JudgmentBatch];
  peerClosed: [role: BridgeRole | undefined, reason: Error];
  fault: [error: Error];
}> {
  readonly #options: BridgeOptions;
  readonly #server = createServer((socket) => this.#accept(socket));
  readonly #connections = new Set<Connection>();
  #game: Connection | undefined;
  #agent: Connection | undefined;
  #world: AttachedWorld | undefined;
  #playerMessageIntake: { accept: PlayerMessageHandler } | undefined;
  // Invalidated runs still occupy the single-flight slot until the owner observes settled.
  #run: { binding: RunBinding; valid: boolean } | undefined;
  #closing = false;
  #starting: Promise<unknown[]> | undefined;
  #shutdown: Promise<void> | undefined;

  constructor(options: BridgeOptions) {
    super();
    if (!Check(HelloSchema.properties.token, options.token))
      throw new Error("Invalid bridge token");
    const timeout = options.helloTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("Invalid hello timeout");
    if (options.eventLog.db !== options.hooks.db)
      throw new Error("History and hooks must share one database");
    this.#options = options;
    this.on("judgmentRequested", (batch) => {
      this.#requireWorld(batch.binding);
      this.#storage(() => options.eventLog.appendActivities(judgmentActivities(batch)));
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

  get currentWorld(): AttachedWorld | undefined {
    return this.#world ? structuredClone(this.#world) : undefined;
  }

  get readyWorld(): AttachedWorld | undefined {
    return !this.#closing && this.#game?.ready ? this.currentWorld : undefined;
  }

  get isAgentReady(): boolean {
    return this.#agent?.ready === true;
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
    if (this.#run) throw new Error("Previous judgment has not settled");
    const world = this.#world;
    const game = this.#game;
    const agent = this.#agent;
    if (!world || world.paused || !game?.ready || !agent?.ready)
      throw new Error("Game and agent are not ready for judgment");
    const binding = Object.freeze({ ...world.binding, runId: randomUUID() });
    const run = { binding, valid: true };
    this.#run = run;
    try {
      await this.#bind(game.peer, "game.run.bind", binding);
      this.#requireRun(binding);
      await this.#bind(agent.peer, "director.run.bind", binding);
      this.#requireRun(binding);
      return binding;
    } catch (error) {
      if (this.#run === run) {
        this.invalidateRun("binding_failed");
        this.#run = undefined; // No prompt was sent, so there is no judgment to await.
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

  #requireWorld(binding: WorldBinding): AttachedWorld {
    if (!this.#world || !sameWorldBinding(this.#world.binding, binding))
      throw new RpcError(-32001, "Inactive or stale world binding");
    return this.#world;
  }

  #requireRun(binding: RunBinding): { worldId: string; playerId: string } {
    const world = this.#requireWorld(binding);
    if (!this.#run?.valid || !sameRunBinding(this.#run.binding, binding))
      throw new RpcError(-32001, "Inactive or stale execution binding");
    return { worldId: world.binding.worldId, playerId: world.binding.playerId };
  }

  #accept(socket: Socket): void {
    if (this.#closing) {
      socket.destroy();
      return;
    }
    const peer = new RpcPeer(socket);
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
        this.#game = undefined;
        this.#detach();
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
    this.#register(connection, "director.ready", "agent", EmptySchema, () => {
      if (connection.ready) throw new RpcError(-32002, "Agent already ready");
      connection.ready = true;
      this.emit("agentReady");
      return { ready: true };
    });
    this.#register(connection, "game.attach", "game", GameAttachSchema, (params) => {
      if (this.#world) throw new RpcError(-32002, "Detach the current world before attaching");
      for (const name of params.supportedEvents) this.#requireEvent(name);
      const binding = Object.freeze({
        worldId: params.worldId,
        playerId: params.playerId,
        worldSessionId: randomUUID(),
      });
      this.#world = {
        binding,
        supportedEvents: [...params.supportedEvents],
        paused: params.paused,
      };
      connection.ready = false;
      return binding;
    });
    this.#register(connection, "game.ready", "game", WorldBindingSchema, (params) => {
      this.#requireWorld(params);
      if (connection.ready) throw new RpcError(-32002, "Game already ready");
      connection.ready = true;
      this.emit("attach", this.currentWorld!);
      return { ready: true };
    });
    this.#register(connection, "game.detach", "game", WorldBindingSchema, (params) => {
      this.#requireWorld(params);
      this.#detach();
      return { detached: true };
    });
    this.#register(connection, "game.status", "game", GameStatusSchema, (params) => {
      const world = this.#requireWorld(params);
      world.paused = params.paused;
      if (params.paused) this.invalidateRun("paused");
      this.emit("status", this.currentWorld!);
      return { paused: params.paused };
    });
    this.#register(connection, "game.event", "game", GameEventSchema, (params) => {
      const world = this.#requireWorld(params);
      if (!world.supportedEvents.includes(params.event))
        throw new RpcError(-32602, "Unadvertised event");
      const stored = this.#storage(() => this.#options.eventLog.append(params));
      const hooks = this.#storage(() => this.#options.hooks.match(params));
      this.#storage(() =>
        this.#options.eventLog.appendActivities(
          hooks.map((hook) =>
            activity(world.binding, "director.hook_matched", {
              hookId: hook.id,
              sourceEventId: stored.id,
            }),
          ),
        ),
      );
      this.emit("observation", stored, hooks);
      return { stored: stored.id };
    });
    this.#register(connection, "game.player_message", "game", PlayerMessageSchema, (params) => {
      const world = this.#requireWorld(params);
      if (!params.text.trim()) throw new RpcError(-32602, "Player message is blank");
      if (this.#closing || !connection.ready || !this.#playerMessageIntake)
        throw new RpcError(-32003, "Director is not accepting player messages");
      this.#storage(() =>
        this.#options.eventLog.appendActivity(
          activity(world.binding, "director.player_input", { text: params.text }),
        ),
      );
      this.#playerMessageIntake.accept(world.binding, params.text);
      return { accepted: true };
    });
    this.#register(connection, "director.hooks.add", "agent", HookAddSchema, (params) => {
      const scope = this.#requireRun(params);
      this.#requireEvent(params.event);
      const { event, filter, instruction } = params;
      if (!instruction.trim()) throw new RpcError(-32602, "Hook instruction is blank");
      this.#options.hooks.catalog.validateFilter(event, filter ?? {});
      const input = filter === undefined ? { event, instruction } : { event, filter, instruction };
      return this.#storage(() =>
        this.#options.eventLog.atomic(() => {
          const hook = this.#options.hooks.add(scope, input);
          this.#options.eventLog.appendActivity(
            activity(params, "director.hook_added", {
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
    this.#register(connection, "director.hooks.remove", "agent", HookRemoveSchema, (params) => {
      const scope = this.#requireRun(params);
      return this.#storage(() =>
        this.#options.eventLog.atomic(() => {
          const removed = this.#options.hooks.remove(scope, params.id);
          if (removed)
            this.#options.eventLog.appendActivity(
              activity(params, "director.hook_removed", { runId: params.runId, hookId: params.id }),
            );
          return { removed };
        }),
      );
    });
    this.#register(connection, "director.hooks.list", "agent", HookListRequestSchema, (params) => {
      const scope = this.#requireRun(params);
      return this.#storage(() => this.#options.hooks.list(scope, params.query));
    });
    this.#register(
      connection,
      "director.events.get",
      "agent",
      EventSearchRequestSchema,
      (params) => {
        const scope = this.#requireRun(params);
        const { event, filter } = params.query;
        if (filter !== undefined && event === undefined)
          throw new RpcError(-32602, "A filter requires an event");
        if (event !== undefined)
          (isDirectorActivity(event)
            ? directorActivityCatalog
            : this.#options.eventLog.catalog
          ).validateFilter(event, filter ?? {});
        return this.#storage(() => this.#options.eventLog.search(scope, params.query));
      },
    );
    this.#register(connection, "director.events.list", "agent", RunBindingSchema, (params) => {
      this.#requireRun(params);
      return {
        events: [
          ...this.#options.eventLog.catalog
            .list()
            .filter((definition) => this.#world!.supportedEvents.includes(definition.name))
            .map((definition) => ({ ...definition, origin: "game", hookable: true })),
          ...directorActivityCatalog
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
      if (!Check(schema, params)) throw new RpcError(-32602, "Invalid method parameters");
      return handler(params);
    });
  }

  #requireEvent(name: string): void {
    if (isDirectorActivity(name))
      throw new RpcError(
        -32602,
        "Director activities are searchable only, not game hook capabilities",
      );
    if (
      !(
        this.#world?.supportedEvents ??
        this.#options.eventLog.catalog.list().map((definition) => definition.name)
      ).includes(name)
    )
      throw new RpcError(-32602, "Unsupported event capability");
  }

  #detach(): void {
    const world = this.#world;
    if (!world) return;
    this.#world = undefined;
    if (this.#game) this.#game.ready = false;
    this.invalidateRun("world_detached");
    this.emit("detach", world.binding);
  }

  #storage<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      this.invalidateRun("storage_failed");
      this.emit(
        "fault",
        error instanceof Error ? error : new Error("History storage failed", { cause: error }),
      );
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
    const result = await this.#game!.peer.call(method, captured);
    if (method !== "game.message.send") this.#requireRun(captured);
    if (
      !Check(schema, result) ||
      !sameRunBinding(result as RunBinding, captured) ||
      (method.startsWith("game.files.") &&
        !validReferenceResult({ method, result: schema }, result))
    )
      throw new RpcError(-32603, "Invalid game result or binding");
    if (method === "game.message.send")
      this.#storage(() =>
        this.#options.eventLog.appendActivity(displayedActivity(captured, result)),
      );
    this.#requireRun(captured);
    return result;
  }
}
