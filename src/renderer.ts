import type { ConnectionState, ProjectState } from "./domain.js";
import { deriveDisplayState, formatAge } from "./status.js";

export type UtilityIcon =
  | "refresh"
  | "new"
  | "editor"
  | "review"
  | "interrupt"
  | "health"
  | "settings"
  | "skills"
  | "model"
  | "effort"
  | "auto"
  | "hold"
  | "warning";

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
    return entities[character] ?? "";
  });
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function splitProjectName(name: string, width = 15): [string, string] {
  const clean = name.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
  if (clean.length <= width) return [clean, ""];
  const candidate = clean.slice(0, width + 1);
  const breakAt = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("-"), candidate.lastIndexOf("_"));
  const firstEnd = breakAt >= 4 ? breakAt : width;
  const first = clean.slice(0, firstEnd).trim();
  const rest = clean.slice(firstEnd).replace(/^[-_\s]+/, "");
  const second = rest.length > width ? `${rest.slice(0, width - 1)}\u2026` : rest;
  return [first, second];
}

export interface RenderOptions {
  project?: ProjectState | undefined;
  connection: ConnectionState;
  freshMinutes: number;
  staleMinutes: number;
  pinned?: boolean;
  showFreshness?: boolean;
  showAttentionCount?: boolean;
  displayNameOverride?: string;
  attentionPulse?: boolean;
  now?: number;
}

function statusIcon(label: string, color: string): string {
  const stroke = `fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"`;
  switch (label) {
    case "TERMINÉ":
      return `<path d="m20 27 6 6 12-14" ${stroke}/>`;
    case "ANALYSE":
    case "EN COURS":
    case "ACTIF ?":
      return `<path d="m23 18 16 9-16 9z" fill="${color}"/>`;
    case "À RELIRE":
      return `<path d="M17 27s5-8 12-8 12 8 12 8-5 8-12 8-12-8-12-8Z" ${stroke}/><circle cx="29" cy="27" r="3" fill="${color}"/>`;
    case "ÉCHEC":
    case "ERREUR":
    case "INCOMPAT":
    case "BLOQUÉ":
      return `<path d="m20 19 18 17m0-17L20 36" ${stroke}/>`;
    case "PAUSE":
      return `<path d="M23 19v16m12-16v16" ${stroke}/>`;
    case "À VALIDER":
    case "RÉPONSE":
    case "DANS CODEX":
    case "CONFIG":
    case "CONNEXION":
      return `<path d="M29 18v12" ${stroke}/><circle cx="29" cy="36" r="2.5" fill="${color}"/>`;
    case "HORS LIGNE":
      return `<path d="M18 25c6-6 16-6 22 0M22 30c4-4 10-4 14 0M29 36h.1M18 18l22 20" ${stroke}/>`;
    default:
      return `<circle cx="29" cy="27" r="9" ${stroke}/><circle cx="29" cy="27" r="2.5" fill="${color}"/>`;
  }
}

function utilityIconSvg(icon: UtilityIcon, color: string): string {
  const stroke = `fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"`;
  switch (icon) {
    case "refresh":
      return `<path d="M91 43a29 29 0 1 0 5 26" ${stroke}/><path d="M91 27v18H73" ${stroke}/>`;
    case "new":
      return `<path d="M72 31v52M46 57h52" ${stroke}/>`;
    case "editor":
      return `<path d="m55 38-19 19 19 19m34-38 19 19-19 19M81 31 63 83" ${stroke}/>`;
    case "review":
      return `<path d="M30 57s15-22 42-22 42 22 42 22-15 22-42 22S30 57 30 57Z" ${stroke}/><circle cx="72" cy="57" r="10" ${stroke}/>`;
    case "interrupt":
      return `<rect x="47" y="32" width="50" height="50" rx="9" fill="${color}"/><path d="M39 25h15M32 32v15m73-22H90m22 7v15M39 89h15m-22-7V67m73 22H90m22-7V67" ${stroke}/>`;
    case "health":
      return `<circle cx="72" cy="57" r="31" ${stroke}/><path d="m53 58 13 13 27-29" ${stroke}/>`;
    case "settings":
      return `<circle cx="72" cy="57" r="14" ${stroke}/><path d="M72 23v10m0 48v10M38 57h10m48 0h10M48 33l7 7m34 34 7 7m0-48-7 7M55 74l-7 7" ${stroke}/>`;
    case "skills":
      return `<path d="m72 23 9 22 22 9-22 9-9 22-9-22-22-9 22-9z" ${stroke}/>`;
    case "model":
      return `<path d="M39 82V34h16l17 24 17-24h16v48M53 82V57m38 25V57" ${stroke}/>`;
    case "effort":
      return `<path d="M35 83h74M43 75l18-22 14 12 25-32" ${stroke}/><path d="M86 33h14v14" ${stroke}/>`;
    case "auto":
      return `<path d="M42 57a30 30 0 0 1 51-21l9 9M102 32v13H89M102 57a30 30 0 0 1-51 21l-9-9M42 82V69h13" ${stroke}/>`;
    case "hold":
      return `<circle cx="72" cy="57" r="34" ${stroke}/><rect x="57" y="42" width="30" height="30" rx="5" fill="${color}"/>`;
    case "warning":
      return `<path d="m72 25 40 66H32z" ${stroke}/><path d="M72 47v20" ${stroke}/><circle cx="72" cy="78" r="3.5" fill="${color}"/>`;
  }
}

