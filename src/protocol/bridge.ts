import { Type, type Static } from "typebox";
import { EventFilterSchema } from "../events/eventCatalog.js";
import { GameEventSchema, WorldScopeSchema } from "./gameEvent.js";
import { GameStateSchema } from "./gameState.js";

export const protocolVersion = 2;
const identifier = GameEventSchema.properties.worldId;
const counter = GameEventSchema.properties.tick;
const strict = { additionalProperties: false } as const;

export const HelloSchema = Type.Object(
  {
    protocolVersion: Type.Literal(protocolVersion),
    role: Type.Literal("game"),
    token: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
  },
  strict,
);
export type BridgeRole = Static<typeof HelloSchema>["role"];

export const SessionBindingSchema = Type.Object(
  {
    ...WorldScopeSchema.properties,
    sessionId: identifier,
  },
  strict,
);
export type SessionBinding = Readonly<Static<typeof SessionBindingSchema>>;

export const RunBindingSchema = Type.Object(
  {
    ...SessionBindingSchema.properties,
    runId: identifier,
  },
  strict,
);
export type RunBinding = Readonly<Static<typeof RunBindingSchema>>;
// RpcError.data carries the exact invalidated RunBinding, not arbitrary request parameters.
export const staleRunErrorCode = -32005;

export const EmptySchema = Type.Object({}, strict);
export const GameAttachSchema = Type.Object(
  {
    ...WorldScopeSchema.properties,
    language: Type.String({ minLength: 1, maxLength: 16, pattern: "^[a-zA-Z0-9_-]+$" }),
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
    ...SessionBindingSchema.properties,
    paused: Type.Boolean(),
  },
  strict,
);
export const GameEventsSchema = Type.Object(
  { events: Type.Array(GameEventSchema, { minItems: 1, maxItems: 1024 }) },
  strict,
);
export const PlayerMessageSchema = Type.Object(
  {
    ...SessionBindingSchema.properties,
    text: Type.String({ minLength: 1, maxLength: 16_000 }),
  },
  strict,
);

export const HookInputSchema = Type.Object(
  {
    event: Type.String({ minLength: 1, maxLength: 128 }),
    filter: Type.Optional(EventFilterSchema),
    instruction: Type.String({ minLength: 1, maxLength: 16_000 }),
  },
  strict,
);
export type HookInput = Static<typeof HookInputSchema>;
export const HookListOptionsSchema = Type.Object(
  {
    after: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  },
  strict,
);
export type HookListOptions = Static<typeof HookListOptionsSchema>;

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
    query: EmptySchema,
  },
  strict,
);
export const GameStateResultSchema = Type.Object(
  {
    ...RunBindingSchema.properties,
    state: GameStateSchema,
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

export function sameSessionBinding(a: SessionBinding, b: SessionBinding): boolean {
  return a.worldId === b.worldId && a.playerId === b.playerId && a.sessionId === b.sessionId;
}

export function sameRunBinding(a: RunBinding, b: RunBinding): boolean {
  return sameSessionBinding(a, b) && a.runId === b.runId;
}
