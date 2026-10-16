import { Type, type Static } from "typebox";
import { EventFilterSchema } from "../events/eventCatalog.js";
import { HookInputSchema, HookListOptionsSchema } from "../hooks/responseHooks.js";
import { GameEventSchema, WorldScopeSchema } from "./gameEvent.js";

export const protocolVersion = 1;
const identifier = GameEventSchema.properties.worldId;
const counter = GameEventSchema.properties.tick;
const strict = { additionalProperties: false } as const;

export const HelloSchema = Type.Object(
  {
    protocolVersion: Type.Literal(protocolVersion),
    role: Type.Union([Type.Literal("game"), Type.Literal("agent")]),
    token: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
  },
  strict,
);
export type BridgeRole = Static<typeof HelloSchema>["role"];

export const WorldBindingSchema = Type.Object(
  {
    ...WorldScopeSchema.properties,
    worldSessionId: identifier,
  },
  strict,
);
export type WorldBinding = Readonly<Static<typeof WorldBindingSchema>>;

export const RunBindingSchema = Type.Object(
  {
    ...WorldBindingSchema.properties,
    runId: identifier,
  },
  strict,
);
export type RunBinding = Readonly<Static<typeof RunBindingSchema>>;

export const EmptySchema = Type.Object({}, strict);
export const GameAttachSchema = Type.Object(
  {
    ...WorldScopeSchema.properties,
    supportedEvents: Type.Array(GameEventSchema.properties.event, {
      uniqueItems: true,
      maxItems: 512,
    }),
    paused: Type.Boolean(),
  },
  strict,
);
export const GameStatusSchema = Type.Object(
  {
    ...WorldBindingSchema.properties,
    paused: Type.Boolean(),
  },
  strict,
);
export const PlayerMessageSchema = Type.Object(
  {
    ...WorldBindingSchema.properties,
    text: Type.String({ minLength: 1, maxLength: 16_000 }),
  },
  strict,
);

export const HookAddSchema = Type.Object(
  {
    ...RunBindingSchema.properties,
    ...HookInputSchema.properties,
  },
  strict,
);
export const HookListRequestSchema = Type.Object(
  { ...RunBindingSchema.properties, query: Type.Optional(HookListOptionsSchema) },
  strict,
);
export const HookRemoveSchema = Type.Object(
  {
    ...RunBindingSchema.properties,
    id: identifier,
  },
  strict,
);
export const EventSearchRequestSchema = Type.Object(
  {
    ...RunBindingSchema.properties,
    query: Type.Object(
      {
        event: Type.Optional(GameEventSchema.properties.event),
        filter: Type.Optional(EventFilterSchema),
        since: Type.Optional(counter),
        after: Type.Optional(counter),
        through: Type.Optional(counter),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      },
      strict,
    ),
  },
  strict,
);
export const GameStateRequestSchema = Type.Object(
  {
    ...RunBindingSchema.properties,
    query: Type.Record(Type.String(), Type.Unknown()),
  },
  strict,
);
export const GameStateResultSchema = Type.Object(
  {
    ...RunBindingSchema.properties,
    state: Type.Record(Type.String(), Type.Unknown()),
  },
  strict,
);
export const SendMessageSchema = Type.Object(
  {
    ...RunBindingSchema.properties,
    text: PlayerMessageSchema.properties.text,
  },
  strict,
);
export const SendMessageResultSchema = Type.Object(
  {
    ...RunBindingSchema.properties,
    displayed: Type.Literal(true),
  },
  strict,
);

export function sameWorldBinding(a: WorldBinding, b: WorldBinding): boolean {
  return (
    a.worldId === b.worldId && a.playerId === b.playerId && a.worldSessionId === b.worldSessionId
  );
}

export function sameRunBinding(a: RunBinding, b: RunBinding): boolean {
  return sameWorldBinding(a, b) && a.runId === b.runId;
}
