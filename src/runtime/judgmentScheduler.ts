import { EventEmitter } from "node:events";
import type { AttachedWorld } from "../bridge/directorBridge.js";
import type { StoredEvent } from "../events/eventLog.js";
import type { ResponseHook } from "../hooks/responseHooks.js";
import { sameWorldBinding, type WorldBinding } from "../protocol/bridge.js";
import { RpcError } from "../transport/rpcPeer.js";
import { ActivePlayClock } from "./activePlayClock.js";
import { JudgmentQueue, type JudgmentBatch } from "./judgmentQueue.js";
import { startPiSession, type PiSessionOptions } from "./piSession.js";

export interface JudgmentSchedulerOptions extends Omit<PiSessionOptions, "world"> {
  maxPendingBytes?: number;
  /** Monotonic milliseconds, shared by lifecycle changes and poll samples. */
  monotonicNow?: () => number;
}

type Session = Awaited<ReturnType<typeof startPiSession>>;
interface WorldJudgments {
  binding: WorldBinding;
  queue: JudgmentQueue;
  clock: ActivePlayClock;
  startup: Promise<void>;
  session?: Session;
  onFault?: (error: Error) => void;
  batch: JudgmentBatch | undefined;
  flight: Promise<void> | undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Director judgment failed", { cause: error });
}

/** Single world/session owner and synchronous intake; not yet activated by the CLI. */
export class JudgmentScheduler extends EventEmitter<{ fault: [error: Error] }> {
  readonly #options: JudgmentSchedulerOptions;
  readonly #now: () => number;
  readonly #releaseIntake: () => void;
  #world: WorldJudgments | undefined;
  // Includes startup and confirmed child termination of every retired context.
  #retirement: Promise<void> = Promise.resolve();
  #failure: Error | undefined;
  #closing = false;
  #shutdown: Promise<void> | undefined;

