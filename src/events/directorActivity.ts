import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
  SendMessageResultSchema,
  SendMessageSchema,
  sameRunBinding,
  type WorldBinding,
} from "../protocol/bridge.js";
import { GameEventSchema, WorldScopeSchema, type EventDefinition } from "../protocol/gameEvent.js";
import type { JudgmentBatch } from "../runtime/judgmentQueue.js";
import { EventCatalog, EventFilterSchema } from "./eventCatalog.js";

const strict = { additionalProperties: false } as const;
const identifier = GameEventSchema.properties.worldId;
const counter = GameEventSchema.properties.tick;
const text = Type.String({ minLength: 1, maxLength: 16_000 });
export const DirectorActivitySchema = Type.Object(
  {
    ...WorldScopeSchema.properties,
    worldSessionId: identifier,
    origin: Type.Literal("cli"),
    observedAt: counter,
    event: GameEventSchema.properties.event,
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  strict,
);
export type DirectorActivity = Static<typeof DirectorActivitySchema>;

function definition(
  name: string,
  description: string,
  properties: Parameters<typeof Type.Object>[0],
  filterFields: string[],
  observation: EventDefinition["observation"] = "confirmed",
): EventDefinition {
  return {
    name: `director.${name}`,
    description,
    observation,
    dataSchema: Type.Object(properties, strict),
    filterFields,
  };
}

export const directorActivityCatalog = new EventCatalog([
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
    "Hook registration committed together with this history record.",
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
    "An existing hook deletion committed together with this history record.",
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
  ...(["initial", "poll", "player", "hook"] as const).map((reason) =>
    definition(
      `judgment_requested_${reason}`,
      `Scheduler requested a judgment attempt for ${reason}; not proof of provider execution. Records sharing requestId belong to one attempt.`,
      {
        requestId: identifier,
        ...(reason === "player" ? { text } : {}),
        ...(reason === "hook"
          ? {
              hookId: identifier,
              sourceEventId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
            }
          : {}),
      },
      [
        "requestId",
        ...(reason === "player" ? ["text"] : []),
        ...(reason === "hook" ? ["hookId", "sourceEventId"] : []),
      ],
      "attempt",
    ),
  ),
]);

export function isDirectorActivity(name: string): boolean {
  return directorActivityCatalog.list().some((definition) => definition.name === name);
}

export function validateDirectorActivity(value: unknown): asserts value is DirectorActivity {
  if (
    !Check(DirectorActivitySchema, value) ||
    !Check(directorActivityCatalog.get(value.event).dataSchema, value.data)
  )
    throw new Error("Invalid Director activity");
  for (const field of ["text", "instruction"])
    if (typeof value.data[field] === "string" && !value.data[field].trim())
      throw new Error("Blank Director activity text");
}

export function activity(
  binding: WorldBinding,
  event: string,
  data: Record<string, unknown>,
  observedAt = Date.now(),
): DirectorActivity {
  const value = {
    worldId: binding.worldId,
    playerId: binding.playerId,
    worldSessionId: binding.worldSessionId,
    origin: "cli" as const,
    observedAt,
    event,
    data,
  };
  validateDirectorActivity(value);
  return value;
}

export function displayedActivity(
  request: unknown,
  acknowledgement: unknown,
  observedAt = Date.now(),
): DirectorActivity {
  if (
    !Check(SendMessageSchema, request) ||
    !Check(SendMessageResultSchema, acknowledgement) ||
    !sameRunBinding(request, acknowledgement)
  )
    throw new Error("No confirmed HUD display acknowledgement");
  return activity(
    request,
    "director.hud_displayed",
    { runId: request.runId, text: request.text },
    observedAt,
  );
}

export function judgmentActivities(
  batch: JudgmentBatch,
  observedAt = Date.now(),
  requestId: string = randomUUID(),
): DirectorActivity[] {
  const records: DirectorActivity[] = [];
  const add = (reason: string, data: Record<string, unknown> = {}) =>
    records.push(
      activity(
        batch.binding,
        `director.judgment_requested_${reason}`,
        { requestId, ...data },
        observedAt,
      ),
    );
  if (batch.worldStart) add("initial");
  if (batch.poll) add("poll");
  for (const text of batch.playerMessages) add("player", { text });
  for (const hook of batch.hooks)
    for (const sourceEventId of hook.eventIds) add("hook", { hookId: hook.id, sourceEventId });
  return records;
}