export function renderProjectSvg(options: RenderOptions): string {
  const now = options.now ?? Date.now();
  const display = deriveDisplayState(options.project, options.connection, options.freshMinutes, options.staleMinutes, now);
  const projectName = options.displayNameOverride || options.project?.displayName || "Codex";
  const [line1, line2] = splitProjectName(projectName);
  const attention = options.project?.attentionCount ?? 0;
  const count = options.showAttentionCount !== false && attention > 0 ? String(Math.min(99, attention)) : "";
  const age = options.showFreshness === false ? "" : formatAge(options.project?.report?.observedAt, now);
  const footer = !options.project
    ? "EMPLACEMENT LIBRE"
    : !age
      ? ""
      : age === "stale"
        ? "MAINTENIR"
        : `MAJ ${age.toUpperCase()}`;
  const pulse = options.attentionPulse
    ? `<rect x="2" y="2" width="140" height="140" rx="18" fill="none" stroke="${display.color}" stroke-width="6" opacity=".95"/>`
    : "";
  const pin = options.pinned
    ? `<path d="M116 5h22v22z" fill="${display.color}"/><circle cx="128" cy="15" r="3" fill="#080B12"/>`
    : "";
  const attentionBadge = count
    ? `<circle cx="120" cy="27" r="14" fill="#F43F5E"/><text x="120" y="32" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" font-weight="800" fill="#FFFFFF">${count}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${display.background}"/>
      <stop offset=".58" stop-color="#0B101A"/>
      <stop offset="1" stop-color="#07090E"/>
    </linearGradient>
  </defs>
  <rect width="144" height="144" rx="19" fill="#05070B"/>
  <rect x="3" y="3" width="138" height="138" rx="17" fill="url(#bg)" stroke="${display.color}" stroke-opacity=".34" stroke-width="2"/>
  ${pulse}
  <rect x="8" y="11" width="96" height="32" rx="16" fill="${display.color}" opacity=".11"/>
  ${statusIcon(display.label, display.color)}
  <text x="48" y="32" font-family="Arial, sans-serif" font-size="11" font-weight="800" letter-spacing=".6" fill="${display.color}">${escapeXml(display.label.slice(0, 10))}</text>
  ${pin}
  ${attentionBadge}
  <text x="72" y="78" text-anchor="middle" font-family="Arial, sans-serif" font-size="15.5" font-weight="700" fill="#FFFFFF">${escapeXml(line1)}</text>
  <text x="72" y="99" text-anchor="middle" font-family="Arial, sans-serif" font-size="15.5" font-weight="700" fill="#FFFFFF">${escapeXml(line2)}</text>
  <text x="72" y="126" text-anchor="middle" font-family="Arial, sans-serif" font-size="${footer.length > 14 ? "11.5" : "13"}" font-weight="800" letter-spacing=".35" fill="#E7ECF4">${escapeXml(footer)}</text>
  <rect x="5" y="135" width="134" height="4" rx="2" fill="${display.color}"/>
</svg>`;
}

