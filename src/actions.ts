import streamDeck, {
  action,
  type KeyAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type PropertyInspectorDidAppearEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { coordinator } from "./coordinator.js";
import type { ProjectState } from "./domain.js";
import { renderProjectSvg, renderUtilitySvg, svgDataUrl, type UtilityIcon } from "./renderer.js";
import { deriveDisplayState, requiresAttentionPulse } from "./status.js";
import {
  normalizeSlotSettings,
  normalizeModelPresetSettings,
  normalizeTargetSettings,
  type ModelPresetSettingsJson,
  type SlotSettingsJson,
  type TargetActionSettingsJson
} from "./settings.js";

const PROJECT_UUID = "com.codexstreamdeck.control.project-slot";

function coordinateIndex(action: KeyAction): number {
  const coordinates = action.coordinates;
  return coordinates ? coordinates.row * action.device.size.columns + coordinates.column : 0;
}

async function targetProject(action: KeyAction<TargetActionSettingsJson>): Promise<ProjectState | undefined> {
  const settings = normalizeTargetSettings(await action.getSettings<TargetActionSettingsJson>());
  return coordinator.projectAt(settings.slotIndex);
}

async function sendInspectorState(action: KeyAction, project?: ProjectState): Promise<void> {
  await streamDeck.ui.sendToPropertyInspector(coordinator.inspectorState(project));
}

@action({ UUID: PROJECT_UUID })
export class ProjectSlotAction extends SingletonAction<SlotSettingsJson> {
  readonly #pressedAt = new Map<string, number>();
  readonly #rendered = new Map<string, { svg: string; at: number }>();
  readonly #urgent = new Map<string, boolean>();
  readonly #pulseTimers = new Map<string, NodeJS.Timeout>();
  #renderScheduled = false;

  constructor() {
    super();
    coordinator.onChange(() => this.#scheduleRender());
  }

  override async onWillAppear(event: WillAppearEvent<SlotSettingsJson>): Promise<void> {
    if (!event.action.isKey()) return;
    await this.#render(event.action, event.payload.settings);
  }

  override onWillDisappear(event: WillDisappearEvent<SlotSettingsJson>): void {
    this.#pressedAt.delete(event.action.id);
    this.#rendered.delete(event.action.id);
    this.#urgent.delete(event.action.id);
    const timer = this.#pulseTimers.get(event.action.id);
    if (timer) clearTimeout(timer);
    this.#pulseTimers.delete(event.action.id);
  }

  override onKeyDown(event: KeyDownEvent<SlotSettingsJson>): void {
    this.#pressedAt.set(event.action.id, Date.now());
  }

  override async onKeyUp(event: KeyUpEvent<SlotSettingsJson>): Promise<void> {
    const started = this.#pressedAt.get(event.action.id) ?? Date.now();
    this.#pressedAt.delete(event.action.id);
    const settings = normalizeSlotSettings(event.payload.settings);
    const project = coordinator.projectForSlot(event.payload.settings, coordinateIndex(event.action));
    try {
      if (!project) throw new Error("No Codex project is assigned to this slot");
      if (Date.now() - started >= coordinator.settings.holdMilliseconds) await coordinator.requestStatus(project);
      else await coordinator.openProject(project, settings.tapAction);
    } catch (error) {
      streamDeck.logger.warn(error instanceof Error ? error.message : "Project action failed");
      await event.action.showAlert();
    }
  }

  override async onPropertyInspectorDidAppear(event: PropertyInspectorDidAppearEvent<SlotSettingsJson>): Promise<void> {
    if (!event.action.isKey()) return;
    const settings = await event.action.getSettings<SlotSettingsJson>();
    await sendInspectorState(event.action, coordinator.projectForSlot(settings, coordinateIndex(event.action)));
  }

  override async onSendToPlugin(event: SendToPluginEvent<JsonValue, SlotSettingsJson>): Promise<void> {
    if (!event.action.isKey()) return;
    const settings = await event.action.getSettings<SlotSettingsJson>();
    await coordinator.handleInspectorMessage(
      event.action,
      event.payload,
      coordinator.projectForSlot(settings, coordinateIndex(event.action))
    );
  }

  #scheduleRender(): void {
    if (this.#renderScheduled) return;
    this.#renderScheduled = true;
    setTimeout(() => {
      this.#renderScheduled = false;
      void this.#renderAll();
    }, 100);
  }

  async #renderAll(): Promise<void> {
    const renders: Array<Promise<void>> = [];
    for (const instance of this.actions) {
      if (instance.isKey()) renders.push(instance.getSettings<SlotSettingsJson>().then((settings) => this.#render(instance, settings)));
    }
    await Promise.all(renders);
  }

  async #render(key: KeyAction<SlotSettingsJson>, raw: SlotSettingsJson): Promise<void> {
    const settings = normalizeSlotSettings(raw);
    const project = coordinator.projectForSlot(raw, coordinateIndex(key));
    const display = deriveDisplayState(
      project,
      coordinator.connection,
      coordinator.settings.freshMinutes,
      coordinator.settings.staleMinutes
    );
    const pulseEligible = requiresAttentionPulse(display);
    const becameUrgent = pulseEligible && this.#urgent.get(key.id) !== true;
    this.#urgent.set(key.id, pulseEligible);
    const svg = renderProjectSvg({
      project,
      connection: coordinator.connection,
      freshMinutes: coordinator.settings.freshMinutes,
      staleMinutes: coordinator.settings.staleMinutes,
      pinned: settings.slotMode === "pinned",
      showFreshness: settings.showFreshness,
      showAttentionCount: settings.showAttentionCount,
      displayNameOverride: settings.displayNameOverride
    });
    const previous = this.#rendered.get(key.id);
    if (previous?.svg === svg || (previous && Date.now() - previous.at < 500)) return;
    this.#rendered.set(key.id, { svg, at: Date.now() });
    await key.setImage(svgDataUrl(svg));
    await key.setTitle(undefined);
    if (becameUrgent) this.#pulseAttention(key, raw);
  }

  #pulseAttention(key: KeyAction<SlotSettingsJson>, raw: SlotSettingsJson): void {
    const previousTimer = this.#pulseTimers.get(key.id);
    if (previousTimer) clearTimeout(previousTimer);
    let step = 0;
    const tick = async (): Promise<void> => {
      const settings = normalizeSlotSettings(raw);
      const project = coordinator.projectForSlot(raw, coordinateIndex(key));
      const svg = renderProjectSvg({
        project,
        connection: coordinator.connection,
        freshMinutes: coordinator.settings.freshMinutes,
        staleMinutes: coordinator.settings.staleMinutes,
        pinned: settings.slotMode === "pinned",
        showFreshness: settings.showFreshness,
        showAttentionCount: settings.showAttentionCount,
        displayNameOverride: settings.displayNameOverride,
        attentionPulse: step % 2 === 0
      });
      await key.setImage(svgDataUrl(svg));
      step += 1;
      if (step < 6) this.#pulseTimers.set(key.id, setTimeout(() => void tick(), 600));
      else {
        this.#pulseTimers.delete(key.id);
        this.#rendered.delete(key.id);
        await this.#render(key, raw);
      }
    };
    void tick();
  }
}

abstract class UtilityAction<T extends TargetActionSettingsJson = TargetActionSettingsJson> extends SingletonAction<T> {
  abstract readonly label: string;
  abstract readonly icon: UtilityIcon;
  color = "#67E8F9";
  background = "#0B1D2A";

  override async onWillAppear(event: WillAppearEvent<T>): Promise<void> {
    if (event.action.isKey()) {
      await event.action.setImage(svgDataUrl(renderUtilitySvg(this.label, this.icon, this.color, this.background)));
      await event.action.setTitle(undefined);
    }
  }

  override async onPropertyInspectorDidAppear(event: PropertyInspectorDidAppearEvent<T>): Promise<void> {
    if (!event.action.isKey()) return;
    await sendInspectorState(event.action, await targetProject(event.action as KeyAction<TargetActionSettingsJson>));
  }

  override async onSendToPlugin(event: SendToPluginEvent<JsonValue, T>): Promise<void> {
    if (!event.action.isKey()) return;
    await coordinator.handleInspectorMessage(
      event.action,
      event.payload,
      await targetProject(event.action as KeyAction<TargetActionSettingsJson>)
    );
  }

  protected async failOrOk(event: KeyDownEvent<T>, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
      await event.action.showOk();
    } catch (error) {
      streamDeck.logger.warn(error instanceof Error ? error.message : `${this.label} failed`);
      await event.action.showAlert();
    }
  }
}

