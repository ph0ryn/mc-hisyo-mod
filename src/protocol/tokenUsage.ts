import { Type, type Static } from "typebox";
import { SessionBindingSchema } from "./bridge.js";

const count = Type.Union([
  Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  Type.Null(),
]);
export const TokenCountsSchema = Type.Object(
  {
    input: count,
    output: count,
    cacheRead: count,
    cacheWrite: count,
    total: count,
  },
  { additionalProperties: false },
);
export type TokenCounts = Static<typeof TokenCountsSchema>;

export const TokenUsageDataSchema = Type.Object(
  {
    source: Type.Union([Type.Literal("run"), Type.Literal("summary")]),
    requestId: Type.String({ minLength: 1, maxLength: 128 }),
    provider: Type.String({ minLength: 1, maxLength: 128 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    api: Type.Union([
      Type.Literal("openai-completions"),
      Type.Literal("openai-responses"),
      Type.Literal("anthropic-messages"),
    ]),
    stopReason: Type.Union([
      Type.Literal("stop"),
      Type.Literal("length"),
      Type.Literal("toolUse"),
      Type.Literal("error"),
      Type.Literal("aborted"),
      Type.Literal("pending"),
      Type.Literal("deferred"),
    ]),
    ...TokenCountsSchema.properties,
  },
  { additionalProperties: false },
);
export type TokenUsageData = Static<typeof TokenUsageDataSchema>;

export const TokenUsageRequestSchema = Type.Object(
  {
    ...SessionBindingSchema.properties,
    ...TokenUsageDataSchema.properties,
  },
  { additionalProperties: false },
);
export const TokenUsageResultSchema = Type.Object(
  { recorded: Type.Literal(true) },
  { additionalProperties: false },
);