export function renderUtilitySvg(
  label: string,
  icon: UtilityIcon,
  color = "#67E8F9",
  background = "#0B1D2A"
): string {
  const safeLabel = label.toUpperCase().slice(0, 12);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <defs>
    <linearGradient id="utility-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${background}"/>
      <stop offset=".65" stop-color="#0A0E16"/>
      <stop offset="1" stop-color="#06080C"/>
    </linearGradient>
  </defs>
  <rect width="144" height="144" rx="19" fill="#05070B"/>
  <rect x="3" y="3" width="138" height="138" rx="17" fill="url(#utility-bg)" stroke="${color}" stroke-opacity=".35" stroke-width="2"/>
  <rect x="20" y="15" width="104" height="84" rx="23" fill="${color}" opacity=".08"/>
  ${utilityIconSvg(icon, color)}
  <text x="72" y="122" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" font-weight="800" letter-spacing=".7" fill="#FFFFFF">${escapeXml(safeLabel)}</text>
  <rect x="39" y="134" width="66" height="4" rx="2" fill="${color}"/>
</svg>`;
}

export function renderModelPresetSvg(
  alias: "sol" | "terra" | "luna",
  selected: boolean,
  available: boolean
): string {
  const accent = selected ? "#86EFAC" : available ? "#A5B4FC" : "#64748B";
  const opacity = available ? 1 : 0.32;
  const art = alias === "sol"
    ? `<g opacity="${opacity}">
        <g stroke="#FDBA2D" stroke-width="7" stroke-linecap="round">
          <path d="M72 18v13M72 113v13M18 72h13M113 72h13M34 34l10 10M100 100l10 10M110 34l-10 10M44 100l-10 10"/>
        </g>
        <circle cx="72" cy="72" r="31" fill="url(#sun)"/>
        <circle cx="62" cy="61" r="9" fill="#FFF7C2" opacity=".34"/>
      </g>`
    : alias === "terra"
      ? `<g opacity="${opacity}">
          <circle cx="72" cy="72" r="45" fill="url(#ocean)" stroke="#60A5FA" stroke-width="3"/>
          <path d="M43 45c9-10 22-17 36-17l7 10-10 8-4 12-15 4-12-7zM88 54l16 5 8 13-9 8-2 17-15 14-12-8 3-17-10-9 7-13zM40 79l12 4 8 15-8 11c-10-8-17-18-20-30z" fill="#55C878"/>
          <path d="M42 54c13 8 25 11 43 8M38 88c19-4 42-1 66 9" fill="none" stroke="#DBF4FF" stroke-width="4" opacity=".38" stroke-linecap="round"/>
          <ellipse cx="57" cy="49" rx="13" ry="8" fill="#FFFFFF" opacity=".18" transform="rotate(-28 57 49)"/>
        </g>`
      : `<g opacity="${opacity}">
          <circle cx="72" cy="72" r="46" fill="url(#moon)" stroke="#E2E8F0" stroke-width="3"/>
          <circle cx="87" cy="59" r="10" fill="#94A3B8" opacity=".34"/>
          <circle cx="55" cy="84" r="8" fill="#94A3B8" opacity=".3"/>
          <circle cx="83" cy="94" r="5" fill="#94A3B8" opacity=".28"/>
          <circle cx="52" cy="53" r="4" fill="#F8FAFC" opacity=".42"/>
          <path d="M91 31c-19 10-31 29-31 49 0 16 7 29 19 38-28 4-53-18-53-46 0-25 20-46 45-46 7 0 14 2 20 5z" fill="#F8FAFC" opacity=".2"/>
        </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <defs>
    <radialGradient id="sun" cx="38%" cy="32%"><stop offset="0" stop-color="#FFF8B8"/><stop offset=".48" stop-color="#FFD34E"/><stop offset="1" stop-color="#F59E0B"/></radialGradient>
    <radialGradient id="ocean" cx="35%" cy="28%"><stop offset="0" stop-color="#67E8F9"/><stop offset=".52" stop-color="#2383D8"/><stop offset="1" stop-color="#123F91"/></radialGradient>
    <radialGradient id="moon" cx="35%" cy="28%"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".55" stop-color="#CBD5E1"/><stop offset="1" stop-color="#64748B"/></radialGradient>
  </defs>
  <rect width="144" height="144" rx="19" fill="#05070B"/>
  <rect x="3" y="3" width="138" height="138" rx="17" fill="#0A0E16" stroke="${accent}" stroke-width="${selected ? 5 : 2}" stroke-opacity="${selected ? 1 : .42}"/>
  ${art}
  ${available ? "" : `<path d="M30 114 114 30" stroke="#FBBF24" stroke-width="7" stroke-linecap="round" opacity=".9"/>`}
  ${selected ? `<circle cx="120" cy="120" r="10" fill="#86EFAC"/><path d="m115 120 4 4 7-9" fill="none" stroke="#052E1B" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
</svg>`;
}
