export type ConnectionState =
  | "connected"
  | "starting"
  | "offline"
  | "auth_required"
  | "incompatible"
  | "degraded"
  | "setup";

export type RuntimeState = "not_loaded" | "idle" | "active" | "system_error" | "unknown";
export type WorkflowStatus =
  | "working"
  | "needs_input"
  | "blocked"
  | "ready_for_review"
  | "done"
  | "paused"
  | "failed"
  | "unknown";
export type VerificationState = "not_run" | "running" | "passed" | "failed" | "unknown";
export type FreshnessState = "fresh" | "aging" | "stale";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: Array<{
    reasoningEffort: ReasoningEffort;
    description: string;
  }>;
}

export interface RuntimeStatus {
  type: RuntimeState;
  activeFlags: string[];
}

export interface StatusReport {
  version: 1;
  workflowStatus: WorkflowStatus;
  objective: string;
  headline: string;
  summary: string;
  completed: string[];
  next: string[];
  blockers: string[];
  attention: "none" | "normal" | "urgent";
  tests: { state: VerificationState; summary: string };
}

export interface StatusEnvelope {
  schemaVersion: 1;
  projectId: string;
  projectRoot: string;
  threadId: string;
  turnId: string | null;
  source: "explicit_status_turn" | "notify_completion" | "plugin_turn_completion";
  observedAt: string;
  runtimeStatus: RuntimeStatus;
  report: StatusReport;
}

export interface ExternalApproval {
  threadId: string;
  projectRoot: string;
  observedAt: string;
  expiresAt: string;
  source: "notify_approval";
}

export interface CodexThread {
  id: string;
  preview: string;
  name: string | null;
  cwd: string;
  ephemeral: boolean;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  status: { type: string; activeFlags?: string[] };
  source: string | Record<string, unknown>;
  parentThreadId?: string | null;
  turns?: CodexTurn[];
}

export interface CodexTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress" | string;
  items: CodexThreadItem[];
  itemsView?: "notLoaded" | string;
  error?: { message?: string } | null;
}

export type CodexThreadItem =
  | { type: "agentMessage"; id?: string; text: string }
  | { type: string; [key: string]: unknown };

export interface ThreadState {
  thread: CodexThread;
  projectId: string;
  projectRoot: string;
  identityAnchor: string;
  report?: StatusEnvelope | undefined;
  externalApproval?: ExternalApproval | undefined;
  pluginTurnId?: string | undefined;
  handoff?: boolean | undefined;
}

export interface ProjectState {
  projectId: string;
  projectRoot: string;
  identityAnchor: string;
  displayName: string;
  threads: ThreadState[];
  primaryThreadId: string;
  runtimeStatus: RuntimeStatus;
  report?: StatusEnvelope | undefined;
  externalApproval?: ExternalApproval | undefined;
  pluginTurnId?: string | undefined;
  handoff: boolean;
  attentionCount: number;
  recencyAt: number;
}

export interface DisplayState {
  label: string;
  glyph: string;
  color: string;
  background: string;
  urgent: boolean;
  stale: boolean;
}

export interface CacheFile {
  schemaVersion: 1;
  threads: CodexThread[];
  projects: ProjectState[];
  reports: Record<string, StatusEnvelope>;
  approvals: Record<string, ExternalApproval>;
  activity: Record<string, string>;
  handoffs: Record<string, boolean>;
}
