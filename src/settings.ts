import type { JsonObject } from "@elgato/utils";
import type { ReasoningEffort } from "./domain.js";

export interface GlobalSettings {
  version: 2;
  codexPath: string;
  editorCommand: string;
  editorArgs: string[];
  recentHorizonDays: number;
  doneGraceHours: number;
  metadataPollSeconds: number;
  backgroundPollSeconds: number;
  freshMinutes: number;
  staleMinutes: number;
  holdMilliseconds: number;
  sourceKinds: string[];
  includeEphemeral: boolean;
  includeExecThreads: boolean;
  groupWorktrees: boolean;
  notifyBridgeEnabled: boolean;
  externalApprovalHoldMinutes: number;
  newTaskMode: "plugin_owned" | "handoff";
  autoRefreshStaleReports: boolean;
  maxStatusTurnsPerDay: number;
  statusTurnTimeoutSeconds: number;
  redactContentInLogs: boolean;
  presetModel: string;
  presetEffort: ReasoningEffort | "";
}

export type GlobalSettingsJson = GlobalSettings & JsonObject;

export interface SlotSettings {
  slotMode?: "auto" | "pinned";
  slotIndex?: number;
  pinnedProjectRoot?: string;
  pinnedThreadId?: string;
  tapAction?: "open_codex" | "open_editor" | "open_both" | "refresh_status";
  holdAction?: "refresh_status";
  showFreshness?: boolean;
  showAttentionCount?: boolean;
  displayNameOverride?: string;
}

export type SlotSettingsJson = SlotSettings & JsonObject;

export interface TargetActionSettings {
  slotIndex?: number;
  prompt?: string;
}

export interface ModelPresetSettings {
  modelAlias?: "auto" | "sol" | "terra" | "luna";
}

export type ModelPresetSettingsJson = ModelPresetSettings & JsonObject;

export interface EffortPresetSettings {
  effort?: "cycle" | ReasoningEffort;
}

export type EffortPresetSettingsJson = EffortPresetSettings & JsonObject;

export type TargetActionSettingsJson = TargetActionSettings & JsonObject;

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  version: 2,
  codexPath: "codex",
  editorCommand: "code",
  editorArgs: ["--reuse-window"],
  recentHorizonDays: 14,
  doneGraceHours: 24,
  metadataPollSeconds: 10,
  backgroundPollSeconds: 60,
  freshMinutes: 15,
  staleMinutes: 120,
  holdMilliseconds: 650,
  sourceKinds: ["cli", "vscode", "appServer"],
  includeEphemeral: false,
  includeExecThreads: false,
  groupWorktrees: true,
  notifyBridgeEnabled: true,
  externalApprovalHoldMinutes: 30,
  newTaskMode: "plugin_owned",
  autoRefreshStaleReports: false,
  maxStatusTurnsPerDay: 20,
  statusTurnTimeoutSeconds: 120,
  redactContentInLogs: true,
  presetModel: "",
  presetEffort: ""
};

const numberSetting = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

const booleanSetting = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const stringSetting = (value: unknown, fallback: string, maxLength: number): string => {
  if (typeof value !== "string" || value.includes("\0")) return fallback;
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned || fallback;
};