  constructor(options: JudgmentSchedulerOptions) {
    super();
    const budget = options.maxPendingBytes;
    if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0))
      throw new Error("Invalid judgment queue byte budget");
    this.#options = {
      ...options,
      connection: { ...options.connection },
      model: structuredClone(options.model),
      prefixArgs: [...(options.prefixArgs ?? [])],
    };
    this.#now = options.monotonicNow ?? (() => performance.now());
    const bridge = options.bridge;
    this.#releaseIntake = bridge.handlePlayerMessages(this.#message);
    bridge.on("attach", this.#attached);
    bridge.on("detach", this.#detached);
    bridge.on("status", this.#status);
    bridge.on("observation", this.#observation);
    bridge.on("fault", this.#fail);
    // Let the caller subscribe to startup faults, including an undersized initial batch.
    queueMicrotask(() => {
      const world = bridge.readyWorld;
      if (world) this.#attached(world);
    });
  }

  #current(world: WorldJudgments): boolean {
    const ready = this.#options.bridge.readyWorld;
    return (
      !this.#closing &&
      !this.#failure &&
      this.#world === world &&
      ready !== undefined &&
      sameWorldBinding(ready.binding, world.binding)
    );
  }

  readonly #attached = (attached: AttachedWorld) => {
    if (this.#closing || this.#failure) return;
    if (this.#world && sameWorldBinding(this.#world.binding, attached.binding)) return;
    this.#retire();
    const world: WorldJudgments = {
      binding: { ...attached.binding },
      queue: new JudgmentQueue(attached.binding, this.#options.maxPendingBytes),
      clock: new ActivePlayClock(),
      // Even admission failure must retain the predecessor's pending termination.
      startup: this.#retirement,
      batch: undefined,
      flight: undefined,
    };
    this.#world = world;
    try {
      world.clock.setPlaying(!attached.paused, this.#now());
      world.queue.enqueueStart();
    } catch (error) {
      this.#fail(asError(error));
      return;
    }
    world.startup = this.#retirement.then(() => this.#start(world));
    // Keep rejection for close()/replacement; observing it must not make it recoverable.
    void world.startup.catch((error: unknown) => this.#fail(asError(error)));
  };

  async #start(world: WorldJudgments): Promise<void> {
    if (!this.#current(world)) return;
    try {
      world.session = await startPiSession({ ...this.#options, world: world.binding });
      world.onFault = (error) => {
        if (this.#world === world) this.#fail(error);
      };
      world.session.on("fault", world.onFault);
      // A retired startup is closed by its retirement chain, never retargeted.
      if (this.#current(world)) this.#pump(world);
    } catch (error) {
      // The factory normally rejects only after cleanup. AggregateError means cleanup
      // failed too: preserve that rejection so no replacement can acquire ownership.
      if (error instanceof AggregateError) throw error;
      if (this.#world === world) this.#fail(asError(error));
    }
  }

  readonly #detached = (binding: WorldBinding) => {
    if (this.#world && sameWorldBinding(this.#world.binding, binding)) this.#retire();
  };

  readonly #status = (attached: AttachedWorld) => {
    const world = this.#world;
    if (!world || !this.#current(world) || !sameWorldBinding(world.binding, attached.binding))
      return;
    try {
      world.clock.setPlaying(!attached.paused, this.#now());
      this.#pump(world);
    } catch (error) {
      this.#fail(asError(error));
    }
  };

  /** Runtime sampling inlet; false means no reservation, not a new timer or retry. */
  poll(binding: WorldBinding): boolean {
    const world = this.#world;
    if (
      !world ||
      !this.#current(world) ||
      !sameWorldBinding(world.binding, binding) ||
      this.#options.bridge.readyWorld!.paused
    )
      return false;
    try {
      if (!world.clock.poll(this.#now())) return false;
      // Reuse the single pending flag without displacing player or hook reasons.
      world.queue.enqueuePoll();
      this.#pump(world);
      return true;
    } catch (error) {
      this.#fail(asError(error));
      return false;
    }
  }

  readonly #message = (binding: WorldBinding, text: string): undefined => {
    if (this.#failure) throw new RpcError(-32004, this.#failure.message);
    const world = this.#world;
    if (!world || !this.#current(world) || !sameWorldBinding(world.binding, binding))
      throw new RpcError(-32003, "Director is not accepting player messages");
    try {
      world.queue.enqueueMessage(binding, text);
    } catch (error) {
      const failure = asError(error);
      this.#fail(failure);
      throw new RpcError(-32004, failure.message);
    }
    this.#pump(world);
    return undefined;
  };

  readonly #observation = (stored: StoredEvent, hooks: ResponseHook[]) => {
    const world = this.#world;
    if (!world || !this.#current(world)) return;
    try {
      world.queue.enqueueObservation(stored, hooks);
      this.#pump(world);
    } catch (error) {
      // Storage already succeeded. Report scheduling failure without denying that ACK.
      this.#fail(asError(error));
    }
  };

  #pump(world: WorldJudgments): void {
    if (
      !this.#current(world) ||
      this.#options.bridge.readyWorld!.paused ||
      !world.session ||
      world.flight
    )
      return;
    try {
      world.batch ??= world.queue.take();
      if (!world.batch) return;
      // Synchronous durable reasons before the attempt; not evidence a provider ran.
      this.#options.bridge.emit("judgmentRequested", world.batch);
      world.flight = world.session
        .judge(JSON.stringify(world.batch))
        .then((result) => {
          // not_started still owns this exact batch; started + settled consumes it,
          // including an aborted judgment. Incoming reasons remain in the pending queue.
          if (result.status === "settled") {
            if (world.batch!.hooks.length && this.#current(world)) {
              world.clock.restart(this.#now());
              world.queue.cancelPoll();
            }
            world.batch = undefined;
          }
        })
        .catch((error: unknown) => {
          if (this.#world === world) this.#fail(asError(error));
        })
        .finally(() => {
          world.flight = undefined;
          // Unpause may have arrived while settlement still occupied the slot.
          this.#pump(world);
        });
    } catch (error) {
      this.#fail(asError(error));
    }
  }

  #retire(): void {
    const world = this.#world;
    if (!world) return;
    this.#world = undefined;
    // Publish the chain before close() invalidates and invokes synchronous callbacks.
    this.#retirement = world.startup.then(async () => {
      await world.session?.close();
      if (world.onFault) world.session?.off("fault", world.onFault);
    });
    void this.#retirement.catch((error: unknown) => this.#fail(asError(error)));
    // Startup may not have returned an owner yet. In that case the chain waits for
    // the existing bounded factory/cleanup; it cannot launch a replacement early.
    void world.session?.close().catch(() => {});
  }

  readonly #fail = (error: Error) => {
    if (this.#failure || this.#closing) return;
    this.#failure = error;
    this.#retire();
    this.emit("fault", error);
  };

  close(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    // Publish before intake disposal or owner invalidation can reenter close().
    this.#shutdown = Promise.resolve().then(() => this.#retirement);
    this.#closing = true;
    this.#releaseIntake();
    const bridge = this.#options.bridge;
    bridge.off("attach", this.#attached);
    bridge.off("detach", this.#detached);
    bridge.off("status", this.#status);
    bridge.off("observation", this.#observation);
    bridge.off("fault", this.#fail);
    this.#retire();
    return this.#shutdown;
  }
}
