import { EventEmitter } from "node:events";
import type { AttachedSession, BridgeServer } from "../bridge/bridgeServer.js";
import type { SummarySource } from "../events/summaryInput.js";
import { sameSessionBinding, type SessionBinding } from "../protocol/bridge.js";

export interface SummarySchedulerOptions {
  bridge: Pick<BridgeServer, "on" | "off" | "readySession" | "summaries">;
  /** A stateless model call using shared credentials, independent of Durable startup. */
  summarize: (binding: SessionBinding, input: string, signal: AbortSignal) => Promise<string>;
  wallNow?: () => number;
}

/** Drain the newest eligible minute first, including while main admission is paused. */
export class SummaryScheduler extends EventEmitter<{ fault: [error: Error] }> {
  readonly #bridge: SummarySchedulerOptions["bridge"];
  readonly #summarize: SummarySchedulerOptions["summarize"];
  readonly #wallNow: () => number;
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
    this.#wallNow = options.wallNow ?? Date.now;
    this.#bridge.on("attach", this.#attach);
    this.#bridge.on("detach", this.#detach);
    if (this.#bridge.readySession) this.#attach(this.#bridge.readySession);
  }

  readonly #attach = (session: AttachedSession): void => {
    this.#invalidate();
    this.#session = session;
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

  #current(binding: SessionBinding, epoch: number): boolean {
    const ready = this.#bridge.readySession;
    return (
      !this.#closed &&
      !this.#failed &&
      epoch === this.#epoch &&
      this.#session !== undefined &&
      sameSessionBinding(binding, this.#session.binding) &&
      ready !== undefined &&
      sameSessionBinding(binding, ready.binding)
    );
  }

  poll(binding: SessionBinding): boolean {
    const epoch = this.#epoch;
    if (this.#flight || !this.#current(binding, epoch)) return false;
    const scope = { worldId: binding.worldId, playerId: binding.playerId };
    const controller = new AbortController();
    let source: SummarySource | undefined;
    let selectionFailure: Error | undefined;
    // Publish the promise before selection or generation can synchronously reenter close/poll.
    const promise = Promise.resolve().then(async () => {
      try {
        if (selectionFailure) throw selectionFailure;
        while (source && this.#current(binding, epoch)) {
          const summary = await this.#summarize(binding, source.input, controller.signal);
          if (!this.#current(binding, epoch) || controller.signal.aborted) return;
          this.#bridge.summaries.save(scope, source, summary, this.#wallNow());
          if (!this.#current(binding, epoch)) return;
          source = this.#bridge.summaries.next(scope, this.#wallNow())?.source;
        }
      } catch (error) {
        if (!this.#closed && epoch === this.#epoch && !controller.signal.aborted) {
          this.#failed = true;
          this.emit("fault", error instanceof Error ? error : new Error("Summarization failed"));
        }
      } finally {
        this.#flight = undefined;
        // A replacement waits for old provider/usage settlement, then gets one fresh selection.
        if (epoch !== this.#epoch && this.#session) this.poll(this.#session.binding);
      }
    });
    this.#flight = { controller, promise };
    try {
      source = this.#bridge.summaries.next(scope, this.#wallNow())?.source;
    } catch (error) {
      selectionFailure = error instanceof Error ? error : new Error("Summarization failed");
    }
    return source !== undefined;
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
