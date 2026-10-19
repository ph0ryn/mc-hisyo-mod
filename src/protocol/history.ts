import { Type, type Static } from "typebox";
import { WorldBindingSchema, RunBindingSchema } from "./bridge.js";

// Pilot budgets, in UTF-8 bytes. Source rows remain available even when fields are abbreviated.
export const summaryPromptBytes = 12_000;
export const summaryTextBytes = 1_200;
export const historyContextBytes = 6_000;
export const summarySystemPrompt = `これはMinecraftのプレイヤーのイベントログです。その期間中の主な活動の流れと、得られた成果・進捗・重要な変化を、事実に忠実に文章化してください。
出力は行動履歴の大筋を把握するために使用されるため、厳密な座標は不要です。アイテム・ブロックなどのIDは入力のまま残してください。`;
export const summaryInputBytes = summaryPromptBytes - Buffer.byteLength(summarySystemPrompt);

const strict = { additionalProperties: false } as const;
export const HistorySummaryRequestSchema = Type.Object(
  {
    ...WorldBindingSchema.properties,
    requestId: Type.String({ minLength: 1, maxLength: 128 }),
    input: Type.String({ minLength: 1, maxLength: summaryInputBytes }),
  },
  strict,
);
export type HistorySummaryRequest = Static<typeof HistorySummaryRequestSchema>;
export const HistorySummaryResultSchema = Type.Object(
  {
    ...WorldBindingSchema.properties,
    requestId: HistorySummaryRequestSchema.properties.requestId,
    summary: Type.String({ maxLength: summaryTextBytes }),
    cancelled: Type.Boolean(),
  },
  strict,
);
export const HistoryCancelSchema = Type.Object(
  {
    ...WorldBindingSchema.properties,
    requestId: HistorySummaryRequestSchema.properties.requestId,
  },
  strict,
);
export const HistoryContextSchema = Type.Object(
  {
    ...RunBindingSchema.properties,
    text: Type.String({ maxLength: historyContextBytes }),
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
    throw new Error("Invalid history summary text");
}