@action({ UUID: "com.codexstreamdeck.control.refresh" })
export class RefreshAllAction extends UtilityAction {
  readonly label = "Actualiser";
  readonly icon = "refresh" as const;

  override onKeyDown(event: KeyDownEvent<TargetActionSettingsJson>): Promise<void> {
    return this.failOrOk(event, () => coordinator.refresh());
  }
}

@action({ UUID: "com.codexstreamdeck.control.new-task" })
export class NewTaskAction extends UtilityAction {
  readonly label = "Nouvelle";
  readonly icon = "new" as const;
  override color = "#86EFAC";
  override background = "#0A281B";

  override onKeyDown(event: KeyDownEvent<TargetActionSettingsJson>): Promise<void> {
    const settings = normalizeTargetSettings(event.payload.settings);
    return this.failOrOk(event, () => coordinator.createTask(coordinator.projectAt(settings.slotIndex), settings.prompt));
  }
}

@action({ UUID: "com.codexstreamdeck.control.open-editor" })
export class OpenEditorAction extends UtilityAction {
  readonly label = "Code";
  readonly icon = "editor" as const;
  override color = "#93C5FD";
  override background = "#0B1D38";

  override onKeyDown(event: KeyDownEvent<TargetActionSettingsJson>): Promise<void> {
    const settings = normalizeTargetSettings(event.payload.settings);
    return this.failOrOk(event, () => coordinator.openProjectEditor(coordinator.projectAt(settings.slotIndex)));
  }
}

