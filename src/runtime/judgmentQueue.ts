import type { StoredEvent } from "../events/eventLog.js";
import type { ResponseHook } from "../hooks/responseHooks.js";
import { sameWorldBinding, type WorldBinding } from "../protocol/bridge.js";

export interface JudgmentBatch {
  binding: WorldBinding;
  worldStart: boolean;
  poll: boolean;
  playerMessages: string[];
  hooks: Array<{
    id: string;
    event: string;
    instruction: string;
    eventIds: number[];
  }>;
  observations: StoredEvent[];
}

export class JudgmentQueueFullError extends Error {
  constructor(maxBytes: number) {
    super(`Judgment queue exceeded its ${maxBytes}-byte budget; scheduling must stop`);
    this.name = "JudgmentQueueFullError";
  }
}

/** One live binding's volatile pending reasons; never rematches historical events. */
export class JudgmentQueue {
  readonly #binding: WorldBinding;
  readonly #maxBytes: number;
  #pending: JudgmentBatch;
  #failure: JudgmentQueueFullError | undefined;

  constructor(binding: WorldBinding, maxBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error("Invalid judgment queue byte budget");
    this.#binding = structuredClone(binding);
    this.#maxBytes = maxBytes;
    this.#pending = this.#empty();
  }

  enqueueStart(): void {
    this.#update((batch) => {
      batch.worldStart = true;
    });
  }

  enqueuePoll(): void {
    this.#update((batch) => {
      batch.poll = true;
    });
  }

  enqueueMessage(binding: WorldBinding, text: string): void {
    this.#requireBinding(binding);
    this.#update((batch) => {
      batch.playerMessages.push(text);
    });
  }

  enqueueObservation(stored: StoredEvent, hooks: readonly ResponseHook[]): void {
    this.#requireBinding(stored.observation);
    if (hooks.length === 0) return;
    this.#update((batch) => {
      const captured = new Map(batch.hooks.map((hook) => [hook.id, hook]));
      for (const hook of hooks) {
        let pending = captured.get(hook.id);
        if (!pending) {
          // Hook IDs are immutable; deletion must not erase an already-fired instruction.
          pending = { id: hook.id, event: hook.event, instruction: hook.instruction, eventIds: [] };
          captured.set(hook.id, pending);
          batch.hooks.push(pending);
        }
        pending.eventIds.push(stored.id);
      }
      // Keep contents once, even when many hooks match this observation.
      batch.observations.push(structuredClone(stored));
    });
  }

  take(): JudgmentBatch | undefined {
    this.#healthy();
    const batch = this.#pending;
    if (!batch.worldStart && !batch.poll && !batch.playerMessages.length && !batch.hooks.length)
      return undefined;
    this.#pending = this.#empty();
    return batch;
  }

  #empty(): JudgmentBatch {
    return {
      binding: structuredClone(this.#binding),
      worldStart: false,
      poll: false,
      playerMessages: [],
      hooks: [],
      observations: [],
    };
  }

  #healthy(): void {
    if (this.#failure) throw this.#failure;
  }

  #requireBinding(binding: WorldBinding): void {
    this.#healthy();
    if (!sameWorldBinding(this.#binding, binding))
      throw new Error("Inactive or stale judgment queue binding");
  }

  #update(update: (batch: JudgmentBatch) => void): void {
    this.#healthy();
    const candidate = structuredClone(this.#pending);
    update(candidate);
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > this.#maxBytes) {
      this.#failure = new JudgmentQueueFullError(this.#maxBytes);
      throw this.#failure;
    }
    this.#pending = candidate;
  }
}
