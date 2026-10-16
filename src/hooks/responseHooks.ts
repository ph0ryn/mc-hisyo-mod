import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
  EventCatalog,
  EventFilterSchema,
  matchesFilter,
  type EventFilter,
} from "../events/eventCatalog.js";
import { validateScope, type GameEvent, type WorldScope } from "../protocol/gameEvent.js";

const HookInputSchema = Type.Object(
  {
    event: Type.String({ minLength: 1, maxLength: 128 }),
    filter: Type.Optional(EventFilterSchema),
    instruction: Type.String({ minLength: 1, maxLength: 16_000 }),
  },
  { additionalProperties: false },
);
export type HookInput = Static<typeof HookInputSchema>;
export interface ResponseHook {
  id: string;
  event: string;
  filter: EventFilter;
  instruction: string;
}

function decodeRow(row: Record<string, SQLOutputValue>): ResponseHook {
  if (
    typeof row.id !== "string" ||
    typeof row.event !== "string" ||
    typeof row.filter_json !== "string" ||
    typeof row.instruction !== "string"
  ) {
    throw new Error("Invalid stored response hook");
  }
  return {
    id: row.id,
    event: row.event,
    filter: JSON.parse(row.filter_json) as EventFilter,
    instruction: row.instruction,
  };
}

export class ResponseHooks {
  constructor(
    readonly db: DatabaseSync,
    readonly catalog: EventCatalog,
  ) {}

  add(scope: WorldScope, input: HookInput): ResponseHook {
    validateScope(scope);
    if (!Check(HookInputSchema, input) || !input.instruction.trim())
      throw new Error("Invalid response hook");
    const filter = input.filter ?? {};
    this.catalog.validateFilter(input.event, filter);
    const hook: ResponseHook = {
      id: randomUUID(),
      event: input.event,
      filter: structuredClone(filter),
      instruction: input.instruction,
    };
    this.db
      .prepare(
        "INSERT INTO response_hooks(id, world_id, player_id, event, filter_json, instruction) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        hook.id,
        scope.worldId,
        scope.playerId,
        hook.event,
        JSON.stringify(hook.filter),
        hook.instruction,
      );
    return hook;
  }

  list(scope: WorldScope): ResponseHook[] {
    validateScope(scope);
    return this.db
      .prepare("SELECT * FROM response_hooks WHERE world_id = ? AND player_id = ? ORDER BY rowid")
      .all(scope.worldId, scope.playerId)
      .map(decodeRow);
  }

  remove(scope: WorldScope, id: string): boolean {
    validateScope(scope);
    return (
      this.db
        .prepare("DELETE FROM response_hooks WHERE world_id = ? AND player_id = ? AND id = ?")
        .run(scope.worldId, scope.playerId, id).changes === 1
    );
  }

  match(observation: GameEvent): ResponseHook[] {
    this.catalog.validateObservation(observation);
    const { worldId, playerId, event, data } = observation;
    return this.db
      .prepare(
        "SELECT * FROM response_hooks WHERE world_id = ? AND player_id = ? AND event = ? ORDER BY rowid",
      )
      .all(worldId, playerId, event)
      .map(decodeRow)
      .filter((hook) => {
        this.catalog.validateFilter(event, hook.filter);
        return matchesFilter(data, hook.filter);
      });
  }
}