@action({ UUID: "com.codexstreamdeck.control.review" })
export class ReviewChangesAction extends UtilityAction {
  readonly label = "À relire";
  readonly icon = "review" as const;
  override color = "#C4B5FD";
  override background = "#21133B";

  override onKeyDown(event: KeyDownEvent<TargetActionSettingsJson>): Promise<void> {
    const settings = normalizeTargetSettings(event.payload.settings);
    return this.failOrOk(event, () => coordinator.reviewProject(coordinator.projectAt(settings.slotIndex)));
  }
}

@action({ UUID: "com.codexstreamdeck.control.interrupt" })
export class InterruptAction extends UtilityAction {
  readonly label = "Arrêter";
  readonly icon = "interrupt" as const;
  override color = "#FDA4AF";
  override background = "#3A111B";
  readonly #pressedAt = new Map<string, number>();

  override async onKeyDown(event: KeyDownEvent<TargetActionSettingsJson>): Promise<void> {
    this.#pressedAt.set(event.action.id, Date.now());
    await event.action.setImage(svgDataUrl(renderUtilitySvg("Maintenir", "hold", this.color, this.background)));
  }

  override async onKeyUp(event: KeyUpEvent<TargetActionSettingsJson>): Promise<void> {
    const elapsed = Date.now() - (this.#pressedAt.get(event.action.id) ?? Date.now());
    this.#pressedAt.delete(event.action.id);
    await event.action.setImage(svgDataUrl(renderUtilitySvg(this.label, this.icon, this.color, this.background)));
    if (elapsed < coordinator.settings.holdMilliseconds) {
      await event.action.showAlert();
      return;
    }
    try {
      const settings = normalizeTargetSettings(event.payload.settings);
      await coordinator.interruptProject(coordinator.projectAt(settings.slotIndex));
      await event.action.showOk();
    } catch {
      await event.action.showAlert();
    }
  }
}

@action({ UUID: "com.codexstreamdeck.control.health" })
export class HealthAction extends UtilityAction {
  readonly label = "Connexion";
  readonly icon = "health" as const;

  constructor() {
    super();
    coordinator.onChange(() => void this.#render());
  }

  override onKeyDown(event: KeyDownEvent<TargetActionSettingsJson>): Promise<void> {
    return this.failOrOk(event, () => coordinator.connection === "connected" ? coordinator.refresh() : coordinator.reconnect());
  }

  override async onWillAppear(event: WillAppearEvent<TargetActionSettingsJson>): Promise<void> {
    if (event.action.isKey()) await this.#renderKey(event.action);
  }

  async #render(): Promise<void> {
    const renders: Array<Promise<void>> = [];
    for (const instance of this.actions) if (instance.isKey()) renders.push(this.#renderKey(instance));
    await Promise.all(renders);
  }

  async #renderKey(key: KeyAction<TargetActionSettingsJson>): Promise<void> {
    const connected = coordinator.connection === "connected";
    const label = connected ? "Connecté" : "Hors ligne";
    await key.setImage(
      svgDataUrl(
        renderUtilitySvg(
          label,
          connected ? "health" : "warning",
          connected ? "#86EFAC" : "#FBBF24",
          connected ? "#0A281B" : "#33270B"
        )
      )
    );
    await key.setTitle(undefined);
  }
}

@action({ UUID: "com.codexstreamdeck.control.settings" })
export class CodexSettingsAction extends UtilityAction {
  readonly label = "Réglages";
  readonly icon = "settings" as const;
  override color = "#A5B4FC";
  override background = "#15182F";

