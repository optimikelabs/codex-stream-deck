import { describe, expect, it } from "vitest";

import { turnNeedsHydration } from "../src/codex-app-server.js";

describe("turn hydration", () => {
  it("hydrates completion notifications whose items were not loaded", () => {
    expect(turnNeedsHydration({ id: "turn-1", status: "completed", items: [], itemsView: "notLoaded" })).toBe(true);
  });

  it("keeps a completed turn that already contains its final message", () => {
    expect(
      turnNeedsHydration({
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "final" }]
      })
    ).toBe(false);
  });
});
