import { Type, type Static } from "typebox";
import { GameEventSchema } from "./gameEvent.js";

const strict = { additionalProperties: false } as const;
const identifier = GameEventSchema.properties.dimension;
const counter = GameEventSchema.properties.tick;
const position = GameEventSchema.properties.position;
const signedInteger = Type.Integer({
  minimum: -Number.MAX_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER,
});
const item = Type.Object({ itemId: identifier, count: counter }, strict);

/** Initial context budgets, not measured game-performance thresholds. */
export const snapshotLimits = { blockRadius: 4, entityRadius: 16, maxEntities: 64 } as const;

/** Required ID/count baseline; unknown neighborhood coverage must be explicit. */
export const GameStateSchema = Type.Object(
  {
    version: Type.Literal(2),
    tick: counter,
    observedAt: counter,
    dayTime: signedInteger,
    dimension: identifier,
    position,
    biomeId: Type.Union([identifier, Type.Null()]),
    health: Type.Number({ minimum: 0 }),
    maxHealth: Type.Number({ minimum: 0 }),
    foodLevel: counter,
    saturation: Type.Number({ minimum: 0 }),
    experience: Type.Object(
      {
        level: counter,
        progress: Type.Number({ minimum: 0, maximum: 1 }),
        total: counter,
      },
      strict,
    ),
    inventory: Type.Object(
      {
        selectedSlot: Type.Integer({ minimum: 0, maximum: 8 }),
        main: Type.Array(item, { minItems: 36, maxItems: 36 }),
        equipment: Type.Object(
          {
            feet: item,
            legs: item,
            chest: item,
            head: item,
            offHand: item,
            body: item,
            saddle: item,
          },
          strict,
        ),
      },
      strict,
    ),
    nearby: Type.Object(
      {
        visibility: Type.Literal("unobstructed"),
        blockRadius: Type.Literal(snapshotLimits.blockRadius),
        blocksComplete: Type.Boolean(),
        blocks: Type.Array(
          Type.Object(
            {
              blockId: identifier,
              position: Type.Tuple([signedInteger, signedInteger, signedInteger]),
            },
            strict,
          ),
          { maxItems: (snapshotLimits.blockRadius * 2 + 1) ** 3 },
        ),
        entityRadius: Type.Literal(snapshotLimits.entityRadius),
        entitiesTruncated: Type.Boolean(),
        entities: Type.Array(
          Type.Object({ entityId: identifier, entityType: identifier, position }, strict),
          { maxItems: snapshotLimits.maxEntities },
        ),
      },
      strict,
    ),
  },
  strict,
);
export type GameState = Readonly<Static<typeof GameStateSchema>>;
