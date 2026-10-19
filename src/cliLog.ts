import { inspect } from "node:util";

function preview(value: unknown): string {
  const text =
    typeof value === "string"
      ? JSON.stringify(value).slice(1, -1)
      : inspect(value, { colors: false, depth: null, maxArrayLength: null, maxStringLength: null });
  return text.replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function describeLog(
  event: string,
  details: Record<string, unknown>,
): [string, Record<string, unknown>] {
  switch (event) {
    case "game.attached":
      return [
        "Game connected",
        {
          World: details.worldId,
          Player: details.playerId,
          Language: details.language,
          State: details.paused ? "Paused" : "Playing",
        },
      ];
    case "game.detached":
      return ["Game disconnected", { World: details.worldId, Player: details.playerId }];
    case "game.status":
      return [details.paused ? "Game paused" : "Game resumed", {}];
    case "run.requested":
      return [
        "Run requested",
        {
          "Initial run": details.initial ? "Yes" : undefined,
          "Periodic check": details.poll ? "Yes" : undefined,
          "Player messages":
            Array.isArray(details.playerMessages) && details.playerMessages.length
              ? details.playerMessages
              : undefined,
          Hooks: Array.isArray(details.hooks) && details.hooks.length ? details.hooks : undefined,
          Observations: details.observations,
        },
      ];
    case "run.invalidated":
      return [
        "Run cancellation requested",
        {
          Reason:
            typeof details.reason === "string"
              ? details.reason.replaceAll("_", " ")
              : details.reason,
        },
      ];
    case "durable.ready":
      return [`Durable ready (Model: ${preview(details.provider)}/${preview(details.model)})`, {}];
    case "durable.run_submitted":
      return ["Run accepted", {}];
    case "durable.run_settled":
      return [details.aborted ? "Run cancelled" : "Run finished", {}];
    case "tool_execution_start":
    case "tool_execution_end":
    case "tool_execution_error": {
      const result = details.result;
      const status =
        event === "tool_execution_start"
          ? "started"
          : event === "tool_execution_error"
            ? "failed"
            : "completed";
      return [
        `Tool ${status}: ${preview(details.toolName)}${typeof details.toolCallId === "string" ? ` (${preview(details.toolCallId)})` : ""}`,
        {
          Arguments: event === "tool_execution_start" ? details.args : undefined,
          Duration: typeof details.durationMs === "number" ? `${details.durationMs} ms` : undefined,
          Result:
            result && typeof result === "object" && "details" in result ? result.details : result,
        },
      ];
    }
    default:
      return [preview(event.replace(/[._]/g, " ")), details];
  }
}

/** Human-readable diagnostics only; model output and credentials never flow through this logger. */
export function writeCliLog(event: string, details: Record<string, unknown> = {}): void {
  const [title, fields] = describeLog(event, details);
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => `  ${preview(label)}: ${preview(value).replaceAll("\n", "\n  ")}`);
  const message = [title, ...lines].join("\n");
  // ponytail: 4,096-character console previews; add opt-in full logs if larger results need inspection.
  const summary = message.length > 4_096 ? `${message.slice(0, 4_096)}… [truncated]` : message;
  process.stderr.write(`[${new Date().toISOString()}] ${summary}\n`);
}
