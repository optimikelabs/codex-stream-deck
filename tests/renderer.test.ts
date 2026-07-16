import { describe, expect, it } from "vitest";

import { escapeXml, renderProjectSvg, renderUtilitySvg, splitProjectName, svgDataUrl } from "../src/renderer.js";

describe("key renderer", () => {
  it("escapes hostile SVG content", () => {
    const hostile = '<script>alert("x")</script>&';
    expect(escapeXml(hostile)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;");
    const svg = renderProjectSvg({
      connection: "connected",
      freshMinutes: 15,
      staleMinutes: 120,
      displayNameOverride: hostile
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("constrains project names to two short lines", () => {
    const [first, second] = splitProjectName("an-extremely-long-project-name");
    expect(first.length).toBeLessThanOrEqual(15);
    expect(second.length).toBeLessThanOrEqual(15);
  });

  it("encodes generated SVG as a Stream Deck image data URL", () => {
    const svg = renderUtilitySvg("Refresh", "refresh");
    const url = svgDataUrl(svg);
    expect(url).toMatch(/^data:image\/svg\+xml,/);
    expect(url).toContain("%3Csvg");
    expect(decodeURIComponent(url.slice("data:image/svg+xml,".length))).toBe(svg);
  });

  it("renders project names and workflow labels directly into the key artwork", () => {
    const svg = renderProjectSvg({
      connection: "connected",
      freshMinutes: 15,
      staleMinutes: 120,
      displayNameOverride: "Status Dashboard"
    });
    expect(svg).toContain("Status");
    expect(svg).toContain("Dashboard");
    expect(svg).toContain("AUCUNE");
  });

  it("uses an explicit status action label for stale projects", () => {
    const svg = renderProjectSvg({
      connection: "connected",
      freshMinutes: 15,
      staleMinutes: 120,
      project: {
        projectId: "sha256:abc",
        projectRoot: "C:\\Codex\\am",
        identityAnchor: "C:\\Codex\\am",
        displayName: "Find social posting outlier",
        threads: [],
        primaryThreadId: "thread-1",
        runtimeStatus: { type: "idle", activeFlags: [] },
        handoff: false,
        attentionCount: 0,
        recencyAt: 1
      }
    });
    expect(svg).toContain("MAINTENIR");
  });

  it("renders a prominent but optional attention pulse", () => {
    const svg = renderProjectSvg({
      connection: "auth_required",
      freshMinutes: 15,
      staleMinutes: 120,
      attentionPulse: true
    });
    expect(svg).toContain('stroke-width="6"');
  });
});
