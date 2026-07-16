import { describe, expect, it } from "vitest";

import type { ProjectState, StatusEnvelope, StatusReport } from "../src/domain.js";
import { deriveDisplayState, parseStatusMarker, parseStructuredStatus, requiresAttentionPulse } from "../src/status.js";

const report: StatusReport = {
  version: 1,
  workflowStatus: "ready_for_review",
  objective: "Build the plugin",
  headline: "Ready for review",
  summary: "The implementation is complete and tests pass.",
  completed: ["Implemented status rendering"],
  next: ["Review the diff"],
  blockers: [],
  attention: "normal",
  tests: { state: "passed", summary: "Unit tests passed." }
};

function project(envelope?: StatusEnvelope): ProjectState {
  return {
    projectId: "sha256:abc",
    projectRoot: "C:\\repo",
    identityAnchor: "C:\\repo\\.git",
    displayName: "repo",
    threads: [],
    primaryThreadId: "019abc",
    runtimeStatus: { type: "not_loaded", activeFlags: [] },
    handoff: false,
    attentionCount: 0,
    recencyAt: 1_700_000_000,
    ...(envelope ? { report: envelope } : {})
  };
}

describe("status parsing", () => {
  it("extracts the last valid passive marker", () => {
    const marker = `<!-- codex-stream-deck-status\n${JSON.stringify(report)}\n-->`;
    expect(parseStatusMarker(`Human summary.\n${marker}`).report).toEqual(report);
  });

  it("rejects malformed or schema-invalid output", () => {
    expect(parseStructuredStatus("not json").report).toBeUndefined();
    expect(parseStructuredStatus(JSON.stringify({ ...report, workflowStatus: "invented" })).report).toBeUndefined();
  });
});

describe("display precedence", () => {
  it("never treats not-loaded runtime as done without workflow evidence", () => {
    expect(deriveDisplayState(project(), "connected", 15, 120).label).toBe("À VÉRIFIER");
  });

  it("uses workflow evidence independently from runtime state", () => {
    const envelope: StatusEnvelope = {
      schemaVersion: 1,
      projectId: "sha256:abc",
      projectRoot: "C:\\repo",
      threadId: "019abc",
      turnId: null,
      source: "notify_completion",
      observedAt: new Date().toISOString(),
      runtimeStatus: { type: "not_loaded", activeFlags: [] },
      report: { ...report, workflowStatus: "done" }
    };
    expect(deriveDisplayState(project(envelope), "connected", 15, 120).label).toBe("TERMINÉ");
  });

  it("puts authoritative approval above active work", () => {
    const value = project();
    value.pluginTurnId = "turn";
    value.runtimeStatus = { type: "active", activeFlags: ["waitingOnApproval"] };
    expect(deriveDisplayState(value, "connected", 15, 120).label).toBe("À VALIDER");
  });

  it("pulses only for task states that require attention", () => {
    expect(requiresAttentionPulse(deriveDisplayState(undefined, "offline", 15, 120))).toBe(false);
    const value = project();
    value.runtimeStatus = { type: "active", activeFlags: ["waitingOnUserInput"] };
    expect(requiresAttentionPulse(deriveDisplayState(value, "connected", 15, 120))).toBe(true);
  });
});
