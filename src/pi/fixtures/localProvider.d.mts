/// <reference types="node" />

import type { ServerResponse } from "node:http";

export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export function sendProviderResponse(
  response: ServerResponse,
  options: { api: ProviderApi; toolCalls?: ProviderToolCall[]; text?: string },
): void;
