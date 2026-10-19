import { EventEmitter } from "node:events";
import type { AttachedSession } from "../bridge/bridgeServer.js";
import type { StoredEvent } from "../storage/eventLog.js";
import type { Hook } from "../storage/hookStore.js";
import { sameSessionBinding, type SessionBinding } from "../protocol/bridge.js";
import { RpcError } from "../transport/rpcPeer.js";
import { ActivePlayClock } from "./activePlayClock.js";
import { RunQueue, type RunRequest } from "./runQueue.js";
import { startPiProcess, type PiProcessOptions } from "./piProcess.js";

export interface RunSchedulerOptions extends Omit<PiProcessOptions, "session"> {
  maxPendingBytes?: number;
  /** Monotonic milliseconds, shared by lifecycle changes and poll samples. */
  monotonicNow?: () => number;
}

type PiProcess = Awaited<ReturnType<typeof startPiProcess>>;
interface SessionRuns {
  binding: SessionBinding;
  queue: RunQueue;
  clock: ActivePlayClock;
  startup: Promise<void>;
  process?: PiProcess;
  onFault?: (error: Error) => void;
  batch: RunRequest | undefined;
  flight: Promise<void> | undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Hisyo run failed", { cause: error });
}

/** Owns runs and one Pi process for the current game session, with synchronous intake. */
export class RunScheduler extends EventEmitter<{ fault: [error: Error] }> {
  readonly #options: RunSchedulerOptions;
  readonly #now: () => number;
  readonly #releaseIntake: () => void;
  #session: SessionRuns | undefined;
  // Includes startup and confirmed child termination of every retired context.
  #retirement: Promise<void> = Promise.resolve();
  #failure: Error | undefined;
  #closing = false;
  #shutdown: Promise<void> | undefined;