  override async onKeyDown(event: KeyDownEvent<TargetActionSettingsJson>): Promise<void> {
    try {
      const { openCodexUrl } = await import("./native-launch.js");
      openCodexUrl("codex://settings");
      await event.action.showOk();
    } catch {
      await event.action.showAlert();
    }
  }
}

@action({ UUID: "com.codexstreamdeck.control.skills" })
export class CodexSkillsAction extends UtilityAction {
  readonly label = "Skills";
  readonly icon = "skills" as const;
  override color = "#F9A8D4";
  override background = "#33142A";

  override async onKeyDown(event: KeyDownEvent<TargetActionSettingsJson>): Promise<void> {
    try {
      const { openCodexUrl } = await import("./native-launch.js");
      openCodexUrl("codex://skills");
      await event.action.showOk();
    } catch {
      await event.action.showAlert();
    }
  }
}

@action({ UUID: "com.codexstreamdeck.control.model-preset" })
export class ModelPresetAction extends SingletonAction<ModelPresetSettingsJson> {
  constructor() {
    super();
    coordinator.onChange(() => void this.#renderAll());
  }

  override async onWillAppear(event: WillAppearEvent<ModelPresetSettingsJson>): Promise<void> {
    if (event.action.isKey()) await this.#renderKey(event.action, event.payload.settings);
  }

  override async onKeyDown(event: KeyDownEvent<ModelPresetSettingsJson>): Promise<void> {
    const alias = normalizeModelPresetSettings(event.payload.settings).modelAlias;
    try {
      await coordinator.selectModel(alias);
      await event.action.showOk();
    } catch (error) {
      streamDeck.logger.warn(error instanceof Error ? error.message : "Model preset failed");
      await event.action.showAlert();
    }
  }

  async #renderAll(): Promise<void> {
    await Promise.all([...this.actions].filter((item) => item.isKey()).map(async (item) => {
      const key = item as KeyAction<ModelPresetSettingsJson>;
      await this.#renderKey(key, await key.getSettings<ModelPresetSettingsJson>());
    }));
  }

  async #renderKey(key: KeyAction<ModelPresetSettingsJson>, raw: ModelPresetSettingsJson): Promise<void> {
    const alias = normalizeModelPresetSettings(raw).modelAlias;
    const model = alias === "auto" ? undefined : coordinator.modelForAlias(alias);
    const selected = alias === "auto" ? !coordinator.settings.presetModel : model?.model === coordinator.settings.presetModel;
    const available = alias === "auto" || !!model;
    const label = alias === "auto" ? "Auto" : available ? alias : `${alias} ?`;
    await key.setImage(svgDataUrl(renderUtilitySvg(label, alias === "auto" ? "auto" : available ? "model" : "warning",
      selected ? "#86EFAC" : available ? "#C4B5FD" : "#FBBF24",
      selected ? "#0A281B" : "#21133B")));
    await key.setTitle(undefined);
  }
}

@action({ UUID: "com.codexstreamdeck.control.effort-preset" })
export class EffortPresetAction extends SingletonAction<TargetActionSettingsJson> {
  constructor() {
    super();
    coordinator.onChange(() => void this.#renderAll());
  }

  override async onWillAppear(event: WillAppearEvent<TargetActionSettingsJson>): Promise<void> {
    if (event.action.isKey()) await this.#renderKey(event.action);
  }

  override async onKeyDown(event: KeyDownEvent<TargetActionSettingsJson>): Promise<void> {
    try {
      await coordinator.cycleEffort();
      await event.action.showOk();
    } catch {
      await event.action.showAlert();
    }
  }

  async #renderAll(): Promise<void> {
    await Promise.all([...this.actions].filter((item) => item.isKey()).map((item) => this.#renderKey(item as KeyAction<TargetActionSettingsJson>)));
  }

  async #renderKey(key: KeyAction<TargetActionSettingsJson>): Promise<void> {
    const effort = coordinator.settings.presetEffort || "auto";
    const labels: Record<string, string> = { auto: "Effort auto", low: "Léger", medium: "Moyen", high: "Élevé", xhigh: "Très élevé", max: "Max", ultra: "Ultra" };
    await key.setImage(svgDataUrl(renderUtilitySvg(labels[effort] ?? effort, "effort", "#FDE68A", "#33270B")));
    await key.setTitle(undefined);
  }
}
