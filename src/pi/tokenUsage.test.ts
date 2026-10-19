import { expect, test } from "vite-plus/test";
import { TokenUsageTracker } from "./tokenUsage.js";

const unknown = { input: null, output: null, cacheRead: null, cacheWrite: null, total: null };

test("missing provider counters stay unknown, while explicitly reported zeros stay zero", () => {
  const tracker = new TokenUsageTracker("openai-completions");
  expect(tracker.counts).toEqual(unknown);
  tracker.observe({ usage: null });
  expect(tracker.counts).toEqual(unknown);
  tracker.observe({ usage: { prompt_tokens: 9 } });
  expect(tracker.counts).toEqual({ ...unknown, input: 9 });
  tracker.observe({
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  });
  expect(tracker.counts).toEqual({ ...unknown, input: 0, output: 0, cacheRead: 0, total: 0 });
});

test.each(["response.completed", "response.incomplete", "response.failed"])(
  "Responses %s preserves provider-native counts without adding cached tokens twice",
  (type) => {
    const tracker = new TokenUsageTracker("openai-responses");
    tracker.observe({
      type,
      response: {
        usage: {
          input_tokens: 140,
          output_tokens: 20,
          total_tokens: 160,
          input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
        },
      },
    });
    expect(tracker.counts).toEqual({
      input: 140,
      output: 20,
      cacheRead: 40,
      cacheWrite: 10,
      total: 160,
    });
  },
);

test("Anthropic cumulative deltas preserve known input and leave unreported totals unknown", () => {
  const tracker = new TokenUsageTracker("anthropic-messages");
  tracker.observe({
    type: "message_start",
    message: {
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 5,
      },
    },
  });
  tracker.observe({ type: "message_delta", usage: { output_tokens: 4 } });
  tracker.observe({ type: "message_delta", usage: { output_tokens: 8 } });
  expect(tracker.counts).toEqual({
    input: 10,
    output: 8,
    cacheRead: 30,
    cacheWrite: 5,
    total: null,
  });
});

test.each([
  { usage: "bad" },
  { usage: [] },
  { usage: { prompt_tokens_details: [] } },
  { usage: { prompt_tokens_details: 12 } },
])("malformed usage containers fail instead of becoming unknown: %j", (event) => {
  expect(() => new TokenUsageTracker("openai-completions").observe(event)).toThrow(
    "token usage object",
  );
});

test.each([-1, 1.5, "4", Number.MAX_SAFE_INTEGER + 1, Infinity])(
  "malformed provider token counts fail instead of becoming unknown: %s",
  (value) => {
    const tracker = new TokenUsageTracker("openai-responses");
    expect(() =>
      tracker.observe({ type: "response.completed", response: { usage: { input_tokens: value } } }),
    ).toThrow("token count");
  },
);
