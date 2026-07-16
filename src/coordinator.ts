import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import streamDeck, { type Action } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { CacheStore } from "./cache.js";
import { CodexAppServer, RpcError, turnNeedsHydration } from "./codex-app-server.js";
import type {
  CacheFile,
  CodexModel,
  CodexThread,
  CodexTurn,
  ConnectionState,
  ProjectState,
  ReasoningEffort,
  StatusEnvelope,
  StatusReport
} from "./domain.js";
import { DiagnosticLogger } from "./logger.js";
import {
  openCodexThread,
  openCodexUrl,
  openDirectory,
  openEditor,
  openNewCodexTask
} from "./native-launch.js";
import {
  installNotifyBridge,
  NotifyBridgeServer,
  type NotifyEvent
} from "./notify-bridge.js";
import { dataDirectory } from "./paths.js";
import { buildProjects, canonicalizeProject, isUnderway, projectDisplayName } from "./project-model.js";
import { modelForAlias, resolvePreset } from "./presets.js";
import {
  DEFAULT_GLOBAL_SETTINGS,
  normalizeGlobalSettings,
  normalizeSlotSettings,
  type GlobalSettings,
  type GlobalSettingsJson,
  type SlotSettings
} from "./settings.js";
import { STATUS_SCHEMA } from "./status-schema.js";
import {
  lastAgentMessage,
  normalizeRuntimeStatus,
  parseStatusMarker,
  parseStructuredStatus
} from "./status.js";

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.basename(moduleDirectory) === "bin"
  ? path.dirname(moduleDirectory)
  : path.resolve(moduleDirectory, "..", "com.codexstreamdeck.control.sdPlugin");

const STATUS_PROMPT = `STREAM_DECK_STATUS_REQUEST_V1
Return only a status object matching the supplied schema. Do not modify files, install dependencies, start services, commit, push, or request permissions. Use the current thread and quick read-only repository evidence. Do not claim a check passed unless it ran in this turn or the current thread contains unambiguous recent evidence; otherwise use not_run or unknown.`;

type ChangeListener = () => void;

interface TurnStartResponse {
  turn: CodexTurn;
}

interface ThreadStartResponse {
  thread: CodexThread;
}

interface ReviewStartResponse {
  turn: CodexTurn;
  reviewThreadId: string;
}

interface PiMessage {
  op?: string;
  slotIndex?: number;
}

