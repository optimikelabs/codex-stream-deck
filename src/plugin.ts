import streamDeck from "@elgato/streamdeck";

import {
  CodexSettingsAction,
  CodexSkillsAction,
  EffortPresetAction,
  HealthAction,
  InterruptAction,
  NewTaskAction,
  ModelPresetAction,
  OpenEditorAction,
  ProjectSlotAction,
  RefreshAllAction,
  ReviewChangesAction
} from "./actions.js";
import { coordinator } from "./coordinator.js";

await coordinator.preload();

streamDeck.actions.registerAction(new ProjectSlotAction());
streamDeck.actions.registerAction(new RefreshAllAction());
streamDeck.actions.registerAction(new NewTaskAction());
streamDeck.actions.registerAction(new OpenEditorAction());
streamDeck.actions.registerAction(new ReviewChangesAction());
streamDeck.actions.registerAction(new InterruptAction());
streamDeck.actions.registerAction(new HealthAction());
streamDeck.actions.registerAction(new CodexSettingsAction());
streamDeck.actions.registerAction(new CodexSkillsAction());
streamDeck.actions.registerAction(new ModelPresetAction());
streamDeck.actions.registerAction(new EffortPresetAction());

streamDeck.system.onSystemDidWakeUp(() => void coordinator.reconnect());

await streamDeck.connect();
await coordinator.start();
