import { Type, type Static, type TObject } from "typebox";
import { Check } from "typebox/value";

const identifier = Type.String({ minLength: 1, maxLength: 128 });
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const position = Type.Tuple([Type.Number(), Type.Number(), Type.Number()]);

export const WorldScopeSchema = Type.Object(
  {
    worldId: identifier,
    playerId: identifier,
  },
  { additionalProperties: false },
);
export type WorldScope = Static<typeof WorldScopeSchema>;

export function validateScope(scope: WorldScope): void {
  if (!Check(WorldScopeSchema, scope)) throw new Error("Invalid world/player scope");
}

export const GameEventSchema = Type.Object(
  {
    ...WorldScopeSchema.properties,
    worldSessionId: identifier,
    seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    tick: counter,
    observedAt: counter,
    event: Type.String({ minLength: 1, maxLength: 128 }),
    dimension: identifier,
    position,
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type GameEvent = Static<typeof GameEventSchema>;

export interface EventDefinition {
  readonly name: string;
  readonly description: string;
  readonly observation: "confirmed" | "snapshot_delta" | "attempt";
  readonly dataSchema: TObject;
  /** Scalar top-level payload fields advertised for exact AND matching. */
  readonly filterFields: readonly string[];
}

/** Definitions are capabilities, not a claim that every connected Mod observes them. */
export const gameEventDefinitions: readonly EventDefinition[] = [
  {
    name: "block_broken",
    description: "The integrated server confirmed a completed player block break.",
    observation: "confirmed",
    dataSchema: Type.Object({ blockId: identifier, position }, { additionalProperties: false }),
    filterFields: ["blockId"],
  },
  {
    name: "inventory_slot_changed",
    description:
      "A slot differs between tick snapshots; this does not identify pickup or crafting and can miss same-tick net-zero changes.",
    observation: "snapshot_delta",
    dataSchema: Type.Object(
      {
        slot: counter,
        beforeItemId: identifier,
        beforeCount: counter,
        afterItemId: identifier,
        afterCount: counter,
      },
      { additionalProperties: false },
    ),
    filterFields: ["slot", "beforeItemId", "beforeCount", "afterItemId", "afterCount"],
  },
  {
    name: "health_changed",
    description:
      "Health differs between tick snapshots; not a complete record of individual damage or healing causes.",
    observation: "snapshot_delta",
    dataSchema: Type.Object(
      { before: Type.Number(), after: Type.Number() },
      { additionalProperties: false },
    ),
    filterFields: ["before", "after"],
  },
];
