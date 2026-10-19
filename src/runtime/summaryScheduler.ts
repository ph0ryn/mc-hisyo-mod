import { EventEmitter } from "node:events";
import type { AttachedSession, BridgeServer } from "../bridge/bridgeServer.js";
import { sameSessionBinding, type SessionBinding } from "../protocol/bridge.js";
import { ActivePlayClock } from "./activePlayClock.js";

export interface SummarySchedulerOptions {
  bridge: Pick<BridgeServer, "on" | "off" | "readySession" | "summaries">;
  /** A stateless model call using shared credentials, independent of Durable startup. */
  summarize: (binding: SessionBinding, input: string, signal: AbortSignal) => Promise<string>;
  now?: () => number;
  wallNow?: () => number;
}

/** A separate elapsed-time cadence while attached, including pauses; runs never reset it. */
export class SummaryScheduler extends EventEmitter<{ fault: [error: Error] }> {
  readonly #bridge: SummarySchedulerOptions["bridge"];
  readonly #summarize: SummarySchedulerOptions["summarize"];
  readonly #now: () => number;
  readonly #wallNow: () => number;
  #clock = new ActivePlayClock();
  #session: AttachedSession | undefined;
  #epoch = 0;
  #failed = false;
  #closed = false;
  #flight: { controller: AbortController; promise: Promise<void> } | undefined;
  #shutdown: Promise<void> | undefined;

  constructor(options: SummarySchedulerOptions) {
    super();
    this.#bridge = options.bridge;
    this.#summarize = options.summarize;
    this.#now = options.now ?? (() => performance.now());
    this.#wallNow = options.wallNow ?? Date.now;
    this.#bridge.on("attach", this.#attach);
    this.#bridge.on("detach", this.#detach);
    if (this.#bridge.readySession) this.#attach(this.#bridge.readySession);
  }

  readonly #attach = (session: AttachedSession): void => {
    this.#invalidate();
    this.#session = session;
    this.#clock = new ActivePlayClock();
    this.#clock.setPlaying(true, this.#now());
  };
  readonly #detach = (binding: SessionBinding): void => {
    if (!this.#session || !sameSessionBinding(binding, this.#session.binding)) return;
    this.#invalidate();
    this.#session = undefined;
  };

  #invalidate(): void {
    this.#epoch++;
    this.#flight?.controller.abort();
  }

  poll(binding: SessionBinding): boolean {
    const session = this.#session;
    if (this.#closed || this.#failed || !session || !sameSessionBinding(binding, session.binding))
      return false;
    const due = this.#clock.poll(this.#now());
    if (!due || this.#flight) return false;
    const scope = { worldId: binding.worldId, playerId: binding.playerId };
    const pending = this.#bridge.summaries.next(scope);
    if (!pending) return false;
    const { source } = pending;
    const epoch = this.#epoch;
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const summary = await this.#summarize(binding, source.input, controller.signal);
        if (this.#closed || epoch !== this.#epoch || controller.signal.aborted) return;
        this.#bridge.summaries.save(scope, source, summary, this.#wallNow());
      } catch (error) {
        if (!this.#closed && epoch === this.#epoch && !controller.signal.aborted) {
          this.#failed = true;
          this.emit("fault", error instanceof Error ? error : new Error("Summarization failed"));
        }
      } finally {
        this.#flight = undefined;
      }
    })();
    this.#flight = { controller, promise };
    return true;
  }

  close(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    const flight = this.#flight;
    this.#shutdown = Promise.resolve().then(() => flight?.promise);
    this.#closed = true;
    this.#invalidate();
    this.#bridge.off("attach", this.#attach);
    this.#bridge.off("detach", this.#detach);
    return this.#shutdown;
  }
}
