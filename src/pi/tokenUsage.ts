import type { TokenCounts } from "../protocol/tokenUsage.js";

function object(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid provider token usage object");
  return value as Record<string, unknown>;
}

/** Preserve provider field presence: Pi's normalized Usage silently defaults absent fields to 0. */
export class TokenUsageTracker {
  readonly counts: TokenCounts = {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    total: null,
  };

  constructor(readonly api: string) {}

  observe(event: unknown): void {
    const data = object(event);
    if (!data) return;
    if (this.api === "openai-completions") {
      const usage = object(data.usage);
      this.#copy(usage, {
        prompt_tokens: "input",
        completion_tokens: "output",
        total_tokens: "total",
      });
      this.#copy(object(usage?.prompt_tokens_details), {
        cached_tokens: "cacheRead",
        cache_write_tokens: "cacheWrite",
      });
    } else if (this.api === "openai-responses") {
      if (
        !["response.completed", "response.incomplete", "response.failed"].includes(
          String(data.type),
        )
      )
        return;
      const usage = object(object(data.response)?.usage);
      this.#copy(usage, { input_tokens: "input", output_tokens: "output", total_tokens: "total" });
      this.#copy(object(usage?.input_tokens_details), {
        cached_tokens: "cacheRead",
        cache_write_tokens: "cacheWrite",
      });
    } else if (this.api === "anthropic-messages") {
      const usage =
        data.type === "message_start"
          ? object(object(data.message)?.usage)
          : data.type === "message_delta"
            ? object(data.usage)
            : undefined;
      this.#copy(usage, {
        input_tokens: "input",
        output_tokens: "output",
        cache_read_input_tokens: "cacheRead",
        cache_creation_input_tokens: "cacheWrite",
      });
    } else throw new Error("Unsupported token usage API");
  }

  #copy(
    usage: Record<string, unknown> | undefined,
    fields: Record<string, keyof TokenCounts>,
  ): void {
    if (!usage) return;
    for (const [field, target] of Object.entries(fields)) {
      const value = usage[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        throw new Error("Invalid provider token count");
      // Streaming usage is cumulative, not an increment to add to the previous event.
      this.counts[target] = value;
    }
  }
}