export class Coordinator {
  readonly #directory = dataDirectory();
  readonly #logger = new DiagnosticLogger(path.join(this.#directory, "logs"), () => false);
  readonly #cacheStore = new CacheStore(this.#directory, this.#logger);
  readonly #client = new CodexAppServer(this.#logger);
  readonly #notify = new NotifyBridgeServer(this.#directory, this.#logger, (event) => this.#applyNotifyEvent(event));
  readonly #listeners = new Set<ChangeListener>();
  readonly #activeTurns = new Map<string, string>();
  readonly #pendingStatus = new Set<string>();
  readonly #approvalExpiredThreads = new Set<string>();
  readonly #invalidStatusThreads = new Set<string>();
  #cache: CacheFile = {
    schemaVersion: 1,
    threads: [],
    projects: [],
    reports: {},
    approvals: {},
    activity: {},
    handoffs: {}
  };
  #settings: GlobalSettings = { ...DEFAULT_GLOBAL_SETTINGS };
  #connection: ConnectionState = "starting";
  #projects: ProjectState[] = [];
  #allProjects: ProjectState[] = [];
  #threads: CodexThread[] = [];
  #models: CodexModel[] = [];
  #preloaded = false;
  #started = false;
  #connecting = false;
  #lastError = "";
  #codexVersion = "unknown";
  #effectiveCodexPath = "codex";
  #reconnectDelay = 1_000;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #refreshPromise: Promise<void> | undefined;
  #savePromise: Promise<void> = Promise.resolve();
  #statusQueue: Promise<unknown> = Promise.resolve();
  #dailyStatusDate = "";
  #dailyStatusCount = 0;

  constructor() {
    this.#client.on("notification", (method, params) => void this.#onNotification(method, params));
    this.#client.on("approvalAutoDeclined", (_method, params) => void this.#onApprovalDeclined(params));
    this.#client.on("exit", (error) => this.#onClientExit(error));
  }

  get settings(): GlobalSettings {
    return this.#settings;
  }

  get connection(): ConnectionState {
    return this.#connection;
  }

  get projects(): readonly ProjectState[] {
    return this.#projects;
  }

  get models(): readonly CodexModel[] {
    return this.#models;
  }

  selectedModel(): CodexModel | undefined {
    return this.#models.find((model) => model.model === this.#settings.presetModel);
  }

  modelForAlias(alias: "sol" | "terra" | "luna"): CodexModel | undefined {
    return modelForAlias(this.#models, alias);
  }

  async selectModel(alias: "auto" | "sol" | "terra" | "luna"): Promise<void> {
    const model = alias === "auto" ? undefined : this.modelForAlias(alias);
    if (alias !== "auto" && !model) throw new Error(`${alias.toUpperCase()} is not exposed by model/list`);
    const effort = model && this.#settings.presetEffort && !model.supportedReasoningEfforts.some(
      (entry) => entry.reasoningEffort === this.#settings.presetEffort
    ) ? model.defaultReasoningEffort : this.#settings.presetEffort;
    await this.#saveSettings({ presetModel: model?.model ?? "", presetEffort: effort });
  }

  async cycleEffort(): Promise<void> {
    const model = this.selectedModel();
    const supported = model?.supportedReasoningEfforts.map((entry) => entry.reasoningEffort)
      ?? (["low", "medium", "high", "xhigh"] as ReasoningEffort[]);
    if (!supported.length) throw new Error("No reasoning effort is exposed for this model");
    const current = this.#settings.presetEffort;
    const next = supported[(supported.indexOf(current as ReasoningEffort) + 1) % supported.length];
    await this.#saveSettings({ presetEffort: next ?? "" });
  }

  async clearPreset(): Promise<void> {
    await this.#saveSettings({ presetModel: "", presetEffort: "" });
  }

  async preload(): Promise<void> {
    if (this.#preloaded) return;
    await mkdir(this.#directory, { recursive: true });
    this.#cache = await this.#cacheStore.load();
    this.#threads = this.#cache.threads;
    this.#allProjects = this.#cache.projects.map((project) => ({
      ...project,
      runtimeStatus: { type: "not_loaded", activeFlags: [] },
      pluginTurnId: undefined,
      threads: project.threads.map((thread) => ({ ...thread, pluginTurnId: undefined }))
    }));
    this.#projects = this.#allProjects.filter((project) => isUnderway(project, this.#settings));
    this.#preloaded = true;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await this.preload();
    this.#started = true;
    const stored = await streamDeck.settings.getGlobalSettings<GlobalSettingsJson>();
    this.#settings = normalizeGlobalSettings(stored as Partial<GlobalSettings>);
    this.#projects = this.#allProjects.filter((project) => isUnderway(project, this.#settings));
    streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettingsJson>((event) => {
      const previousPath = this.#settings.codexPath;
      this.#settings = normalizeGlobalSettings(event.settings as Partial<GlobalSettings>);
      if (previousPath !== this.#settings.codexPath) void this.reconnect();
      else void this.#rebuildProjects();
      this.#schedulePoll();
      this.#emitChange();
    });
    if (this.#settings.notifyBridgeEnabled) await this.#notify.start().catch((error) => this.#recordError("Notify bridge failed", error));
    await this.#connect();
    this.#schedulePoll();
  }

  onChange(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  projectForSlot(settings: SlotSettings | undefined, fallbackIndex = 0): ProjectState | undefined {
    const slot = normalizeSlotSettings(settings);
    if (slot.slotMode === "pinned") {
      const pinned = this.#allProjects.find((project) =>
        (slot.pinnedThreadId && project.threads.some((thread) => thread.thread.id === slot.pinnedThreadId)) ||
        (slot.pinnedProjectRoot && samePath(project.projectRoot, slot.pinnedProjectRoot))
      );
      if (!pinned || !slot.pinnedThreadId || pinned.primaryThreadId === slot.pinnedThreadId) return pinned;
      const primary = pinned.threads.find((thread) => thread.thread.id === slot.pinnedThreadId);
      if (!primary) return pinned;
      return projectWithPrimary(pinned, primary);
    }
    const index = settings?.slotIndex === undefined ? fallbackIndex : slot.slotIndex;
    return this.#projects[index];
  }

  projectAt(index = 0): ProjectState | undefined {
    return this.#projects[Math.max(0, Math.min(31, Math.floor(index)))] ?? this.#projects[0];
  }

  async reconnect(): Promise<void> {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    await this.#client.stop();
    this.#connection = "starting";
    this.#emitChange();
    await this.#connect();
  }

  async refresh(): Promise<void> {
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#refreshPromise = this.#refreshInternal().finally(() => {
      this.#refreshPromise = undefined;
    });
    return this.#refreshPromise;
  }

  async openProject(project: ProjectState, action: Required<SlotSettings>["tapAction"] = "open_codex"): Promise<void> {
    if (action === "refresh_status") return this.requestStatus(project);
    if (action === "open_editor") return openEditor(this.#settings.editorCommand, this.#settings.editorArgs, project.projectRoot);
    if (action === "open_both") {
      openCodexThread(project.primaryThreadId);
      await openEditor(this.#settings.editorCommand, this.#settings.editorArgs, project.projectRoot);
      return;
    }
    openCodexThread(project.primaryThreadId);
  }

  requestStatus(project: ProjectState): Promise<void> {
    const activeTurn = this.#activeTurns.get(project.primaryThreadId);
    if (activeTurn) {
      this.#pendingStatus.add(project.primaryThreadId);
      this.#logger.info("Queued status refresh after active plugin turn", { thread: shortId(project.primaryThreadId) });
      return Promise.resolve();
    }
    if (project.runtimeStatus.type === "active") {
      return Promise.reject(new Error("This task is active outside the plugin; open it in Codex before refreshing status."));
    }
    const task = this.#statusQueue.then(() => this.#runStatusTurn(project));
    this.#statusQueue = task.catch(() => undefined);
    return task;
  }

  async createTask(project: ProjectState | undefined, prompt: string): Promise<void> {
    if (!project) throw new Error("No project is assigned to the selected slot");
    const cleanedPrompt = prompt.trim().slice(0, 16_000);
    const preset = this.#resolvedPreset();
    if ((!cleanedPrompt && !preset.active) || this.#settings.newTaskMode === "handoff" || !this.#client.connected) {
      if (preset.active) throw new Error("The active preset requires the connected plugin-owned task mode");
      openNewCodexTask(project.projectRoot, cleanedPrompt || undefined);
      return;
    }
    const started = await this.#client.request<ThreadStartResponse>("thread/start", {
      cwd: project.projectRoot,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      threadSource: "stream-deck",
      ...(preset.model ? { model: preset.model } : {}),
      ...(preset.effort ? { config: { model_reasoning_effort: preset.effort } } : {})
    });
    this.#threads.unshift(started.thread);
    await this.#rebuildProjects();
    if (!cleanedPrompt) {
      openCodexThread(started.thread.id);
      return;
    }
    const response = await this.#client.request<TurnStartResponse>("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: cleanedPrompt }],
      cwd: project.projectRoot,
      approvalPolicy: "never",
      sandboxPolicy: workspaceWriteSandbox(project.projectRoot),
      ...(preset.model ? { model: preset.model } : {}),
      ...(preset.effort ? { effort: preset.effort } : {})
    });
    this.#activeTurns.set(started.thread.id, response.turn.id);
    await this.#rebuildProjects();
    openCodexThread(started.thread.id);
  }

  async reviewProject(project: ProjectState | undefined): Promise<void> {
    if (!project) throw new Error("No project is assigned to the selected slot");
    await this.#client.request("thread/resume", {
      threadId: project.primaryThreadId,
      approvalPolicy: "never",
      sandbox: "read-only"
    });
    const response = await this.#client.request<ReviewStartResponse>("review/start", {
      threadId: project.primaryThreadId,
      target: { type: "uncommittedChanges" },
      delivery: "inline"
    });
    this.#activeTurns.set(response.reviewThreadId, response.turn.id);
    await this.#rebuildProjects();
    openCodexThread(response.reviewThreadId);
  }

  async interruptProject(project: ProjectState | undefined): Promise<void> {
    if (!project) throw new Error("No project is assigned to the selected slot");
    const turnId = this.#activeTurns.get(project.primaryThreadId);
    if (!turnId) throw new Error("Only plugin-owned active turns can be interrupted");
    await this.#client.request("turn/interrupt", { threadId: project.primaryThreadId, turnId });
  }

  async openProjectEditor(project: ProjectState | undefined): Promise<void> {
    if (!project) throw new Error("No project is assigned to the selected slot");
    await openEditor(this.#settings.editorCommand, this.#settings.editorArgs, project.projectRoot);
  }

  async clearStatus(project: ProjectState | undefined): Promise<void> {
    if (!project) return;
    delete this.#cache.reports[project.primaryThreadId];
    this.#invalidStatusThreads.add(project.primaryThreadId);
    await this.#rebuildProjects();
    this.#save();
  }

  async testCodexPath(): Promise<string> {
    this.#effectiveCodexPath = await resolveCodexPath(this.#settings.codexPath);
    const javascriptEntry = /\.m?js$/i.test(this.#effectiveCodexPath);
    const command = javascriptEntry ? process.execPath : this.#effectiveCodexPath;
    const { stdout, stderr } = await execFileAsync(command, [...(javascriptEntry ? [this.#effectiveCodexPath] : []), "--version"], {
      timeout: 8_000,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024
    });
    this.#codexVersion = (stdout || stderr).trim().slice(0, 120) || "Codex executable responded";
    return this.#codexVersion;
  }

  async testEditor(project?: ProjectState): Promise<string> {
    const target = project ?? this.#projects[0];
    if (!target) throw new Error("No project is available for the editor test");
    await this.openProjectEditor(target);
    return `Opened ${target.displayName}`;
  }

  inspectorState(project?: ProjectState): Record<string, JsonValue> {
    const bridge = this.#notify.health;
    return {
      type: "state",
      connection: this.#connection,
      codexVersion: this.#codexVersion,
      codexPath: this.#effectiveCodexPath,
      lastError: this.#lastError,
      projectCount: this.#projects.length,
      activeTurnCount: this.#activeTurns.size,
      presetModel: this.#settings.presetModel,
      presetEffort: this.#settings.presetEffort,
      models: this.#models.map((model) => ({
        model: model.model,
        displayName: model.displayName,
        defaultEffort: model.defaultReasoningEffort,
        efforts: model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort)
      })),
      dataDirectory: this.#directory,
      bridgeRunning: bridge.running,
      bridgeAccepted: bridge.accepted,
      bridgeRejected: bridge.rejected,
      ...(project
        ? {
            project: {
              id: project.projectId,
              name: project.displayName,
              root: project.projectRoot,
              threadId: project.primaryThreadId,
              runtime: project.runtimeStatus.type,
              workflow: project.report?.report.workflowStatus ?? "unknown",
              observedAt: project.report?.observedAt ?? ""
            }
          }
        : {})
    };
  }

  async handleInspectorMessage(action: Action, payload: JsonValue, project?: ProjectState): Promise<void> {
    const message = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as PiMessage) : {};
    try {
      let result = "Done";
      switch (message.op) {
        case "refreshAll":
          await this.refresh();
          result = "Project list refreshed";
          break;
        case "testCodex":
          result = await this.testCodexPath();
          break;
        case "installNotify": {
          const install = await installNotifyBridge(PLUGIN_ROOT, this.#directory);
          result = install.message;
          break;
        }
        case "openSettings":
          openCodexUrl("codex://settings");
          break;
        case "openSkills":
          openCodexUrl("codex://skills");
          break;
        case "openAgentsFile":
          await openEditor(this.#settings.editorCommand, this.#settings.editorArgs, path.join(PLUGIN_ROOT, "instructions"));
          break;
        case "openDiagnostics":
          await openDirectory(this.#directory);
          break;
        case "openThread":
          if (!project) throw new Error("No project is assigned to this slot");
          openCodexThread(project.primaryThreadId);
          break;
        case "refreshStatus":
          if (!project) throw new Error("No project is assigned to this slot");
          await this.requestStatus(project);
          result = "Status refreshed";
          break;
        case "clearStatus":
          await this.clearStatus(project);
          result = "Cached status cleared";
          break;
        case "testEditor":
          result = await this.testEditor(project);
          break;
        case "queryState":
        default:
          await streamDeck.ui.sendToPropertyInspector(this.inspectorState(project));
          return;
      }
      await streamDeck.ui.sendToPropertyInspector({ type: "result", ok: true, message: result });
      await streamDeck.ui.sendToPropertyInspector(this.inspectorState(project));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Operation failed";
      await streamDeck.ui.sendToPropertyInspector({ type: "result", ok: false, message: messageText.slice(0, 300) });
    }
  }

  async #connect(): Promise<void> {
    if (this.#connecting) return;
    this.#connecting = true;
    this.#connection = "starting";
    this.#emitChange();
    try {
      this.#effectiveCodexPath = await resolveCodexPath(this.#settings.codexPath);
      const initialization = await this.#client.start(this.#effectiveCodexPath);
      this.#codexVersion = typeof initialization.userAgent === "string" ? initialization.userAgent.slice(0, 120) : "connected";
      this.#connection = "connected";
      this.#lastError = "";
      this.#reconnectDelay = 1_000;
      await this.refresh();
    } catch (error) {
      this.#classifyConnectionError(error);
      this.#scheduleReconnect();
    } finally {
      this.#connecting = false;
      this.#emitChange();
    }
  }

  async #refreshInternal(): Promise<void> {
    await this.#notify.drainSpool();
    if (!this.#client.connected) {
      if (!this.#connecting) void this.#connect();
      return;
    }
    try {
      const response = await this.#client.listThreads(this.#settings.sourceKinds);
      const models = await this.#client.listModels().catch((error) => {
        this.#logger.warn("model/list unavailable; preset keys remain unavailable", {
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown"
        });
        return { data: this.#models, nextCursor: null };
      });
      this.#threads = response.data;
      this.#models = models.data.filter((model) => !model.hidden);
      this.#cache.threads = response.data;
      await this.#rebuildProjects();
      this.#connection = "connected";
      this.#save();
    } catch (error) {
      this.#recordError("Thread refresh failed", error);
      if (error instanceof RpcError && /auth|login/i.test(error.message)) this.#connection = "auth_required";
      else this.#connection = "degraded";
      this.#emitChange();
    }
  }

  #resolvedPreset(): { active: boolean; model?: string; effort?: ReasoningEffort } {
    return resolvePreset(this.#models, this.#settings.presetModel, this.#settings.presetEffort);
  }

  async #saveSettings(patch: Partial<GlobalSettings>): Promise<void> {
    this.#settings = normalizeGlobalSettings({ ...this.#settings, ...patch });
    await streamDeck.settings.setGlobalSettings(this.#settings as GlobalSettingsJson);
    this.#emitChange();
  }

  async #rebuildProjects(): Promise<void> {
    const now = Date.now();
    for (const [threadId, approval] of Object.entries(this.#cache.approvals)) {
      if (Date.parse(approval.expiresAt) <= now) {
        delete this.#cache.approvals[threadId];
        this.#approvalExpiredThreads.add(threadId);
      }
    }
    const projects = await buildProjects(this.#threads, this.#settings, {
      reports: this.#cache.reports,
      approvals: this.#cache.approvals,
      activeTurns: this.#activeTurns,
      handoffs: this.#cache.handoffs,
      now
    });
    for (const project of projects) {
      if (this.#approvalExpiredThreads.has(project.primaryThreadId)) {
        project.runtimeStatus = { type: "active", activeFlags: ["externalApprovalExpired"] };
      }
      if (this.#invalidStatusThreads.has(project.primaryThreadId)) delete project.report;
    }
    this.#allProjects = projects;
    this.#projects = projects.filter((project) => isUnderway(project, this.#settings, now));
    this.#cache.projects = projects;
    this.#emitChange();
  }

  async #runStatusTurn(project: ProjectState): Promise<void> {
    this.#consumeStatusQuota();
    await this.#client.request("thread/resume", { threadId: project.primaryThreadId });
    const response = await this.#client.request<TurnStartResponse>("turn/start", {
      threadId: project.primaryThreadId,
      input: [{ type: "text", text: STATUS_PROMPT }],
      cwd: project.projectRoot,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: STATUS_SCHEMA
    });
    this.#activeTurns.set(project.primaryThreadId, response.turn.id);
    await this.#rebuildProjects();
    try {
      let turn = await this.#client.waitForTurn(
        project.primaryThreadId,
        response.turn.id,
        this.#settings.statusTurnTimeoutSeconds * 1_000
      );
      if (turn.status !== "completed") throw new Error(turn.error?.message || `Status turn ${turn.status}`);
      if (turnNeedsHydration(turn)) {
        const hydrated = await this.#client.readTurn(project.primaryThreadId, response.turn.id);
        if (hydrated) turn = hydrated;
      }
      const output = lastAgentMessage(turn);
      const parsed = output ? parseStructuredStatus(output) : { error: "Status turn returned no final message" };
      if (!parsed.report) {
        this.#invalidStatusThreads.add(project.primaryThreadId);
        this.#logger.warn("Rejected invalid explicit status", { thread: shortId(project.primaryThreadId), error: parsed.error });
        throw new Error(parsed.error || "Status output was invalid");
      }
      this.#invalidStatusThreads.delete(project.primaryThreadId);
      this.#cache.reports[project.primaryThreadId] = this.#makeEnvelope(
        project,
        response.turn.id,
        "explicit_status_turn",
        parsed.report
      );
      await this.#setThreadGoal(project.primaryThreadId, parsed.report);
    } finally {
      this.#activeTurns.delete(project.primaryThreadId);
      await this.#rebuildProjects();
      this.#save();
    }
  }

  #makeEnvelope(
    project: ProjectState,
    turnId: string | null,
    source: StatusEnvelope["source"],
    report: StatusReport,
    observedAt = new Date().toISOString()
  ): StatusEnvelope {
    return {
      schemaVersion: 1,
      projectId: project.projectId,
      projectRoot: project.projectRoot,
      threadId: project.primaryThreadId,
      turnId,
      source,
      observedAt,
      runtimeStatus: project.runtimeStatus,
      report
    };
  }

  async #setThreadGoal(threadId: string, report: StatusReport): Promise<void> {
    const status = goalStatus(report.workflowStatus);
    if (!status) return;
    await this.#client.request("thread/goal/set", { threadId, objective: report.objective, status }).catch(() => undefined);
  }

  async #applyNotifyEvent(event: NotifyEvent): Promise<void> {
    this.#cache.activity[event.threadId] = event.observedAt;
    const currentThread = this.#threads.find((thread) => thread.id === event.threadId);
    const canonical = await canonicalizeProject(event.cwd, this.#settings.groupWorktrees);
    if (event.type === "approval-requested") {
      this.#cache.approvals[event.threadId] = {
        threadId: event.threadId,
        projectRoot: canonical.projectRoot,
        observedAt: event.observedAt,
        expiresAt: new Date(Date.parse(event.observedAt) + this.#settings.externalApprovalHoldMinutes * 60_000).toISOString(),
        source: "notify_approval"
      };
      this.#approvalExpiredThreads.delete(event.threadId);
    } else if (event.type === "agent-turn-complete") {
      delete this.#cache.approvals[event.threadId];
      delete this.#cache.handoffs[event.threadId];
      this.#approvalExpiredThreads.delete(event.threadId);
      if (event.lastAssistantMessage) {
        const parsed = parseStatusMarker(event.lastAssistantMessage);
        if (parsed.report) {
          this.#invalidStatusThreads.delete(event.threadId);
          this.#cache.reports[event.threadId] = {
            schemaVersion: 1,
            projectId: canonical.projectId,
            projectRoot: canonical.projectRoot,
            threadId: event.threadId,
            turnId: event.turnId || null,
            source: "notify_completion",
            observedAt: event.observedAt,
            runtimeStatus: normalizeRuntimeStatus(currentThread?.status),
            report: parsed.report
          };
        }
      }
    }
    await this.#rebuildProjects();
    this.#save();
    setTimeout(() => void this.refresh(), 250);
  }

  async #onNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (method === "thread/status/changed" && typeof params.threadId === "string") {
      const thread = this.#threads.find((item) => item.id === params.threadId);
      if (thread && params.status && typeof params.status === "object") thread.status = params.status as CodexThread["status"];
      const runtime = normalizeRuntimeStatus(thread?.status);
      if (runtime.type === "idle" || (runtime.type === "active" && !runtime.activeFlags.includes("waitingOnApproval"))) {
        delete this.#cache.approvals[params.threadId];
      }
      await this.#rebuildProjects();
      return;
    }
    if (method === "turn/started" && typeof params.threadId === "string") {
      const turn = params.turn as CodexTurn | undefined;
      if (turn?.id && this.#activeTurns.has(params.threadId)) this.#activeTurns.set(params.threadId, turn.id);
      await this.#rebuildProjects();
      return;
    }
    if (method === "turn/completed" && typeof params.threadId === "string") {
      const turn = params.turn as CodexTurn | undefined;
      const owned = this.#activeTurns.get(params.threadId);
      if (turn?.id && owned === turn.id) {
        this.#activeTurns.delete(params.threadId);
        const project = this.#projects.find((item) => item.primaryThreadId === params.threadId);
        const message = lastAgentMessage(turn);
        const parsed = message ? parseStatusMarker(message) : {};
        if (project && parsed.report) {
          this.#cache.reports[params.threadId] = this.#makeEnvelope(project, turn.id, "plugin_turn_completion", parsed.report);
        }
        if (turn.status === "failed") this.#cache.handoffs[params.threadId] = true;
        await this.#rebuildProjects();
        this.#save();
        if (this.#pendingStatus.delete(params.threadId) && project) void this.requestStatus(project);
      }
      return;
    }
    if (["thread/started", "thread/closed", "thread/archived", "thread/unarchived", "thread/deleted"].includes(method)) {
      setTimeout(() => void this.refresh(), 200);
    }
  }

  async #onApprovalDeclined(params: Record<string, unknown>): Promise<void> {
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    if (!threadId) return;
    this.#cache.handoffs[threadId] = true;
    this.#logger.warn("Auto-declined approval on plugin connection", { thread: shortId(threadId) });
    await this.#rebuildProjects();
    this.#save();
  }

  #onClientExit(error?: Error): void {
    if (this.#connection === "starting") return;
    this.#connection = "offline";
    this.#lastError = error?.message.slice(0, 300) ?? "Codex app-server disconnected";
    this.#emitChange();
    this.#scheduleReconnect();
  }

  #classifyConnectionError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    this.#lastError = message.slice(0, 300);
    if (code === "ENOENT" || code === "EACCES" || /not found|access is denied/i.test(message)) this.#connection = "setup";
    else if (/auth|login|unauthorized/i.test(message)) this.#connection = "auth_required";
    else if (error instanceof RpcError && /unknown method|invalid params|incompat/i.test(message)) this.#connection = "incompatible";
    else this.#connection = "offline";
    this.#recordError("Codex connection failed", error);
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer) return;
    const delay = this.#connection === "setup" ? 30_000 : this.#reconnectDelay;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, delay);
    this.#reconnectDelay = Math.min(60_000, Math.round(this.#reconnectDelay * 1.8));
  }

  #schedulePoll(): void {
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    const seconds = this.#projects.length ? this.#settings.metadataPollSeconds : this.#settings.backgroundPollSeconds;
    this.#pollTimer = setTimeout(() => {
      void this.refresh().finally(() => this.#schedulePoll());
    }, seconds * 1_000);
  }

  #consumeStatusQuota(): void {
    const date = new Date().toISOString().slice(0, 10);
    if (this.#dailyStatusDate !== date) {
      this.#dailyStatusDate = date;
      this.#dailyStatusCount = 0;
    }
    if (this.#dailyStatusCount >= this.#settings.maxStatusTurnsPerDay) throw new Error("Daily Stream Deck status-turn limit reached");
    this.#dailyStatusCount += 1;
  }

  #save(): void {
    this.#savePromise = this.#savePromise.then(() => this.#cacheStore.save(this.#cache)).catch((error) => {
      this.#recordError("Cache write failed", error);
    });
  }

  #recordError(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.#lastError = `${message}: ${detail}`.slice(0, 300);
    this.#logger.error(message, { error: detail.slice(0, 300) });
  }

  #emitChange(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A key renderer must not break coordinator reconciliation.
      }
    }
  }
}

