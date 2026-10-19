import { Type } from "typebox";
import { Check } from "typebox/value";
import { physicalModelApis } from "./piPolicy.js";

export interface NativePiModelSelector {
  provider: string;
  id: string;
}
export interface NativePiModel extends NativePiModelSelector {
  apiKey: string;
}
export type NativePiModelQuery =
  | "get_available_models"
  | "get_available_thinking_levels"
  | "get_state";

export function assertNativePiModel(model: NativePiModel): void {
  if (
    [model.provider, model.id, model.apiKey].some((value) => typeof value !== "string" || !value) ||
    model.id.startsWith(`${model.provider}/`)
  )
    throw new Error("Invalid trusted native Pi model configuration");
}

/** An auth-only override leaves Pi's native thinking/compatibility metadata intact. */
export function nativePiModelsConfig(model: NativePiModel) {
  assertNativePiModel(model);
  return { providers: { [model.provider]: { apiKey: "${MC_HISYO_MODEL_API_KEY}" } } };
}

const modelSchema = Type.Object({ provider: Type.String(), id: Type.String(), api: Type.String() });
const modelsSchema = Type.Object({ models: Type.Array(modelSchema) });
const levelsSchema = Type.Object({ levels: Type.Array(Type.String()) });
const stateSchema = Type.Object({
  model: modelSchema,
  thinkingLevel: Type.Literal("medium"),
  isStreaming: Type.Literal(false),
  isCompacting: Type.Literal(false),
  autoCompactionEnabled: Type.Literal(false),
  pendingMessageCount: Type.Literal(0),
});

/**
 * Check decoded RPC values without owning a process or importing Pi's catalog.
 * checkpoint throws on lost authorization/deadline, or returns false on cancellation.
 * The owner pins the returned API and supplies it again for every run.
 */
export async function checkNativePiModel(
  selector: NativePiModelSelector,
  query: (command: NativePiModelQuery) => Promise<unknown>,
  checkpoint: () => boolean,
  pinnedApi?: string,
): Promise<string | undefined> {
  if (!checkpoint()) return;
  const available = await query("get_available_models");
  if (!checkpoint()) return;
  if (!Check(modelsSchema, available)) throw new Error("Invalid Pi model catalog");
  const matching = available.models.filter(
    (model) => model.provider === selector.provider && model.id === selector.id,
  );
  if (
    matching.length !== 1 ||
    !physicalModelApis.has(matching[0]!.api) ||
    (pinnedApi !== undefined && matching[0]!.api !== pinnedApi)
  )
    throw new Error("Configured model is not an available physical API");
  const api = matching[0]!.api;
  const levels = await query("get_available_thinking_levels");
  if (!checkpoint()) return;
  if (!Check(levelsSchema, levels) || !levels.levels.includes("medium"))
    throw new Error("Selected model does not support medium thinking");
  const state = await query("get_state");
  if (!checkpoint()) return;
  if (
    !Check(stateSchema, state) ||
    state.model.provider !== selector.provider ||
    state.model.id !== selector.id ||
    state.model.api !== api
  )
    throw new Error("Pi state does not match isolated model/thinking/queue policy");
  return api;
}
