import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { BridgeServer } from "../bridge/bridgeServer.js";
import { TokenUsageTracker } from "../pi/tokenUsage.js";
import type { SessionBinding } from "../protocol/bridge.js";
import type { TokenUsageData } from "../protocol/tokenUsage.js";

export type ModelRequestBridge = Pick<
  BridgeServer,
  "beginModelRequest" | "recordUsage" | "finishModelRequest"
>;
interface ModelRequestOptions {
  bridge: ModelRequestBridge;
  binding: SessionBinding;
  source: "run" | "summary";
  requestId: string;
  model: Model<Api>;
  signal: AbortSignal | undefined;
}

/** Keep metering ownership until the provider settles, even when its result is discarded. */
export async function trackModelRequest(
  { bridge, binding, source, requestId, model, signal }: ModelRequestOptions,
  complete: (observe: (event: unknown) => void) => Promise<AssistantMessage>,
): Promise<AssistantMessage> {
  const usage = new TokenUsageTracker(model.api);
  bridge.beginModelRequest(binding, source, requestId);
  let response: AssistantMessage | undefined;
  try {
    response = await complete((event) => usage.observe(event));
    return response;
  } finally {
    try {
      // A RunBinding also carries runId; usage accepts only the SessionBinding fields.
      const { worldId, playerId, sessionId } = binding;
      bridge.recordUsage({
        worldId,
        playerId,
        sessionId,
        source,
        requestId,
        provider: model.provider,
        model: response?.responseModel ?? model.id,
        api: model.api as TokenUsageData["api"],
        stopReason: response?.stopReason ?? (signal?.aborted ? "aborted" : "error"),
        ...usage.counts,
      });
    } finally {
      bridge.finishModelRequest(binding, source, requestId);
    }
  }
}
