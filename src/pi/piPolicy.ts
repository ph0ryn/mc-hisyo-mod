export const supportedPiVersion = "1.2.0";
export const directorToolNames = [
  "get_game_state",
  "send_message",
  "list_event_types",
  "get_recent_events",
  "add_response_hook",
  "remove_response_hook",
  "list_response_hooks",
] as const;
export const physicalModelApis: ReadonlySet<string> = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);