  constructor(options: RunSchedulerOptions) {
    super();
    const budget = options.maxPendingBytes;
    if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0))
      throw new Error("Invalid run queue byte budget");
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
      const session = bridge.readySession;
      if (session) this.#attached(session);
    });
  }

  #current(session: SessionRuns): boolean {
    const ready = this.#options.bridge.readySession;
    return (
      !this.#closing &&
      !this.#failure &&
      this.#session === session &&
      ready !== undefined &&
      sameSessionBinding(ready.binding, session.binding)
    );
  }

  readonly #attached = (attached: AttachedSession) => {
    if (this.#closing || this.#failure) return;
    if (this.#session && sameSessionBinding(this.#session.binding, attached.binding)) return;
    this.#retire();
    const session: SessionRuns = {
      binding: { ...attached.binding },
      queue: new RunQueue(attached.binding, this.#options.maxPendingBytes),
      clock: new ActivePlayClock(),
      // Even admission failure must retain the predecessor's pending termination.
      startup: this.#retirement,
      batch: undefined,
      flight: undefined,
    };
    this.#session = session;
    try {
      session.clock.setPlaying(!attached.paused, this.#now());
      session.queue.enqueueStart();
    } catch (error) {
      this.#fail(asError(error));
      return;
    }
    session.startup = this.#retirement.then(() => this.#start(session));
    // Keep rejection for close()/replacement; observing it must not make it recoverable.
    void session.startup.catch((error: unknown) => this.#fail(asError(error)));
  };

  async #start(session: SessionRuns): Promise<void> {
    if (!this.#current(session)) return;
    try {
      session.process = await startPiProcess({ ...this.#options, session: session.binding });
      session.onFault = (error) => {
        if (this.#session === session) this.#fail(error);
      };
      session.process.on("fault", session.onFault);
      // A retired startup is closed by its retirement chain, never retargeted.
      if (this.#current(session)) this.#pump(session);
    } catch (error) {
      // The factory normally rejects only after cleanup. AggregateError means cleanup
      // failed too: preserve that rejection so no replacement can acquire ownership.
      if (error instanceof AggregateError) throw error;
      if (this.#session === session) this.#fail(asError(error));
    }
  }

  readonly #detached = (binding: SessionBinding) => {
    if (this.#session && sameSessionBinding(this.#session.binding, binding)) this.#retire();
  };

  readonly #status = (attached: AttachedSession) => {
    const session = this.#session;
    if (
      !session ||
      !this.#current(session) ||
      !sameSessionBinding(session.binding, attached.binding)
    )
      return;
    try {
      session.clock.setPlaying(!attached.paused, this.#now());
      this.#pump(session);
    } catch (error) {
      this.#fail(asError(error));
    }
  };

  /** Runtime sampling inlet; false means no reservation, not a new timer or retry. */
  poll(binding: SessionBinding): boolean {
    const session = this.#session;
    if (
      !session ||
      !this.#current(session) ||
      !sameSessionBinding(session.binding, binding) ||
      this.#options.bridge.readySession!.paused
    )
      return false;
    try {
      if (!session.clock.poll(this.#now())) return false;
      // Reuse the single pending flag without displacing player or hook reasons.
      session.queue.enqueuePoll();
      this.#pump(session);
      return true;
    } catch (error) {
      this.#fail(asError(error));
      return false;
    }
  }

  /** Independent summarization uses the current Pi owner, never main-run admission. */
  async summarize(binding: SessionBinding, input: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const session = this.#session;
    if (!session || !this.#current(session) || !sameSessionBinding(session.binding, binding))
      throw new Error("Summary process is not available");
    await session.startup;
    signal.throwIfAborted();
    if (!this.#current(session) || !session.process)
      throw new Error("Summary process is not available");
    return session.process.summarize(input, signal);
  }

  readonly #message = (binding: SessionBinding, text: string): undefined => {
    if (this.#failure) throw new RpcError(-32004, this.#failure.message);
    const session = this.#session;
    if (!session || !this.#current(session) || !sameSessionBinding(session.binding, binding))
      throw new RpcError(-32003, "Hisyo is not accepting player messages");
    try {
      session.queue.enqueueMessage(binding, text);
    } catch (error) {
      const failure = asError(error);
      this.#fail(failure);
      throw new RpcError(-32004, failure.message);
    }
    this.#pump(session);
    return undefined;
  };

  readonly #observation = (stored: StoredEvent, hooks: Hook[]) => {
    const session = this.#session;
    if (!session || !this.#current(session)) return;
    try {
      session.queue.enqueueObservation(stored, hooks);
      this.#pump(session);
    } catch (error) {
      // Storage already succeeded. Report scheduling failure without denying that ACK.
      this.#fail(asError(error));
    }
  };

  #pump(session: SessionRuns): void {
    if (
      !this.#current(session) ||
      this.#options.bridge.readySession!.paused ||
      !session.process ||
      session.flight
    )
      return;
    try {
      session.batch ??= session.queue.take();
      if (!session.batch) return;
      // Synchronous durable reasons before the attempt; not evidence a provider ran.
      this.#options.bridge.emit("runRequested", session.batch);
      session.flight = session.process
        .run(JSON.stringify(session.batch))
        .then((result) => {
          // not_started still owns this exact batch; started + settled consumes it,
          // including an aborted run. Incoming reasons remain in the pending queue.
          if (result.status === "settled") {
            if (session.batch!.hooks.length && this.#current(session)) {
              session.clock.restart(this.#now());
              session.queue.cancelPoll();
            }
            session.batch = undefined;
          }
        })
        .catch((error: unknown) => {
          if (this.#session === session) this.#fail(asError(error));
        })
        .finally(() => {
          session.flight = undefined;
          // Unpause may have arrived while settlement still occupied the slot.
          this.#pump(session);
        });
    } catch (error) {
      this.#fail(asError(error));
    }
  }

  #retire(): void {
    const session = this.#session;
    if (!session) return;
    this.#session = undefined;
    // Publish the chain before close() invalidates and invokes synchronous callbacks.
    this.#retirement = session.startup.then(async () => {
      await session.process?.close();
      if (session.onFault) session.process?.off("fault", session.onFault);
    });
    void this.#retirement.catch((error: unknown) => this.#fail(asError(error)));
    // Startup may not have returned an owner yet. In that case the chain waits for
    // the existing bounded factory/cleanup; it cannot launch a replacement early.
    void session.process?.close().catch(() => {});
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
