import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
  SendMessageResultSchema,
  SendMessageSchema,
  sameRunBinding,
  type SessionBinding,
} from "../protocol/bridge.js";
import {
  GameEventSchema,
  WorldScopeSchema,
  isAdvancementUnlock,
  type EventDefinition,
} from "../protocol/gameEvent.js";
import type { RunRequest } from "../runtime/runQueue.js";
import { EventCatalog, EventFilterSchema } from "./eventCatalog.js";

const strict = { additionalProperties: false } as const;
const identifier = GameEventSchema.properties.worldId;
const counter = GameEventSchema.properties.tick;
const text = Type.String({ minLength: 1, maxLength: 16_000 });
export const ActivitySchema = Type.Object(
  {
    ...WorldScopeSchema.properties,
    sessionId: identifier,
    origin: Type.Literal("cli"),
    recordedAt: counter,
    event: GameEventSchema.properties.event,
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  strict,
);
export type Activity = Static<typeof ActivitySchema>;

function definition(
  name: string,
  description: string,
  properties: Parameters<typeof Type.Object>[0],
  filterFields: string[],
  observation: EventDefinition["observation"] = "confirmed",
): EventDefinition {
  return {
    name: `hisyo.${name}`,
    description,
    observation,
    dataSchema: Type.Object(properties, strict),
    filterFields,
  };
}

export const activityCatalog = new EventCatalog([
  definition(
    "session_attached",
    "CLI accepted game.ready for this attachment, not a native JOIN or world start. Pre-ready/pre-attachment observations are unknown.",
    { beforeAttachment: Type.Literal("unknown") },
    ["beforeAttachment"],
  ),
  definition(
    "status_reported",
    "Validated game.status paused report for the current attachment; initial false is a baseline report, not a change. No inferred state between reports.",
    { paused: Type.Boolean() },
    ["paused"],
  ),
  definition(
    "session_detached",
    "CLI retired an active attachment, not proof of native LEAVE. The terminal tail after the last admitted observation and disconnected observations are unknown, not numbered sequence gaps.",
    {
      reason: Type.Union([
        Type.Literal("game_detached"),
        Type.Literal("link_closed"),
        Type.Literal("bridge_shutdown"),
      ]),
      afterLastObservation: Type.Literal("unknown"),
    },
    ["reason", "afterLastObservation"],
  ),
  definition(
    "player_input",
    "Valid /ai text received by the CLI; not proof of a model response.",
    { text },
    ["text"],
  ),
  definition(
    "hud_displayed",
    "Literal text acknowledged displayed by the local HUD, including a subsequently stale run.",
    { runId: identifier, text },
    ["runId", "text"],
  ),
  definition(
    "hook_added",
    "Hook registration committed together with this activity record.",
    {
      runId: identifier,
      hookId: identifier,
      event: identifier,
      filter: EventFilterSchema,
      instruction: text,
    },
    ["runId", "hookId", "event"],
  ),
  definition(
    "hook_removed",
    "An existing hook deletion committed together with this activity record.",
    { runId: identifier, hookId: identifier },
    ["runId", "hookId"],
  ),
  definition(
    "hook_matched",
    "A live persisted game observation matched this hook; not proof of model execution.",
    {
      hookId: identifier,
      sourceEventId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    },
    ["hookId", "sourceEventId"],
  ),
  ...(["initial", "poll", "player", "hook", "advancement"] as const).map((reason) =>
    definition(
      `run_requested_${reason}`,
      `Scheduler requested a run attempt for ${reason}; not proof of provider execution. Records sharing requestId belong to one attempt.`,
      {
        requestId: identifier,
        ...(reason === "player" ? { text } : {}),
        ...(reason === "hook" ? { hookId: identifier } : {}),
        ...(reason === "hook" || reason === "advancement"
          ? { sourceEventId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }
          : {}),
      },
      [
        "requestId",
        ...(reason === "player" ? ["text"] : []),
        ...(reason === "hook" ? ["hookId"] : []),
        ...(reason === "hook" || reason === "advancement" ? ["sourceEventId"] : []),
      ],
      "attempt",
    ),
  ),
]);

export function isActivity(name: string): boolean {
  return activityCatalog.list().some((definition) => definition.name === name);
}

export function validateActivity(value: unknown): asserts value is Activity {
  if (
    !Check(ActivitySchema, value) ||
    !Check(activityCatalog.get(value.event).dataSchema, value.data)
  )
    throw new Error("Invalid Hisyo activity");
  for (const field of ["text", "instruction"])
    if (typeof value.data[field] === "string" && !value.data[field].trim())
      throw new Error("Blank Hisyo activity text");
}

export function activity(
  binding: SessionBinding,
  event: string,
  data: Record<string, unknown>,
  recordedAt = Date.now(),
): Activity {
  const value = {
    worldId: binding.worldId,
    playerId: binding.playerId,
    sessionId: binding.sessionId,
    origin: "cli" as const,
    recordedAt,
    event,
    data,
  };
  validateActivity(value);
  return value;
}

export function displayedActivity(
  request: unknown,
  acknowledgement: unknown,
  recordedAt = Date.now(),
): Activity {
  if (
    !Check(SendMessageSchema, request) ||
    !Check(SendMessageResultSchema, acknowledgement) ||
    !sameRunBinding(request, acknowledgement)
  )
    throw new Error("No confirmed HUD display acknowledgement");
  return activity(
    request,
    "hisyo.hud_displayed",
    { runId: request.runId, text: request.text },
    recordedAt,
  );
}

export function runRequestActivities(
  batch: RunRequest,
  recordedAt = Date.now(),
  requestId: string = randomUUID(),
): Activity[] {
  const records: Activity[] = [];
  const add = (reason: string, data: Record<string, unknown> = {}) =>
    records.push(
      activity(batch.binding, `hisyo.run_requested_${reason}`, { requestId, ...data }, recordedAt),
    );
  if (batch.initial) add("initial");
  if (batch.poll) add("poll");
  for (const text of batch.playerMessages) add("player", { text });
  for (const hook of batch.hooks)
    for (const sourceEventId of hook.eventIds) add("hook", { hookId: hook.id, sourceEventId });
  for (const stored of batch.observations)
    if (isAdvancementUnlock(stored.observation)) add("advancement", { sourceEventId: stored.id });
  return records;
}
