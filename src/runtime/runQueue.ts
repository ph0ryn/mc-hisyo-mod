import type { StoredEvent } from "../storage/eventLog.js";
import type { Hook } from "../storage/hookStore.js";
import { sameSessionBinding, type SessionBinding } from "../protocol/bridge.js";
import { isAdvancementUnlock } from "../protocol/gameEvent.js";

export interface RunRequest {
  binding: SessionBinding;
  initial: boolean;
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

export class RunQueueFullError extends Error {
  constructor(maxBytes: number) {
    super(`Run queue exceeded its ${maxBytes}-byte budget; scheduling must stop`);
    this.name = "RunQueueFullError";
  }
}

/** Pure bounded coalescing; RunInbox persists snapshots without rematching historical events. */
export class RunQueue {
  readonly #binding: SessionBinding;
  readonly #maxBytes: number;
  #pending: RunRequest;
  #failure: RunQueueFullError | undefined;

  constructor(binding: SessionBinding, maxBytes = 1024 * 1024, restored?: RunRequest) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error("Invalid run queue byte budget");
    this.#binding = structuredClone(binding);
    this.#maxBytes = maxBytes;
    if (
      restored &&
      (restored.binding.worldId !== binding.worldId ||
        restored.binding.playerId !== binding.playerId)
    )
      throw new Error("Run queue belongs to another world or player");
    // Reconnect changes execution authorization, never the source identity of observations.
    this.#pending = restored
      ? { ...structuredClone(restored), binding: structuredClone(binding) }
      : this.#empty();
    if (Buffer.byteLength(JSON.stringify(this.#pending), "utf8") > this.#maxBytes)
      throw new RunQueueFullError(this.#maxBytes);
  }

  snapshot(): RunRequest {
    this.#healthy();
    return structuredClone(this.#pending);
  }

  enqueueStart(): void {
    this.#update((batch) => {
      batch.initial = true;
    });
  }

  enqueuePoll(): void {
    this.#update((batch) => {
      batch.poll = true;
    });
  }

  cancelPoll(): void {
    this.#update((batch) => {
      batch.poll = false;
    });
  }

  enqueueMessage(binding: SessionBinding, text: string): void {
    this.#requireBinding(binding);
    this.#update((batch) => {
      batch.playerMessages.push(text);
    });
  }

  enqueueObservation(stored: StoredEvent, hooks: readonly Hook[]): void {
    this.#requireBinding(stored.observation);
    if (hooks.length === 0 && !isAdvancementUnlock(stored.observation)) return;
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

  take(): RunRequest | undefined {
    this.#healthy();
    const batch = this.#pending;
    if (!batch.initial && !batch.poll && !batch.playerMessages.length && !batch.observations.length)
      return undefined;
    this.#pending = this.#empty();
    return batch;
  }

  #empty(): RunRequest {
    return {
      binding: structuredClone(this.#binding),
      initial: false,
      poll: false,
      playerMessages: [],
      hooks: [],
      observations: [],
    };
  }

  #healthy(): void {
    if (this.#failure) throw this.#failure;
  }

  #requireBinding(binding: SessionBinding): void {
    this.#healthy();
    if (!sameSessionBinding(this.#binding, binding))
      throw new Error("Inactive or stale run queue binding");
  }

  #update(update: (batch: RunRequest) => void): void {
    this.#healthy();
    const candidate = structuredClone(this.#pending);
    update(candidate);
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > this.#maxBytes) {
      this.#failure = new RunQueueFullError(this.#maxBytes);
      throw this.#failure;
    }
    this.#pending = candidate;
  }
}
