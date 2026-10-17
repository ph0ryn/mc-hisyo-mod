import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { Check } from "typebox/value";
import { EventCatalog, matchesFilter, type EventFilter } from "../events/eventCatalog.js";
import {
  HookInputSchema,
  HookListOptionsSchema,
  type HookInput,
  type HookListOptions,
} from "../protocol/bridge.js";
import { validateScope, type GameEvent, type WorldScope } from "../protocol/gameEvent.js";

export interface HookPage {
  hooks: ResponseHook[];
  nextCursor?: string;
}
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

  list(scope: WorldScope, options: HookListOptions = {}): HookPage {
    validateScope(scope);
    if (!Check(HookListOptionsSchema, options)) throw new Error("Invalid hook list options");
    const limit = options.limit ?? 8;
    const hooks = this.db
      .prepare(
        "SELECT * FROM response_hooks WHERE world_id = ? AND player_id = ? AND id > ? ORDER BY id LIMIT ?",
      )
      .all(scope.worldId, scope.playerId, options.after ?? "", limit + 1)
      .map(decodeRow);
    if (hooks.length <= limit) return { hooks };
    hooks.pop();
    return { hooks, nextCursor: hooks.at(-1)!.id };
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