export function normalizeGlobalSettings(input: Partial<GlobalSettings> | undefined): GlobalSettings {
  const raw = input ?? {};
  const freshMinutes = numberSetting(raw.freshMinutes, 15, 1, 1440);
  const staleMinutes = Math.max(freshMinutes + 1, numberSetting(raw.staleMinutes, 120, 2, 10080));
  return {
    version: 2,
    codexPath: stringSetting(raw.codexPath, "codex", 32_768),
    editorCommand: stringSetting(raw.editorCommand, "code", 32_768),
    editorArgs: Array.isArray(raw.editorArgs)
      ? raw.editorArgs
          .filter((arg): arg is string => typeof arg === "string" && !arg.includes("\0"))
          .map((arg) => arg.slice(0, 32_768))
          .slice(0, 16)
      : ["--reuse-window"],
    recentHorizonDays: numberSetting(raw.recentHorizonDays, 14, 1, 365),
    doneGraceHours: numberSetting(raw.doneGraceHours, 24, 0, 720),
    metadataPollSeconds: numberSetting(raw.metadataPollSeconds, 10, 5, 300),
    backgroundPollSeconds: numberSetting(raw.backgroundPollSeconds, 60, 15, 900),
    freshMinutes,
    staleMinutes,
    holdMilliseconds: numberSetting(raw.holdMilliseconds, 650, 300, 3000),
    externalApprovalHoldMinutes: numberSetting(raw.externalApprovalHoldMinutes, 30, 1, 240),
    maxStatusTurnsPerDay: numberSetting(raw.maxStatusTurnsPerDay, 20, 1, 200),
    statusTurnTimeoutSeconds: numberSetting(raw.statusTurnTimeoutSeconds, 120, 30, 600),
    sourceKinds: Array.isArray(raw.sourceKinds)
      ? raw.sourceKinds
          .filter((kind): kind is string => typeof kind === "string" && !kind.includes("\0"))
          .map((kind) => kind.trim().slice(0, 64))
          .filter(Boolean)
          .slice(0, 16)
      : [...DEFAULT_GLOBAL_SETTINGS.sourceKinds],
    includeEphemeral: booleanSetting(raw.includeEphemeral, false),
    includeExecThreads: booleanSetting(raw.includeExecThreads, false),
    groupWorktrees: booleanSetting(raw.groupWorktrees, true),
    notifyBridgeEnabled: booleanSetting(raw.notifyBridgeEnabled, true),
    newTaskMode: raw.newTaskMode === "handoff" ? "handoff" : "plugin_owned",
    autoRefreshStaleReports: booleanSetting(raw.autoRefreshStaleReports, false),
    redactContentInLogs: booleanSetting(raw.redactContentInLogs, true),
    presetModel: typeof raw.presetModel === "string" ? raw.presetModel.trim().slice(0, 200) : "",
    presetEffort: ["low", "medium", "high", "xhigh", "max", "ultra"].includes(raw.presetEffort ?? "")
      ? (raw.presetEffort as ReasoningEffort)
      : ""
  };
}

export function normalizeModelPresetSettings(settings: ModelPresetSettings | undefined): Required<ModelPresetSettings> {
  return { modelAlias: ["sol", "terra", "luna"].includes(settings?.modelAlias ?? "")
    ? (settings?.modelAlias as "sol" | "terra" | "luna")
    : "auto" };
}

export function normalizeEffortPresetSettings(settings: EffortPresetSettings | undefined): Required<EffortPresetSettings> {
  return { effort: ["low", "medium", "high", "xhigh", "max", "ultra"].includes(settings?.effort ?? "")
    ? (settings?.effort as ReasoningEffort)
    : "cycle" };
}

export function normalizeSlotSettings(settings: SlotSettings | undefined): Required<SlotSettings> {
  return {
    slotMode: settings?.slotMode === "pinned" ? "pinned" : "auto",
    slotIndex: Number.isInteger(settings?.slotIndex) ? Math.max(0, Math.min(31, settings?.slotIndex ?? 0)) : 0,
    pinnedProjectRoot:
      typeof settings?.pinnedProjectRoot === "string" && !settings.pinnedProjectRoot.includes("\0")
        ? settings.pinnedProjectRoot.slice(0, 32_768)
        : "",
    pinnedThreadId:
      typeof settings?.pinnedThreadId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(settings.pinnedThreadId)
        ? settings.pinnedThreadId
        : "",
    tapAction: ["open_codex", "open_editor", "open_both", "refresh_status"].includes(settings?.tapAction ?? "")
      ? (settings?.tapAction as Required<SlotSettings>["tapAction"])
      : "open_codex",
    holdAction: "refresh_status",
    showFreshness: settings?.showFreshness !== false,
    showAttentionCount: settings?.showAttentionCount !== false,
    displayNameOverride:
      typeof settings?.displayNameOverride === "string"
        ? settings.displayNameOverride.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 48)
        : ""
  };
}

export function normalizeTargetSettings(settings: TargetActionSettings | undefined): Required<TargetActionSettings> {
  return {
    slotIndex: Number.isInteger(settings?.slotIndex)
      ? Math.max(0, Math.min(31, settings?.slotIndex ?? 0))
      : 0,
    prompt:
      typeof settings?.prompt === "string"
        ? settings.prompt.replace(/\0/g, "").slice(0, 16_000)
        : ""
  };
}
