import { describe, expect, it } from "vitest";
import type { CodexModel } from "../src/domain.js";
import { modelForAlias, resolvePreset } from "../src/presets.js";

const models: CodexModel[] = [
  {
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    hidden: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "" },
      { reasoningEffort: "high", description: "" }
    ]
  },
  {
    id: "gpt-5.6-terra",
    model: "gpt-5.6-terra",
    displayName: "GPT-5.6-Terra",
    hidden: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }]
  }
];

describe("dynamic presets", () => {
  it("discovers named presets from model/list data", () => {
    expect(modelForAlias(models, "sol")?.model).toBe("gpt-5.6-sol");
    expect(modelForAlias(models, "terra")?.model).toBe("gpt-5.6-terra");
    expect(modelForAlias(models, "luna")).toBeUndefined();
  });

  it("applies a valid model and effort together", () => {
    expect(resolvePreset(models, "gpt-5.6-sol", "high")).toEqual({
      active: true,
      model: "gpt-5.6-sol",
      effort: "high"
    });
  });

  it("rejects stale or unsupported selections instead of silently ignoring them", () => {
    expect(() => resolvePreset(models, "gpt-5.6-luna", "")).toThrow(/model\/list/);
    expect(() => resolvePreset(models, "gpt-5.6-terra", "high")).toThrow(/does not support/);
  });
});
