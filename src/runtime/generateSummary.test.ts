import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type AssistantMessage,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { expect, test, vi } from "vite-plus/test";
import { Check } from "typebox/value";
import { summaryInputBytes, summarySystemPrompt } from "../protocol/summary.js";
import { TokenUsageRequestSchema, type TokenUsageData } from "../protocol/tokenUsage.js";
import { generateSummary } from "./generateSummary.js";

const binding = { worldId: "world", playerId: "player", sessionId: "game-attachment" };
type Call = { context: TranscriptContext; options: SimpleStreamOptions | undefined };
function fixture(
  reply: (call: Call) => AssistantMessage | Promise<AssistantMessage> = () =>
    fauxAssistantMessage("木を集めた。"),
) {
  const provider = fauxProvider({
    api: "openai-responses",
    provider: "openai",
    models: [{ id: "gpt-6-luna" }],
  });
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider(provider.provider);
  const calls: Call[] = [];
  const respond = async (context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
    const call = { context: structuredClone(context), options };
    calls.push(call);
    const response = await reply(call);
    await options?.onProviderStreamEvent?.(
      {
        type: "response.completed",
        response: { usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } },
      },
      provider.getModel(),
    );
    return response;
  };
  provider.setResponses([respond, respond]);
  const usage: TokenUsageData[] = [];
  const bridge = {
    beginModelRequest: vi.fn(),
    recordUsage: vi.fn((data: unknown) => {
      if (!Check(TokenUsageRequestSchema, data)) throw new Error("Invalid usage payload");
      usage.push(data);
      return { recorded: true as const };
    }),
    finishModelRequest: vi.fn(() => true),
  };
  const options = { bridge, modelAccess: { models, model: provider.getModel() } };
  return {
    bridge,
    calls,
    usage,
    options,
    generate: (input = "events", signal = new AbortController().signal) =>
      generateSummary(options, binding, input, signal),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("each call is disposable, with only the summary instruction and current events", async () => {
  const f = fixture();
  await expect(f.generate("first events")).resolves.toBe("木を集めた。");
  await expect(f.generate("second events")).resolves.toBe("木を集めた。");
  expect(f.calls).toHaveLength(2);
  for (const [index, call] of f.calls.entries()) {
    expect(call.context.messages).toEqual([
      { role: "system", content: summarySystemPrompt, timestamp: 0 },
      {
        role: "user",
        content: index === 0 ? "first events" : "second events",
        timestamp: expect.any(Number),
      },
    ]);
    expect(call.options).toMatchObject({
      reasoningEffort: "low",
      serviceTier: "priority",
      maxTokens: 4096,
      cacheRetention: "none",
      maxRetries: 0,
    });
    expect(call.options).not.toHaveProperty("sessionId");
  }
  expect(f.usage).toHaveLength(2);
  expect(f.usage[0]).toMatchObject({
    ...binding,
    source: "summary",
    input: 7,
    output: 2,
    total: 9,
    cacheRead: null,
    cacheWrite: null,
  });
  expect(f.usage[0]!.requestId).not.toBe(f.usage[1]!.requestId);
  expect(f.bridge.finishModelRequest).toHaveBeenCalledTimes(2);
});

test("pre-cancelled, empty, and over-budget input never dispatch or claim usage ownership", async () => {
  const f = fixture();
  await expect(f.generate("events", AbortSignal.abort())).rejects.toMatchObject({
    name: "AbortError",
  });
  for (const input of [" ", "a".repeat(summaryInputBytes + 1)])
    await expect(f.generate(input)).rejects.toThrow("Invalid summary input");
  expect(f.calls).toEqual([]);
  expect(f.bridge.beginModelRequest).not.toHaveBeenCalled();
  expect(f.usage).toEqual([]);
});

test.each([
  fauxAssistantMessage("", { stopReason: "stop" }),
  fauxAssistantMessage("あ".repeat(401)),
  fauxAssistantMessage("partial", { stopReason: "length" }),
  fauxAssistantMessage("failed", { stopReason: "error" }),
  fauxAssistantMessage(
    [{ type: "toolCall", id: "uninvited", name: "send_message", arguments: { text: "no" } }],
    { stopReason: "toolUse" },
  ),
])("unusable completion is metered and released before rejection: %j", async (response) => {
  const f = fixture(() => response);
  await expect(f.generate()).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
  expect(f.usage).toHaveLength(1);
  expect(f.usage[0]).toMatchObject({
    source: "summary",
    input: 7,
    stopReason: response.stopReason,
  });
  expect(f.bridge.finishModelRequest).toHaveBeenCalledExactlyOnceWith(
    binding,
    "summary",
    f.usage[0]!.requestId,
  );
});

test("cancellation waits for late provider usage instead of releasing the request early", async () => {
  const entered = deferred();
  const release = deferred();
  let providerSignal!: AbortSignal;
  const f = fixture(async ({ options }) => {
    providerSignal = options!.signal!;
    entered.resolve();
    await release.promise;
    return fauxAssistantMessage("discarded", { stopReason: "aborted" });
  });
  const stop = new AbortController();
  const result = f.generate("events", stop.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await entered.promise;
  stop.abort();
  expect(providerSignal.aborted).toBe(true);
  expect(f.bridge.finishModelRequest).not.toHaveBeenCalled();
  expect(f.usage).toEqual([]);
  release.resolve();
  await rejected;
  expect(f.usage).toHaveLength(1);
  expect(f.usage[0]).toMatchObject({ ...binding, input: 7, stopReason: "aborted" });
  expect(f.bridge.finishModelRequest).toHaveBeenCalledOnce();
});

test("usage failure remains fatal but always releases request ownership", async () => {
  const f = fixture();
  const failure = new Error("usage storage failed");
  f.bridge.recordUsage.mockImplementationOnce(() => {
    throw failure;
  });
  await expect(f.generate()).rejects.toBe(failure);
  expect(f.bridge.finishModelRequest).toHaveBeenCalledOnce();
});

test("provider response model is preserved in metering", async () => {
  const f = fixture(() => ({ ...fauxAssistantMessage("done"), responseModel: "served-model" }));
  await f.generate();
  expect(f.usage[0]!.model).toBe("served-model");
});
