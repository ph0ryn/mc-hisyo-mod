import { hasApi } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import type { SessionBinding } from "../protocol/bridge.js";
import {
  summaryInputBytes,
  summarySystemPrompt,
  validateSummaryText,
} from "../protocol/summary.js";
import type { ModelAccess } from "./modelAccess.js";
import { trackModelRequest, type ModelRequestBridge } from "./trackModelRequest.js";

interface SummaryOptions {
  modelAccess: Pick<ModelAccess, "models" | "model">;
  bridge: ModelRequestBridge;
}

/** One tool-free API call: no conversation, persisted session, or Durable storage. */
export async function generateSummary(
  { modelAccess, bridge }: SummaryOptions,
  binding: SessionBinding,
  input: string,
  signal: AbortSignal,
): Promise<string> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
  signal.throwIfAborted();
  if (!input.trim() || Buffer.byteLength(input) > summaryInputBytes)
    throw new Error("Invalid summary input");
  const { model, models } = modelAccess;
  if (!hasApi(model, "openai-responses"))
    throw new Error("Summary requires the pinned Responses API");
  const response = await trackModelRequest(
    { bridge, binding, source: "summary", requestId: randomUUID(), model, signal },
    (observe) =>
      models.complete(
        model,
        {
          systemPrompt: summarySystemPrompt,
          messages: [{ role: "user", content: input, timestamp: Date.now() }],
        },
        {
          signal,
          reasoningEffort: "low",
          serviceTier: "priority",
          maxTokens: 4096,
          cacheRetention: "none",
          maxRetries: 0,
          onProviderStreamEvent: observe,
        },
      ),
  );
  signal.throwIfAborted();
  if (response.stopReason !== "stop") throw new Error("Summary model completion failed");
  const text = response.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  validateSummaryText(text);
  return text;
}
