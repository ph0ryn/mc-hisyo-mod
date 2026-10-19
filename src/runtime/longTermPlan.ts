import { defineDoc, defineTool } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { RunBinding } from "../protocol/bridge.js";

const strict = { additionalProperties: false } as const;
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const PlanSchema = Type.Object(
  {
    goal: Type.Union([
      Type.Null(),
      Type.Object({ objective: text(256), reason: text(256) }, strict),
    ]),
    nextAction: Type.Union([
      Type.Null(),
      Type.Object(
        {
          instruction: text(256),
          completionCondition: text(256),
          hookIds: Type.Array(text(128), { maxItems: 8, uniqueItems: true }),
        },
        strict,
      ),
    ]),
    preferences: Type.Array(
      Type.Object(
        {
          text: text(128),
          source: Type.Union([Type.Literal("explicit"), Type.Literal("inferred")]),
        },
        strict,
      ),
      { maxItems: 8 },
    ),
    constraints: Type.Array(text(128), { maxItems: 8 }),
  },
  strict,
);
const StateSchema = Type.Object({ revision, plan: PlanSchema }, strict);
const UpdateSchema = Type.Object({ expectedRevision: revision, plan: PlanSchema }, strict);

/** Budget for the complete serialized document, including revision and JSON escaping. */
const planBytes = 4096;

/** Model-authored guidance, not a copy of current game facts or a security policy. */
export const LongTermPlan = defineDoc<Static<typeof StateSchema>>({
  kind: "hisyo.plan",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    revision: 0,
    plan: { goal: null, nextAction: null, preferences: [], constraints: [] },
  }),
});

/** Validate persisted state too: typed documents do not schema-validate their JSON values. */
export function serializePlan(value: unknown): string {
  if (!Check(StateSchema, value)) throw new Error("Invalid long-term plan document");
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > planBytes)
    throw new Error("Long-term plan document exceeds 4096 UTF-8 bytes; shorten the plan");
  return serialized;
}

/** SDK-local mutation; it adds no game protocol method or external capability. */
export function createPlanTool(
  requireRun: (signal?: AbortSignal, captured?: RunBinding) => RunBinding,
) {
  return defineTool({
    name: "update_plan",
    description:
      "Replace this world/player's saved guidance only when it changes. Use the revision in LONG_TERM_PLAN as expectedRevision and include the complete plan, preserving still-valid preferences and constraints. Null goal/nextAction clears them; empty arrays clear preferences/constraints. The whole saved document must fit 4096 UTF-8 bytes including JSON escaping. This neither displays a message nor adds/removes hooks.",
    parameters: UpdateSchema,
    replay: "unsafe",
    executionMode: "sequential",
    // Pi AI normally coerces tool arguments. Do not silently coerce saved policy or its revision.
    prepareArguments(args) {
      if (!Check(UpdateSchema, args)) throw new Error("Invalid plan update arguments");
      return args;
    },
    async execute(args, api, context) {
      const binding = requireRun(context.abortSignal);
      const updatedRevision = await api.commit(async (tx) => {
        const state = await tx.doc(LongTermPlan, api.conversationId);
        requireRun(context.abortSignal, binding);
        serializePlan(state);
        if (state.revision !== args.expectedRevision)
          throw new Error(
            `Plan revision conflict: current revision is ${state.revision}; use LONG_TERM_PLAN`,
          );
        const next = { revision: state.revision + 1, plan: args.plan };
        serializePlan(next);
        state.revision = next.revision;
        state.plan = next.plan;
        return next.revision;
      }, context);
      // The next request receives the snapshot; do not duplicate the complete plan in the result.
      return { output: [{ type: "text", text: JSON.stringify({ revision: updatedRevision }) }] };
    },
  });
}
