import type { CodexModel, ReasoningEffort } from "./domain.js";

export function modelForAlias(models: readonly CodexModel[], alias: "sol" | "terra" | "luna"): CodexModel | undefined {
  return models.find((model) => model.model.toLowerCase().endsWith(`-${alias}`));
}

export function resolvePreset(
  models: readonly CodexModel[],
  modelId: string,
  effort: ReasoningEffort | ""
): { active: boolean; model?: string; effort?: ReasoningEffort } {
  const model = models.find((candidate) => candidate.model === modelId);
  if (modelId && !model) throw new Error("The selected model is no longer exposed by model/list");
  if (model && effort && !model.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === effort)) {
    throw new Error(`${model.displayName} does not support effort ${effort}`);
  }
  return {
    active: !!model || !!effort,
    ...(model ? { model: model.model } : {}),
    ...(effort ? { effort } : {})
  };
}