function workspaceWriteSandbox(projectRoot: string): Record<string, unknown> {
  return {
    type: "workspaceWrite",
    writableRoots: [projectRoot],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function goalStatus(status: StatusReport["workflowStatus"]): string | undefined {
  switch (status) {
    case "working":
      return "active";
    case "needs_input":
    case "blocked":
    case "failed":
      return "blocked";
    case "ready_for_review":
    case "paused":
      return "paused";
    case "done":
      return "complete";
    default:
      return undefined;
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function projectWithPrimary(project: ProjectState, primary: ProjectState["threads"][number]): ProjectState {
  return {
    ...project,
    primaryThreadId: primary.thread.id,
    projectRoot: primary.projectRoot,
    displayName: projectDisplayName(primary.thread, primary.projectRoot),
    runtimeStatus: normalizeRuntimeStatus(primary.thread.status),
    handoff: !!primary.handoff,
    ...(primary.report ? { report: primary.report } : { report: undefined }),
    ...(primary.externalApproval ? { externalApproval: primary.externalApproval } : { externalApproval: undefined }),
    ...(primary.pluginTurnId ? { pluginTurnId: primary.pluginTurnId } : { pluginTurnId: undefined })
  };
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

async function resolveCodexPath(configuredPath: string): Promise<string> {
  if (configuredPath !== "codex" || process.platform !== "win32") return configuredPath;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return configuredPath;
  const root = path.join(localAppData, "OpenAI", "Codex", "bin");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, "codex.exe"));
    const available = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const info = await stat(candidate);
          return info.isFile() ? { candidate, modified: info.mtimeMs } : undefined;
        } catch {
          return undefined;
        }
      })
    );
    return available
      .filter((entry): entry is { candidate: string; modified: number } => !!entry)
      .sort((left, right) => right.modified - left.modified)[0]?.candidate ?? configuredPath;
  } catch {
    return configuredPath;
  }
}

export const coordinator = new Coordinator();
