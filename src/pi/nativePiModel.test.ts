import { expect, test } from "vite-plus/test";
import {
  assertNativePiModel,
  checkNativePiModel,
  nativePiModelsConfig,
  type NativePiModelQuery,
} from "./nativePiModel.js";

const selector = { provider: "test-provider", id: "test-model" };
const credential = { ...selector, apiKey: "secret-must-not-appear" };
const nativeModel = {
  ...selector,
  type: "chat",
  api: "openai-completions",
  reasoning: true,
  thinkingLevelMap: { low: "low", medium: null, high: "high" },
  compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true },
};
const idleState = {
  model: nativeModel,
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  autoCompactionEnabled: false,
  pendingMessageCount: 0,
};

// Literal decoded RPC data over a query port, never a child/process emulator.
function replies(overrides: Partial<Record<NativePiModelQuery, unknown>> = {}) {
  const values: Record<NativePiModelQuery, unknown> = {
    get_available_models: { models: [nativeModel] },
    get_available_thinking_levels: { levels: ["off", "low", "medium", "high"] },
    get_state: idleState,
    ...overrides,
  };
  const calls: NativePiModelQuery[] = [];
  return {
    calls,
    query: async (command: NativePiModelQuery) => {
      calls.push(command);
      return values[command];
    },
  };
}
const commands: NativePiModelQuery[] = [
  "get_available_models",
  "get_available_thinking_levels",
  "get_state",
];

test("generates only the selected provider credential reference, not native model definitions", () => {
  const model = { ...credential };
  const before = structuredClone(model);
  const config = nativePiModelsConfig(model);
  expect(config).toEqual({
    providers: { "test-provider": { apiKey: "${MC_HISYO_MODEL_API_KEY}" } },
  });
  const json = JSON.stringify(config);
  expect(json).not.toContain(credential.apiKey);
  expect(json).not.toContain(selector.id);
  expect(json).not.toContain("thinkingLevelMap");
  expect(json).not.toContain("compat");
  expect(json).not.toContain("baseUrl");
  expect(model).toEqual(before);
});

test.each([
  { provider: "" },
  { id: "" },
  { apiKey: "" },
  { provider: undefined },
  { id: 3 },
  { apiKey: null },
  { id: "test-provider/colliding-id" },
])("rejects invalid native selector/key without reflecting inputs: %j", (override) => {
  const model = { ...credential, ...override } as typeof credential;
  expect(() => assertNativePiModel(model)).toThrow("Invalid trusted native Pi model configuration");
  expect(() => nativePiModelsConfig(model)).toThrow(
    "Invalid trusted native Pi model configuration",
  );
});

test.each(["openai-completions", "openai-responses", "anthropic-messages"])(
  "derives %s from the exact catalog selector and verifies medium plus idle state",
  async (api) => {
    const model = { ...nativeModel, api };
    const data = replies({
      get_available_models: {
        models: [{ ...model, provider: "other-provider" }, { ...model, id: "other-model" }, model],
      },
      get_state: { ...idleState, model },
    });
    const before = structuredClone(model);
    await expect(checkNativePiModel(selector, data.query, () => true)).resolves.toBe(api);
    expect(data.calls).toEqual(commands);
    expect(model).toEqual(before);
  },
);

test.each([
  undefined,
  { models: "invalid" },
  { models: [] },
  { models: [{ ...nativeModel, provider: "other" }] },
  { models: [{ ...nativeModel, id: "other" }] },
  { models: [nativeModel, nativeModel] },
  { models: [{ ...nativeModel, api: "virtual" }] },
  { models: [{ ...nativeModel, api: "openai-embeddings", type: "embedding" }] },
  { models: [{ provider: selector.provider, id: selector.id }] },
])(
  "rejects missing, ambiguous, malformed or nonphysical catalog without fallback: %j",
  async (value) => {
    const data = replies({ get_available_models: value });
    await expect(checkNativePiModel(selector, data.query, () => true)).rejects.toThrow(
      /Invalid Pi model catalog|Configured model is not an available physical API/,
    );
    expect(data.calls).toEqual([commands[0]]);
  },
);

test.each([undefined, { levels: [] }, { levels: ["low", "high"] }, { levels: [3] }])(
  "rejects unavailable medium instead of inferring it from reasoning metadata: %j",
  async (value) => {
    const data = replies({ get_available_thinking_levels: value });
    await expect(checkNativePiModel(selector, data.query, () => true)).rejects.toThrow(
      "Selected model does not support medium thinking",
    );
    expect(data.calls).toEqual(commands.slice(0, 2));
  },
);

test.each([
  undefined,
  { ...idleState, model: { ...nativeModel, provider: "other" } },
  { ...idleState, model: { ...nativeModel, id: "other" } },
  { ...idleState, model: { ...nativeModel, api: "openai-responses" } },
  { ...idleState, thinkingLevel: "low" },
  { ...idleState, isStreaming: true },
  { ...idleState, isCompacting: true },
  { ...idleState, autoCompactionEnabled: true },
  { ...idleState, pendingMessageCount: 1 },
])("rejects mismatched model/API/thinking or unsafe idle state: %j", async (value) => {
  const data = replies({ get_state: value });
  await expect(checkNativePiModel(selector, data.query, () => true)).rejects.toThrow(
    "Pi state does not match isolated model/thinking/queue policy",
  );
  expect(data.calls).toEqual(commands);
});

test("retains the pinned API at subsequent judgment gates", async () => {
  const first = replies();
  const pinned = await checkNativePiModel(selector, first.query, () => true);
  const second = replies();
  await expect(checkNativePiModel(selector, second.query, () => true, pinned)).resolves.toBe(
    pinned,
  );
  const changed = replies({
    get_available_models: { models: [{ ...nativeModel, api: "openai-responses" }] },
  });
  await expect(checkNativePiModel(selector, changed.query, () => true, pinned)).rejects.toThrow(
    "Configured model is not an available physical API",
  );
  expect(changed.calls).toEqual([commands[0]]);
});

test.each([0, 1, 2, 3])(
  "rechecks authentication/deadline before readiness after %i replies",
  async (count) => {
    const data = replies();
    const failure = new Error("Readiness invalidated");
    const checkpoint = () => {
      if (data.calls.length === count) throw failure;
      return true;
    };
    await expect(checkNativePiModel(selector, data.query, checkpoint)).rejects.toBe(failure);
    expect(data.calls).toEqual(commands.slice(0, count));
  },
);

test.each([0, 1, 2, 3])(
  "stops a cancelled gate without further queries after %i replies",
  async (count) => {
    const data = replies();
    await expect(
      checkNativePiModel(selector, data.query, () => data.calls.length !== count),
    ).resolves.toBeUndefined();
    expect(data.calls).toEqual(commands.slice(0, count));
  },
);

test("does not hide a query failure or issue later readiness queries", async () => {
  const failure = new Error("Pi RPC failed");
  await expect(
    checkNativePiModel(
      selector,
      async () => {
        throw failure;
      },
      () => true,
    ),
  ).rejects.toBe(failure);
});
