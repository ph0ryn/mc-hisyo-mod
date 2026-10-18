import { Type } from "typebox";
import {
  EmptySchema,
  EventSearchRequestSchema,
  HookInputSchema,
  HookListOptionsSchema,
  HookRemoveSchema,
  SendMessageSchema,
} from "./bridge.js";
import { referenceTools } from "./gameReferences.js";

const strict = { additionalProperties: false } as const;

/** The exact tool surface shared by the host's allowlist and Pi registration. */
export const directorTools = [
  {
    name: "get_game_state",
    description:
      "Get a fresh bounded snapshot of the current game. Query must be {}. Nulls and incomplete coverage are explicit.",
    args: Type.Object({ query: EmptySchema }, strict),
    method: "game.state.get",
  },
  ...referenceTools,
  {
    name: "send_message",
    description:
      "Display text to the player. This is the only way to speak in game; ordinary assistant text is not displayed.",
    args: Type.Object({ text: SendMessageSchema.properties.text }, strict),
    method: "game.message.send",
  },
  {
    name: "list_event_types",
    description:
      "List attached-game hook capabilities and searchable-only CLI Director activities, with explicit origin, hookability, filters and observation limitations.",
    args: EmptySchema,
    method: "director.events.list",
  },
  {
    name: "get_recent_events",
    description:
      "Search Mod observations for this world/player across sessions by default. Set event to an advertised director.* type to search the separate CLI activity log. IDs, through and nextCursor belong only to the selected log; never reuse them across logs. Pages are byte-bounded; preserve through and resume nextCursor. Scalar filters are type-sensitive AND matches. Gap flags cover admitted Mod sequence holes only. Query director.session_attached/detached separately for unknown pre-ready, terminal and disconnected coverage; hasKnownGaps false does not prove completeness. Requests/matches do not prove provider execution.",
    args: Type.Object({ query: EventSearchRequestSchema.properties.query }, strict),
    method: "director.events.get",
  },
  {
    name: "add_response_hook",
    description:
      "Persist an event response instruction for this world/player. Use advertised event types and filter fields.",
    args: HookInputSchema,
    method: "director.hooks.add",
  },
  {
    name: "remove_response_hook",
    description: "Remove a response hook by its ID from this world/player.",
    args: Type.Object({ id: HookRemoveSchema.properties.id }, strict),
    method: "director.hooks.remove",
  },
  {
    name: "list_response_hooks",
    description:
      "List persistent response hooks with keyset pagination. Default and maximum page size is 8; pages are not a snapshot.",
    args: HookListOptionsSchema,
    method: "director.hooks.list",
  },
] as const;

export const directorToolNames = directorTools.map(({ name }) => name);
