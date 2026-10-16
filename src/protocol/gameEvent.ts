import { Type, type Static, type TObject } from "typebox";
import { Check } from "typebox/value";

const identifier = Type.String({ minLength: 1, maxLength: 128 });
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const blockPosition = Type.Tuple([Type.Integer(), Type.Integer(), Type.Integer()]);
const positiveCount = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const position = Type.Tuple([Type.Number(), Type.Number(), Type.Number()]);
const nullableIdentifier = Type.Union([identifier, Type.Null()]);
const strict = { additionalProperties: false } as const;
const sampleIntervalTicks = Type.Literal(20);
const effectProperties = {
  effectId: identifier,
  amplifier: counter,
  duration: Type.Integer({ minimum: -1, maximum: Number.MAX_SAFE_INTEGER }),
  ambient: Type.Boolean(),
  visible: Type.Boolean(),
  showIcon: Type.Boolean(),
};
const phase = Type.Union([Type.Literal("day"), Type.Literal("night")]);
const hand = Type.Union([Type.Literal("main_hand"), Type.Literal("off_hand")]);
const damageSourceProperties = {
  damageType: identifier,
  causingEntityId: nullableIdentifier,
  causingEntityType: nullableIdentifier,
  directEntityId: nullableIdentifier,
  directEntityType: nullableIdentifier,
};
const damageSourceFilterFields = [
  "damageType",
  "causingEntityId",
  "causingEntityType",
  "directEntityId",
  "directEntityType",
];

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
      "A slot's item ID/count differs between tick snapshots; this does not identify pickup or crafting and omits component-only and same-tick net-zero changes.",
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
  {
    name: "food_changed",
    description:
      "Food level or saturation differs between tick snapshots; not individual eating/exhaustion events and same-tick net-zero changes can be missed.",
    observation: "snapshot_delta",
    dataSchema: Type.Object(
      {
        beforeFoodLevel: counter,
        afterFoodLevel: counter,
        beforeSaturation: Type.Number(),
        afterSaturation: Type.Number(),
      },
      { additionalProperties: false },
    ),
    filterFields: ["beforeFoodLevel", "afterFoodLevel", "beforeSaturation", "afterSaturation"],
  },
  {
    name: "experience_changed",
    description:
      "Experience fields differ between tick snapshots; this does not identify XP earned or its cause and can miss same-tick net-zero changes.",
    observation: "snapshot_delta",
    dataSchema: Type.Object(
      {
        beforeLevel: counter,
        afterLevel: counter,
        beforeProgress: Type.Number(),
        afterProgress: Type.Number(),
        beforeTotalExperience: counter,
        afterTotalExperience: counter,
      },
      { additionalProperties: false },
    ),
    filterFields: [
      "beforeLevel",
      "afterLevel",
      "beforeProgress",
      "afterProgress",
      "beforeTotalExperience",
      "afterTotalExperience",
    ],
  },
  {
    name: "held_item_changed",
    description:
      "Hand item ID/count or selected main-hand slot differs between tick snapshots; component-only and same-tick net-zero changes are omitted. This is not item use; off-hand slot indices are null.",
    observation: "snapshot_delta",
    dataSchema: Type.Object(
      {
        hand,
        beforeSlot: Type.Union([counter, Type.Null()]),
        afterSlot: Type.Union([counter, Type.Null()]),
        beforeItemId: identifier,
        beforeCount: counter,
        afterItemId: identifier,
        afterCount: counter,
      },
      { additionalProperties: false },
    ),
    filterFields: [
      "hand",
      "beforeSlot",
      "afterSlot",
      "beforeItemId",
      "beforeCount",
      "afterItemId",
      "afterCount",
    ],
  },
  {
    name: "player_location_changed",
    description:
      "At sampleIntervalTicks server ticks, reports nonzero 3-D displacement of at least minimumDistance blocks or a biome-ID change from the last emitted baseline. elapsedTicks is since that baseline, not a complete travel path; unknown biome IDs are null.",
    observation: "snapshot_delta",
    dataSchema: Type.Object(
      {
        beforePosition: position,
        afterPosition: position,
        beforeBiomeId: nullableIdentifier,
        afterBiomeId: nullableIdentifier,
        sampleIntervalTicks: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        minimumDistance: Type.Number({ minimum: 0 }),
        elapsedTicks: counter,
      },
      { additionalProperties: false },
    ),
    filterFields: [
      "beforeBiomeId",
      "afterBiomeId",
      "sampleIntervalTicks",
      "minimumDistance",
      "elapsedTicks",
    ],
  },
  {
    name: "dimension_changed",
    description:
      "The server confirmed a player world change; envelope position is the observed destination, not a reconstructed departure position.",
    observation: "confirmed",
    dataSchema: Type.Object(
      { fromDimension: identifier, toDimension: identifier },
      { additionalProperties: false },
    ),
    filterFields: ["fromDimension", "toDimension"],
  },
  {
    name: "player_died",
    description:
      "The server's AFTER_DEATH callback confirmed player death; nullable source entities are unknown/absent, and no final damage amount is inferred.",
    observation: "confirmed",
    dataSchema: Type.Object(damageSourceProperties, { additionalProperties: false }),
    filterFields: damageSourceFilterFields,
  },
  {
    name: "player_respawned",
    description:
      "The server created the replacement player; alive=true is recreation without implying a preceding death.",
    observation: "confirmed",
    dataSchema: Type.Object({ alive: Type.Boolean() }, { additionalProperties: false }),
    filterFields: ["alive"],
  },
  {
    name: "player_connection_changed",
    description:
      "Joined after server player placement, or leaving before removal is complete; leaving is not a completed-disconnection notification.",
    observation: "confirmed",
    dataSchema: Type.Object(
      { state: Type.Union([Type.Literal("joined"), Type.Literal("leaving")]) },
      { additionalProperties: false },
    ),
    filterFields: ["state"],
  },
  {
    name: "living_damage_processed",
    description:
      "The server AFTER_DAMAGE callback processed nonlethal damage or a shield block involving the player; lethal damage is excluded and callback amounts are not final health loss.",
    observation: "confirmed",
    dataSchema: Type.Object(
      {
        ...damageSourceProperties,
        relationship: Type.Union([
          Type.Literal("received"),
          Type.Literal("dealt"),
          Type.Literal("both"),
        ]),
        victimId: identifier,
        victimType: identifier,
        baseDamageTaken: Type.Number(),
        damageTaken: Type.Number(),
        blocked: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    filterFields: [
      ...damageSourceFilterFields,
      "relationship",
      "victimId",
      "victimType",
      "baseDamageTaken",
      "damageTaken",
      "blocked",
    ],
  },
  {
    name: "entity_use_attempted",
    description:
      "A server-side entity-use callback observed an attempt before vanilla validation; not confirmed trading, taming, riding, or menu opening. Server hit position can be null.",
    observation: "attempt",
    dataSchema: Type.Object(
      {
        entityId: identifier,
        entityType: identifier,
        hand,
        hitPosition: Type.Union([position, Type.Null()]),
      },
      { additionalProperties: false },
    ),
    filterFields: ["entityId", "entityType", "hand"],
  },
  {
    name: "status_effects_sampled",
    description:
      "Initial active-effect baseline, not acquisition; at most 256 entries, with explicit truncation.",
    observation: "snapshot_delta",
    dataSchema: Type.Object(
      {
        baseline: Type.Literal(true),
        effects: Type.Array(Type.Object(effectProperties, strict), { maxItems: 256 }),
        effectsTruncated: Type.Boolean(),
      },
      strict,
    ),
    filterFields: ["baseline", "effectsTruncated"],
  },
  {
    name: "status_effect_changed",
    description:
      "Server AFTER_ADD/AFTER_REMOVE or true onEffectUpdated RETURN; copied state only, no inferred cause or before-values. Periodic false updates are excluded.",
    observation: "confirmed",
    dataSchema: Type.Object(
      {
        change: Type.Union([
          Type.Literal("added"),
          Type.Literal("removed"),
          Type.Literal("updated"),
        ]),
        ...effectProperties,
      },
      strict,
    ),
    filterFields: ["change", ...Object.keys(effectProperties)],
  },
  {
    name: "equipment_slot_changed",
    description:
      "Tick-end equipment ID/count delta, not an equip action; omits component-only and same-tick net-zero changes.",
    observation: "snapshot_delta",
    dataSchema: Type.Object(
      {
        slot: Type.Union(
          ["feet", "legs", "chest", "head", "offHand", "body", "saddle"].map((slot) =>
            Type.Literal(slot),
          ),
        ),
        beforeItemId: identifier,
        beforeCount: counter,
        afterItemId: identifier,
        afterCount: counter,
      },
      strict,
    ),
    filterFields: ["slot", "beforeItemId", "beforeCount", "afterItemId", "afterCount"],
  },
  {
    name: "nearby_sampled",
    description:
      "Every 20 ticks: loaded non-air blocks in radius4 cube and up to64 entities in radius16 sphere. Not sight, nearest order, or a complete world sample; may miss subinterval changes.",
    observation: "snapshot_delta",
    dataSchema: Type.Object(
      {
        sampleIntervalTicks,
        blockRadius: Type.Literal(4),
        blocksComplete: Type.Boolean(),
        blocks: Type.Array(
          Type.Object(
            {
              blockId: identifier,
              position: Type.Tuple([Type.Integer(), Type.Integer(), Type.Integer()]),
            },
            strict,
          ),
          { maxItems: 729 },
        ),
        entityRadius: Type.Literal(16),
        entitiesTruncated: Type.Boolean(),
        entities: Type.Array(
          Type.Object({ entityId: identifier, entityType: identifier, position }, strict),
          { maxItems: 64 },
        ),
      },
      strict,
    ),
    filterFields: [
      "sampleIntervalTicks",
      "blockRadius",
      "blocksComplete",
      "entityRadius",
      "entitiesTruncated",
    ],
  },
  {
    name: "structures_sampled",
    description:
      "Every20ticks: valid containing bounding-box metadata from current loaded chunk and already-loaded referenced start chunks only. Not visual discovery or piece occupancy; always incomplete, no remote locations. At most64 current starts,64 reference keys/64 chunk checks,128 inspected starts.",
    observation: "snapshot_delta",
    dataSchema: Type.Object(
      {
        sampleIntervalTicks,
        structureIds: Type.Array(identifier, { maxItems: 128, uniqueItems: true }),
        incomplete: Type.Literal(true),
        currentChunkLoaded: Type.Boolean(),
        startsInspected: Type.Integer({ minimum: 0, maximum: 128 }),
        referenceChunksChecked: Type.Integer({ minimum: 0, maximum: 64 }),
        unloadedReferences: Type.Integer({ minimum: 0, maximum: 64 }),
        startsTruncated: Type.Boolean(),
        referencesTruncated: Type.Boolean(),
      },
      strict,
    ),
    filterFields: [
      "sampleIntervalTicks",
      "incomplete",
      "currentChunkLoaded",
      "startsInspected",
      "referenceChunksChecked",
      "unloadedReferences",
      "startsTruncated",
      "referencesTruncated",
    ],
  },
  {
    name: "weather_changed",
    description:
      "Actual isRaining/isThundering booleans differ between20tick samples; baseline is silent and subinterval reversals may be missed.",
    observation: "snapshot_delta",
    dataSchema: Type.Object(
      {
        sampleIntervalTicks,
        beforeRaining: Type.Boolean(),
        afterRaining: Type.Boolean(),
        beforeThundering: Type.Boolean(),
        afterThundering: Type.Boolean(),
      },
      strict,
    ),
    filterFields: [
      "sampleIntervalTicks",
      "beforeRaining",
      "afterRaining",
      "beforeThundering",
      "afterThundering",
    ],
  },
  {
    name: "day_clock_phase_changed",
    description:
      "20tick sampled clock half-phase: floorMod(dayTime,24000)<12000 is day, otherwise night. Not light level; fixed-time dimension metadata is explicit; baseline is silent and subinterval changes may be missed.",
    observation: "snapshot_delta",
    dataSchema: Type.Object(
      {
        sampleIntervalTicks,
        beforePhase: phase,
        afterPhase: phase,
        dayTime: Type.Integer({
          minimum: -Number.MAX_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        }),
        fixedTime: Type.Boolean(),
      },
      strict,
    ),
    filterFields: ["sampleIntervalTicks", "beforePhase", "afterPhase", "dayTime", "fixedTime"],
  },
  {
    name: "advancement_criterion_granted",
    description:
      "Original award returned true for a newly granted criterion; loaded progress is never replayed.",
    observation: "confirmed",
    dataSchema: Type.Object(
      { advancementId: identifier, criterion: identifier, afterDone: Type.Boolean() },
      strict,
    ),
    filterFields: ["advancementId", "criterion", "afterDone"],
  },
  {
    name: "advancement_completed",
    description:
      "Successful criterion award changed native advancement done from false to true, not loaded progress or an already-done award.",
    observation: "confirmed",
    dataSchema: Type.Object(
      { advancementId: identifier, criterion: identifier, afterDone: Type.Literal(true) },
      strict,
    ),
    filterFields: ["advancementId", "criterion", "afterDone"],
  },
  {
    name: "block_placed",
    description:
      "Successful native BlockItem placement game-event seam, with actual placed position/state and item; not every block mutation or multi-block cell.",
    observation: "confirmed",
    dataSchema: Type.Object(
      { blockId: identifier, itemId: identifier, position: blockPosition },
      strict,
    ),
    filterFields: ["blockId", "itemId"],
  },
  {
    name: "item_picked_up",
    description:
      "Successful native item-entity pickup consumed this entity quantity, not guaranteed net inventory gain (infinite-materials overflow can be discarded).",
    observation: "confirmed",
    dataSchema: Type.Object(
      {
        itemId: identifier,
        count: positiveCount,
        remainingCount: counter,
        entityId: identifier,
        entityPosition: position,
        infiniteMaterials: Type.Boolean(),
      },
      strict,
    ),
    filterFields: ["itemId", "count", "remainingCount", "entityId", "infiniteMaterials"],
  },
  {
    name: "item_dropped",
    description:
      "LivingEntity.drop inserted an item entity successfully; not construction/non-null return or every death/modded spawn. Native spread/trace arguments are copied unchanged.",
    observation: "confirmed",
    dataSchema: Type.Object(
      {
        itemId: identifier,
        count: positiveCount,
        entityId: identifier,
        entityPosition: position,
        spread: Type.Boolean(),
        trace: Type.Boolean(),
      },
      strict,
    ),
    filterFields: ["itemId", "count", "entityId", "spread", "trace"],
  },
  {
    name: "grid_result_taken",
    description:
      "Grid ResultSlot native credited take amount, not a complete recipe, ingredients, yield or net inventory gain; alternate result-slot classes are not covered. Menu ID is null when this slot is not in the current menu.",
    observation: "confirmed",
    dataSchema: Type.Object(
      {
        itemId: identifier,
        count: positiveCount,
        menuId: Type.Union([counter, Type.Null()]),
        slot: counter,
      },
      strict,
    ),
    filterFields: ["itemId", "count", "menuId", "slot"],
  },
  {
    name: "furnace_result_taken",
    description:
      "FurnaceResultSlot credited player extraction on normal/quick and empty-hotbar SWAP paths, not unseen smelting production or hopper extraction. Furnace position and menu ID remain null when unknown.",
    observation: "confirmed",
    dataSchema: Type.Object(
      {
        itemId: identifier,
        count: positiveCount,
        menuId: Type.Union([counter, Type.Null()]),
        slot: counter,
        furnacePosition: Type.Union([blockPosition, Type.Null()]),
      },
      strict,
    ),
    filterFields: ["itemId", "count", "menuId", "slot"],
  },
  {
    name: "block_use_attempted",
    description:
      "Server-reached block-use callback before spectator/cooldown/native commit, not success or every click/packet; earlier checks/listeners may suppress it. loadedBlockId is only an immediate loaded-state observation, null when unknown.",
    observation: "attempt",
    dataSchema: Type.Object(
      {
        hand,
        itemId: identifier,
        count: counter,
        blockPosition,
        hitPosition: position,
        face: Type.Union([
          Type.Literal("down"),
          Type.Literal("up"),
          Type.Literal("north"),
          Type.Literal("south"),
          Type.Literal("west"),
          Type.Literal("east"),
        ]),
        loadedBlockId: nullableIdentifier,
      },
      strict,
    ),
    filterFields: ["hand", "itemId", "count", "face", "loadedBlockId"],
  },
  {
    name: "item_use_attempted",
    description:
      "Server-reached item-use callback before spectator/cooldown/native commit, not success or every click/packet; earlier checks/listeners may suppress it. Held empty air/count zero is valid.",
    observation: "attempt",
    dataSchema: Type.Object({ hand, itemId: identifier, count: counter }, strict),
    filterFields: ["hand", "itemId", "count"],
  },
];
