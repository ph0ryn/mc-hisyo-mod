import { Type, type Static } from "typebox";
import { SessionBindingSchema, RunBindingSchema } from "./bridge.js";

// Pilot budgets, in UTF-8 bytes. Source rows remain available even when fields are abbreviated.
export const summaryPromptBytes = 12_000;
export const summaryTextBytes = 1_200;
export const summaryContextBytes = 6_000;
export const summarySystemPrompt = `These are Minecraft player event logs. Describe the main flow of activities during this period, the results and progress achieved, and any important changes, staying faithful to the facts.
The output is used to understand the broad course of activities, so precise coordinates are unnecessary. Preserve item, block, and other IDs exactly as they appear in the input.
Describe what happened; omit statements about what was not observed or recorded.`;
export const summaryInputBytes = summaryPromptBytes - Buffer.byteLength(summarySystemPrompt);

const strict = { additionalProperties: false } as const;
export const SummaryRequestSchema = Type.Object(
  {
    ...SessionBindingSchema.properties,
    requestId: Type.String({ minLength: 1, maxLength: 128 }),
    input: Type.String({ minLength: 1, maxLength: summaryInputBytes }),
  },
  strict,
);
export type SummaryRequest = Static<typeof SummaryRequestSchema>;
export const SummaryResultSchema = Type.Object(
  {
    ...SessionBindingSchema.properties,
    requestId: SummaryRequestSchema.properties.requestId,
    summary: Type.String({ maxLength: summaryTextBytes }),
    cancelled: Type.Boolean(),
  },
  strict,
);
export const SummaryCancelSchema = Type.Object(
  {
    ...SessionBindingSchema.properties,
    requestId: SummaryRequestSchema.properties.requestId,
  },
  strict,
);
export const SummaryContextSchema = Type.Object(
  {
    ...RunBindingSchema.properties,
    text: Type.String({ maxLength: summaryContextBytes }),
  },
  strict,
);

export function validateSummaryText(text: string): void {
  if (
    !text.trim() ||
    Buffer.byteLength(text) > summaryTextBytes ||
    // eslint-disable-next-line no-control-regex -- Summary prose allows tabs/newlines, not control frames.
    /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text)
  )
    throw new Error("Invalid summary text");
}
