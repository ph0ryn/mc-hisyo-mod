import { EventEmitter } from "node:events";
import type { AttachedWorld, DirectorBridge } from "../bridge/directorBridge.js";
import { sameWorldBinding, type WorldBinding } from "../protocol/bridge.js";
import { ActivePlayClock } from "./activePlayClock.js";

export interface HistoryWorkerOptions {
  bridge: Pick<
    DirectorBridge,
    "on" | "off" | "readyWorld" | "isAgentReady" | "history" | "summarizeHistory"
  >;
  now?: () => number;
  wallNow?: () => number;
}

/** A separate elapsed-time cadence while attached, including pauses; judgments never reset it. */
export class HistoryWorker extends EventEmitter<{ fault: [error: Error] }> {
  readonly #bridge: HistoryWorkerOptions["bridge"];
  readonly #now: () => number;
  readonly #wallNow: () => number;
  #clock = new ActivePlayClock();
  #world: AttachedWorld | undefined;
  #epoch = 0;
  #failed = false;
  #closed = false;
  #flight: { controller: AbortController; promise: Promise<void> } | undefined;
  #shutdown: Promise<void> | undefined;

  constructor(options: HistoryWorkerOptions) {
    super();
    this.#bridge = options.bridge;
    this.#now = options.now ?? (() => performance.now());
    this.#wallNow = options.wallNow ?? Date.now;
    this.#bridge.on("attach", this.#attach);
    this.#bridge.on("detach", this.#detach);
    if (this.#bridge.readyWorld) this.#attach(this.#bridge.readyWorld);
  }

  readonly #attach = (world: AttachedWorld): void => {
    this.#invalidate();
    this.#world = world;
    this.#clock = new ActivePlayClock();
    this.#clock.setPlaying(true, this.#now());
  };
  readonly #detach = (binding: WorldBinding): void => {
    if (!this.#world || !sameWorldBinding(binding, this.#world.binding)) return;
    this.#invalidate();
    this.#world = undefined;
  };

  #invalidate(): void {
    this.#epoch++;
    this.#flight?.controller.abort();
  }

  poll(binding: WorldBinding): boolean {
    const world = this.#world;
    if (this.#closed || this.#failed || !world || !sameWorldBinding(binding, world.binding))
      return false;
    const due = this.#clock.poll(this.#now());
    if (!due || this.#flight || !this.#bridge.isAgentReady) return false;
    const scope = { worldId: binding.worldId, playerId: binding.playerId };
    const pending = this.#bridge.history.next(scope);
    if (!pending) return false;
    const { source } = pending;
    const epoch = this.#epoch;
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const summary = await this.#bridge.summarizeHistory(
          binding,
          source.input,
          controller.signal,
        );
        if (this.#closed || epoch !== this.#epoch || controller.signal.aborted) return;
        this.#bridge.history.save(scope, source, summary, this.#wallNow());
      } catch (error) {
        if (!this.#closed && epoch === this.#epoch && !controller.signal.aborted) {
          this.#failed = true;
          this.emit(
            "fault",
            error instanceof Error ? error : new Error("AI history summarization failed"),
          );
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
