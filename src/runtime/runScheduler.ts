import { EventEmitter } from "node:events";
import type { Conversation } from "@earendil-works/pi-durable";
import type { AttachedSession } from "../bridge/bridgeServer.js";
import type { StoredEvent } from "../storage/eventLog.js";
import type { Hook } from "../storage/hookStore.js";
import { sameSessionBinding, type SessionBinding } from "../protocol/bridge.js";
import { RpcError } from "../transport/rpcPeer.js";
import { ActivePlayClock } from "./activePlayClock.js";
import { startDurableAgent, type DurableAgentOptions } from "./durableAgent.js";
import { RunInbox } from "./runInbox.js";
import { type RunQueue } from "./runQueue.js";

export interface RunAgent {
  readonly conversation: Conversation;
  run(
    message: string,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<{ status: "not_started" } | { status: "settled"; aborted: boolean }>;
  summarize(input: string, signal: AbortSignal): Promise<string>;
  abort(): Promise<void>;
  close(): Promise<void>;
  on(event: "fault", handler: (error: Error) => void): unknown;
  off(event: "fault", handler: (error: Error) => void): unknown;
}

export interface RunSchedulerOptions extends Omit<DurableAgentOptions, "session"> {
  maxPendingBytes?: number;
  monotonicNow?: () => number;
  /** Runtime dependency boundary; production always uses the bundled SDK owner. */
  startAgent?: (options: DurableAgentOptions) => Promise<RunAgent>;
}

interface SessionRuns {
  binding: SessionBinding;
  clock: ActivePlayClock;
  startup: Promise<void>;
  intake: Promise<void>;
  agent?: RunAgent;
  inbox?: RunInbox;
  onFault?: (error: Error) => void;
  flight: Promise<void> | undefined;
  pumpAgain: boolean;
}

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error("Hisyo run failed", { cause: error });

/** Owns game admission; Durable owns execution and the persisted pending/dispatch document. */
export class RunScheduler extends EventEmitter<{ fault: [error: Error] }> {
  readonly #options: RunSchedulerOptions;
  readonly #now: () => number;
  readonly #releaseMessages: () => void;
  readonly #releaseObservations: () => void;
  #session: SessionRuns | undefined;
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
      modelAccess: {
        ...options.modelAccess,
        model: { ...options.modelAccess.model },
      },
    };
    this.#now = options.monotonicNow ?? (() => performance.now());
    const bridge = options.bridge;
    this.#releaseMessages = bridge.handlePlayerMessages(this.#message);
    this.#releaseObservations = bridge.handleObservations(this.#observation);
    bridge.on("attach", this.#attached);
    bridge.on("detach", this.#detached);
    bridge.on("status", this.#status);
    bridge.on("fault", this.#fail);
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
    this.#retire(true);
    const session: SessionRuns = {
      binding: { ...attached.binding },
      clock: new ActivePlayClock(),
      startup: this.#retirement,
      intake: Promise.resolve(),
      flight: undefined,
      pumpAgain: false,
    };
    this.#session = session;
    try {
      session.clock.setPlaying(!attached.paused, this.#now());
    } catch (error) {
      this.#fail(asError(error));
      return;
    }
    session.startup = this.#retirement.then(() => this.#start(session));
    void session.startup.catch((error: unknown) => this.#fail(asError(error)));
  };

  async #start(session: SessionRuns): Promise<void> {
    if (!this.#current(session)) return;
    const start = this.#options.startAgent ?? startDurableAgent;
    session.agent = await start({ ...this.#options, session: session.binding });
    session.onFault = (error) => {
      if (this.#session === session) this.#fail(error);
    };
    session.agent.on("fault", session.onFault);
    session.inbox = new RunInbox(
      session.agent.conversation,
      session.binding,
      this.#options.maxPendingBytes,
    );
    if (this.#current(session)) {
      await session.inbox.update((queue) => queue.enqueueStart());
      this.#pump(session);
    }
  }

  readonly #detached = (binding: SessionBinding) => {
    if (this.#session && sameSessionBinding(this.#session.binding, binding)) this.#retire(true);
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

  /** true queues one durable admission; a later storage failure is a fatal scheduler fault. */
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
      void this.#admit(session, (queue) => queue.enqueuePoll()).catch((error: unknown) =>
        this.#fail(asError(error)),
      );
      return true;
    } catch (error) {
      this.#fail(asError(error));
      return false;
    }
  }

  async summarize(binding: SessionBinding, input: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const session = this.#session;
    if (!session || !this.#current(session) || !sameSessionBinding(session.binding, binding))
      throw new Error("Summary runtime is not available");
    await session.startup;
    signal.throwIfAborted();
    if (!this.#current(session) || !session.agent)
      throw new Error("Summary runtime is not available");
    return session.agent.summarize(input, signal);
  }

  #admit(session: SessionRuns, change: (queue: RunQueue) => void): Promise<void> {
    const accepted = session.intake.then(async () => {
      await session.startup;
      if (!this.#current(session)) throw new RpcError(-32003, "Hisyo is not accepting input");
      await session.inbox!.update(change);
      this.#pump(session);
    });
    session.intake = accepted;
    return accepted;
  }

  readonly #message = (binding: SessionBinding, text: string): Promise<void> => {
    if (this.#failure) throw new RpcError(-32004, this.#failure.message);
    const session = this.#session;
    if (!session || !this.#current(session) || !sameSessionBinding(session.binding, binding))
      throw new RpcError(-32003, "Hisyo is not accepting player messages");
    const captured = { ...binding };
    return this.#admit(session, (queue) => queue.enqueueMessage(captured, text)).catch(
      (error: unknown) => {
        if (this.#current(session)) this.#fail(asError(error));
        if (this.#failure) throw new RpcError(-32004, "Hisyo input admission failed");
        throw error;
      },
    );
  };

  readonly #observation = (stored: StoredEvent, hooks: Hook[]): Promise<void> => {
    const session = this.#session;
    if (
      !session ||
      !this.#current(session) ||
      !sameSessionBinding(stored.observation, session.binding)
    )
      return Promise.resolve();
    const captured = structuredClone({ stored, hooks });
    return this.#admit(session, (queue) =>
      queue.enqueueObservation(captured.stored, captured.hooks),
    ).catch((error: unknown) => {
      // Raw observations are already stored. Their ACK is independent of run admission.
      if (this.#current(session)) this.#fail(asError(error));
    });
  };

  #pump(session: SessionRuns): void {
    if (!this.#current(session) || this.#options.bridge.readySession!.paused || !session.agent)
      return;
    if (session.flight) {
      session.pumpAgain = true;
      return;
    }
    session.pumpAgain = false;
    session.flight = this.#dispatch(session)
      .catch((error: unknown) => {
        if (this.#session === session) this.#fail(asError(error));
      })
      .finally(() => {
        session.flight = undefined;
        if (session.pumpAgain) this.#pump(session);
      });
  }

  async #dispatch(session: SessionRuns): Promise<void> {
    await session.intake;
    if (!this.#current(session) || this.#options.bridge.readySession!.paused) return;
    const dispatch = await session.inbox!.take();
    if (!dispatch || !this.#current(session) || this.#options.bridge.readySession!.paused) return;
    this.#options.bridge.emit("runRequested", dispatch.batch);
    const result = await session.agent!.run(
      JSON.stringify(dispatch.batch),
      undefined,
      dispatch.requestId,
    );
    if (result.status !== "settled" || !this.#current(session)) return;
    const resetPoll = dispatch.batch.hooks.length > 0;
    await session.inbox!.complete(dispatch.requestId, resetPoll);
    if (resetPoll) session.clock.restart(this.#now());
    session.pumpAgain = true;
  }

  #retire(withdraw: boolean): void {
    const session = this.#session;
    if (!session) return;
    this.#session = undefined;
    // close marks the owner suspended synchronously, before bridge invalidation can
    // be mistaken for an explicit conversation abort. Unacknowledged admissions
    // may reject; already acknowledged input is committed in the same storage.
    const suspended = withdraw ? undefined : session.agent?.close();
    this.#options.bridge.invalidateRun(withdraw ? "game_detached" : "runtime_closed");
    this.#retirement = session.startup.then(async () => {
      // Admissions that received an ACK are already committed; rejected admissions do not
      // prevent orderly close. Startup/owner close failures themselves remain observable.
      await session.intake.catch(() => {});
      if (withdraw) {
        await session.agent?.abort();
        await session.inbox?.clear();
      }
      await (suspended ?? session.agent?.close());
      await session.flight;
      if (session.onFault) session.agent?.off("fault", session.onFault);
    });
    void this.#retirement.catch((error: unknown) => this.#fail(asError(error)));
  }

  readonly #fail = (error: Error) => {
    if (this.#failure || this.#closing) return;
    this.#failure = error;
    this.#retire(false);
    this.emit("fault", error);
  };

  close(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#shutdown = Promise.resolve().then(() => this.#retirement);
    this.#closing = true;
    this.#releaseMessages();
    this.#releaseObservations();
    const bridge = this.#options.bridge;
    bridge.off("attach", this.#attached);
    bridge.off("detach", this.#detached);
    bridge.off("status", this.#status);
    bridge.off("fault", this.#fail);
    this.#retire(false);
    return this.#shutdown;
  }
}
