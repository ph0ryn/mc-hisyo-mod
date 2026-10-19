import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Conversation } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { expect, onTestFinished, test } from "vite-plus/test";
import { createPlanTool, LongTermPlan } from "./longTermPlan.js";

/** Exercise the real SDK mutation queue, not a mocked ToolExecutionApi or transaction. */
test("a queued plan mutation rechecks native binding before changing the document", async () => {
  const provider = fauxProvider({ models: [{ id: "plan-test" }] });
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "plan-call",
          name: "update_plan",
          arguments: {
            expectedRevision: 0,
            plan: {
              goal: { objective: "Build", reason: "Try building" },
              nextAction: null,
              preferences: [],
              constraints: [],
            },
          },
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let conversation: Conversation;
  let blocker: Promise<void> | undefined;
  let valid = true;
  let guardCalls = 0;
  const binding = { worldId: "world", playerId: "player", sessionId: "session", runId: "run" };
  const tool = createPlanTool((signal, captured) => {
    guardCalls++;
    signal?.throwIfAborted();
    if (!valid) throw new Error("Native run invalidated");
    if (!captured) {
      // The run is still valid at the first guard. Put real work ahead of the Tool's commit,
      // then invalidate the native capability while its mutation waits in the same SDK queue.
      blocker = conversation.commit(async () => {
        entered();
        await held;
      }, BACKGROUND_CONTEXT);
    }
    return binding;
  });
  const registry = createRegistry();
  registry.install({ name: "plan", tools: [tool] });
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  onTestFinished(async () => {
    release();
    await blocker;
    await harness.close(BACKGROUND_CONTEXT);
  });
  conversation = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "faux", modelId: "plan-test" } },
  });
  await conversation.commit(async (tx) => {
    await tx.doc(LongTermPlan, conversation.id);
  }, BACKGROUND_CONTEXT);

  const submission = await conversation.submit(
    { type: "input", content: "Set the plan" },
    BACKGROUND_CONTEXT,
  );
  try {
    await blocked;
    valid = false;
  } finally {
    release();
  }
  await submission.wait(BACKGROUND_CONTEXT);
  expect(guardCalls).toBe(2);
  expect(await harness.snapshot(LongTermPlan, conversation.id, BACKGROUND_CONTEXT)).toEqual({
    revision: 0,
    plan: { goal: null, nextAction: null, preferences: [], constraints: [] },
  });
  const context = await conversation.context(BACKGROUND_CONTEXT);
  expect(context.messages.findLast((entry) => entry.role === "toolResult")?.isError).toBe(true);
});
