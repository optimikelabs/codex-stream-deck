import Ajv2020 from "ajv/dist/2020.js";

import type {
  ConnectionState,
  DisplayState,
  FreshnessState,
  ProjectState,
  RuntimeStatus,
  StatusReport
} from "./domain.js";
import { STATUS_SCHEMA } from "./status-schema.js";

const MAX_MARKER_BYTES = 32 * 1024;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile<StatusReport>(STATUS_SCHEMA);

export interface StatusParseResult {
  report?: StatusReport;
  error?: string;
}

export function validateStatusReport(value: unknown): StatusParseResult {
  if (validate(value)) return { report: value };
  return { error: ajv.errorsText(validate.errors, { separator: "; " }).slice(0, 500) };
}

export function parseStructuredStatus(text: string): StatusParseResult {
  if (Buffer.byteLength(text, "utf8") > MAX_MARKER_BYTES) return { error: "Status output exceeds 32 KiB" };
  try {
    return validateStatusReport(JSON.parse(text.trim()));
  } catch {
    return { error: "Status output is not valid JSON" };
  }
}

export function parseStatusMarker(message: string): StatusParseResult {
  if (Buffer.byteLength(message, "utf8") > 256 * 1024) return { error: "Assistant message exceeds 256 KiB" };
  const pattern = /<!--\s*codex-stream-deck-status\s*\r?\n([^\r\n]+)\r?\n?-->/g;
  let last: string | undefined;
  for (const match of message.matchAll(pattern)) last = match[1];
  if (!last) return { error: "No codex-stream-deck-status marker found" };
  if (Buffer.byteLength(last, "utf8") > MAX_MARKER_BYTES) return { error: "Status marker exceeds 32 KiB" };
  try {
    return validateStatusReport(JSON.parse(last));
  } catch {
    return { error: "Status marker contains invalid JSON" };
  }
}

export function normalizeRuntimeStatus(status: { type?: string; activeFlags?: string[] } | undefined): RuntimeStatus {
  const flags = Array.isArray(status?.activeFlags) ? status.activeFlags.filter((flag) => typeof flag === "string") : [];
  switch (status?.type) {
    case "notLoaded":
    case "not_loaded":
      return { type: "not_loaded", activeFlags: flags };
    case "idle":
      return { type: "idle", activeFlags: flags };
    case "active":
      return { type: "active", activeFlags: flags };
    case "systemError":
    case "system_error":
      return { type: "system_error", activeFlags: flags };
    default:
      return { type: "unknown", activeFlags: flags };
  }
}

export function freshnessFor(observedAt: string | undefined, freshMinutes: number, staleMinutes: number, now = Date.now()): FreshnessState {
  if (!observedAt) return "stale";
  const ageMinutes = (now - Date.parse(observedAt)) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes >= staleMinutes) return "stale";
  if (ageMinutes >= freshMinutes) return "aging";
  return "fresh";
}

export function formatAge(observedAt: string | undefined, now = Date.now()): string {
  if (!observedAt) return "stale";
  const milliseconds = Math.max(0, now - Date.parse(observedAt));
  if (!Number.isFinite(milliseconds)) return "stale";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const state = (
  label: string,
  glyph: string,
  color: string,
  background: string,
  urgent = false,
  stale = false
): DisplayState => ({ label, glyph, color, background, urgent, stale });

export function deriveDisplayState(
  project: ProjectState | undefined,
  connection: ConnectionState,
  freshMinutes: number,
  staleMinutes: number,
  now = Date.now()
): DisplayState {
  if (connection === "setup") return state("CONFIG", "⚙", "#FBBF24", "#33270B", true);
  if (connection === "auth_required") return state("CONNEXION", "◆", "#FBBF24", "#33270B", true);
  if (connection === "offline") return state("HORS LIGNE", "↯", "#D1D5DB", "#20242B", true, true);
  if (connection === "incompatible") return state("INCOMPAT", "!", "#FB7185", "#3B1119", true);
  if (!project) return state(connection === "starting" ? "DÉMARRAGE" : "AUCUNE", "·", "#9CA3AF", "#17191D");

  const freshness = freshnessFor(project.report?.observedAt, freshMinutes, staleMinutes, now);
  const stale = freshness === "stale";
  const workflow = project.report?.report.workflowStatus ?? "unknown";
  if (project.runtimeStatus.type === "system_error") return state("ERREUR", "×", "#FDA4AF", "#3B1119", true, stale);
  if (workflow === "failed") return state("ÉCHEC", "×", "#FDA4AF", "#3B1119", true, stale);
  if (project.externalApproval || project.runtimeStatus.activeFlags.includes("waitingOnApproval"))
    return state("À VALIDER", "!", "#FDE68A", "#3B2A0B", true, stale);
  if (project.handoff) return state("DANS CODEX", "↗", "#FDE68A", "#33270B", true, stale);
  if (project.pluginTurnId) return state("ANALYSE", "▶", "#93C5FD", "#102A43", false, stale);
  if (project.runtimeStatus.activeFlags.includes("waitingOnUserInput") || workflow === "needs_input")
    return state("RÉPONSE", "?", "#FDE68A", "#33270B", true, stale);
  if (workflow === "blocked") return state("BLOQUÉ", "■", "#FDBA74", "#3B2010", true, stale);
  if (workflow === "ready_for_review") return state("À RELIRE", "◉", "#C4B5FD", "#241A44", false, stale);
  if (workflow === "done") return state("TERMINÉ", "✓", "#86EFAC", "#12301E", false, stale);
  if (workflow === "paused") return state("PAUSE", "Ⅱ", "#D1D5DB", "#24272D", false, stale);
  if (project.runtimeStatus.type === "active") return state("ACTIF ?", "▶", "#93C5FD", "#102A43", false, stale);
  if (workflow === "working") return state("EN COURS", "▶", "#93C5FD", "#102A43", false, stale);
  return state("À VÉRIFIER", "?", "#D1D5DB", "#20242B", false, true);
}

export function requiresAttentionPulse(display: DisplayState): boolean {
  return ["À VALIDER", "RÉPONSE", "BLOQUÉ", "ÉCHEC", "ERREUR"].includes(display.label);
}

export function lastAgentMessage(turn: { items?: Array<{ type?: string; text?: unknown }> }): string | undefined {
  const messages = (turn.items ?? []).filter((item) => item.type === "agentMessage" && typeof item.text === "string");
  return messages.length ? (messages.at(-1)?.text as string) : undefined;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, "$1[REDACTED]");
}
