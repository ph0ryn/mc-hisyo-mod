import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Conversation } from "@earendil-works/pi-durable";
import type { SessionBinding } from "../protocol/bridge.js";
import { RunQueue, type RunRequest } from "./runQueue.js";

const Inbox = defineDoc<{
  pending: string | null;
  dispatch: { requestId: string; prompt: string } | null;
}>({
  kind: "hisyo.run-inbox",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ pending: null, dispatch: null }),
});

export interface RunDispatch {
  requestId: string;
  batch: RunRequest;
}

/** Domain coalescing persisted with the conversation, separate from model task scheduling. */
export class RunInbox {
  constructor(
    readonly conversation: Conversation,
    readonly binding: SessionBinding,
    readonly maxBytes?: number,
  ) {}

  #queue(serialized: string | null): RunQueue {
    return new RunQueue(
      this.binding,
      this.maxBytes,
      serialized === null ? undefined : (JSON.parse(serialized) as RunRequest),
    );
  }

  async update(change: (queue: RunQueue) => void): Promise<void> {
    await this.conversation.commit(async (tx) => {
      const state = await tx.doc(Inbox, this.conversation.id);
      const queue = this.#queue(state.pending);
      change(queue);
      state.pending = JSON.stringify(queue.snapshot());
    }, BACKGROUND_CONTEXT);
  }

  async take(): Promise<RunDispatch | undefined> {
    return this.conversation.commit(async (tx) => {
      const state = await tx.doc(Inbox, this.conversation.id);
      if (!state.dispatch) {
        const queue = this.#queue(state.pending);
        const batch = queue.take();
        if (!batch) return;
        state.pending = JSON.stringify(queue.snapshot());
        state.dispatch = { requestId: randomUUID(), prompt: JSON.stringify(batch) };
      }
      // Never release a dispatch before submit is durably admitted. If the host dies in
      // between, the same requestId finds the original submission or admits it once.
      const batch = this.#queue(state.dispatch.prompt).snapshot();
      return { requestId: state.dispatch.requestId, batch };
    }, BACKGROUND_CONTEXT);
  }

  async complete(requestId: string, cancelPoll = false): Promise<void> {
    await this.conversation.commit(async (tx) => {
      const state = await tx.doc(Inbox, this.conversation.id);
      if (state.dispatch?.requestId !== requestId)
        throw new Error("Completing an unowned run dispatch");
      state.dispatch = null;
      if (cancelPoll) {
        const queue = this.#queue(state.pending);
        queue.cancelPoll();
        state.pending = JSON.stringify(queue.snapshot());
      }
    }, BACKGROUND_CONTEXT);
  }

  /** Explicit game detach withdraws reasons; closing the host does not call this. */
  async clear(): Promise<void> {
    await this.conversation.commit(async (tx) => {
      const state = await tx.doc(Inbox, this.conversation.id);
      state.pending = null;
      state.dispatch = null;
    }, BACKGROUND_CONTEXT);
  }
}
