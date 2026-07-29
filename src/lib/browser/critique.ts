// Vision-model page critic for `harn browse --check-critique`.
//
// Heuristic checks only catch what we can enumerate. The reason a human still
// eyeballs a page is the long tail — the odd thing that "looks off" without
// tripping a named rule. This hands a rendered page to a vision model and asks
// for that judgement, structured.
//
// Two things keep it honest:
//   1. Tiling. A tall page screenshotted whole and downscaled to a model's
//      input budget loses the detail the critique depends on. So the page is
//      cut into overlapping vertical bands (or one tile per selector match),
//      each captured at full resolution and judged on its own, with findings
//      tagged by tile + document scroll offset for locality.
//   2. Injection. harnery ships no model client and no API key. The host wires
//      a `critiqueProvider` into the program context (same pattern as
//      `extraHeaders`); without one, the check reports `skipped`, never a
//      false pass. That keeps this portable — the tiling, prompt, and
//      orchestration live here; the model call lives in the host.

export interface CritiqueTile {
  index: number;
  /** Section label or "band N", for locating a finding. */
  label: string;
  /** Document-space Y offset of the tile's top, so findings map to a place. */
  scrollY: number;
  width: number;
  height: number;
  /** Base64 PNG of the tile (no data: prefix). */
  pngBase64: string;
}

export interface CritiqueFinding {
  tile: number;
  severity: "high" | "medium" | "low";
  category: string;
  description: string;
}

export interface CritiqueResult {
  rule: "critique";
  /** Number of tiles the page was cut into. */
  tiles: number;
  /** Whether a provider was available. False → outcome "skipped". */
  provider: boolean;
  findings: CritiqueFinding[];
  outcome: "pass" | "fail" | "skipped";
  /** Set when skipped or a provider call failed. */
  error?: string;
}

/**
 * The host-injected model call. Given one tile and the rubric, return the
 * findings for that tile. Throwing is caught and surfaced as an error finding
 * so one bad tile never sinks the run.
 */
export type CritiqueProvider = (input: {
  url: string;
  rubric: string;
  tile: CritiqueTile;
}) => Promise<CritiqueFinding[]>;

export const DEFAULT_CRITIQUE_RUBRIC = [
  "You are reviewing one vertical slice of a rendered web page for visual defects.",
  "Report ONLY concrete, visible problems a careful designer would flag:",
  "- text cut off, overlapping, or colliding with other elements",
  "- text that is hard to read against its background (low contrast)",
  "- misaligned or unevenly spaced elements; two blocks touching with no gap",
  "- broken, distorted, or missing images",
  "- leaked template tokens, placeholder text, or obviously wrong values",
  "- anything that looks broken, unfinished, or accidental",
  "Do NOT comment on content quality, wording, tone, or subjective taste.",
  "If the slice looks fine, return an empty list. Be precise and terse.",
  "Return JSON only: an array of objects",
  '{"severity":"high|medium|low","category":"<short-slug>","description":"<one sentence>"}.',
].join("\n");

/**
 * Cut a page of height `pageHeight` into overlapping vertical bands. Pure math
 * so the caller (which owns the page) can screenshot each `clip` rect. The
 * overlap keeps a finding that straddles a seam visible in at least one tile.
 */
export function bandRects(
  pageHeight: number,
  pageWidth: number,
  bandHeight: number,
  overlap: number,
): Array<{ index: number; x: number; y: number; width: number; height: number }> {
  const bands: Array<{ index: number; x: number; y: number; width: number; height: number }> = [];
  if (pageHeight <= 0 || pageWidth <= 0) return bands;
  const step = Math.max(1, bandHeight - overlap);
  let index = 0;
  for (let y = 0; y < pageHeight; y += step) {
    const height = Math.min(bandHeight, pageHeight - y);
    bands.push({ index, x: 0, y, width: pageWidth, height });
    index++;
    if (y + height >= pageHeight) break;
  }
  return bands;
}

/**
 * Validate + normalize a provider's raw output into CritiqueFindings. Tolerant
 * of a model returning a bare array or wrapping it in `{ findings: [...] }`,
 * and drops entries that are not shaped like a finding.
 */
export function normalizeFindings(raw: unknown, tile: number): CritiqueFinding[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { findings?: unknown }).findings)
      ? (raw as { findings: unknown[] }).findings
      : [];
  const severities = new Set(["high", "medium", "low"]);
  const out: CritiqueFinding[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const severity = String(record.severity ?? "low").toLowerCase();
    const description = typeof record.description === "string" ? record.description.trim() : "";
    if (!description) continue;
    out.push({
      tile,
      severity: severities.has(severity) ? (severity as CritiqueFinding["severity"]) : "low",
      category:
        typeof record.category === "string" && record.category.trim()
          ? record.category.trim()
          : "visual",
      description,
    });
  }
  return out;
}

/**
 * Run the critique over pre-captured tiles with an injected provider. Findings
 * are collected across tiles; a provider throw becomes a `high` error finding
 * for that tile rather than aborting. Outcome is `fail` when any `high` finding
 * survives (the gate escalation lives in the caller).
 */
export async function runCritique(args: {
  url: string;
  rubric: string;
  tiles: CritiqueTile[];
  provider: CritiqueProvider | undefined;
}): Promise<CritiqueResult> {
  const { url, rubric, tiles, provider } = args;
  if (!provider) {
    return {
      rule: "critique",
      tiles: tiles.length,
      provider: false,
      findings: [],
      outcome: "skipped",
      error:
        "no critiqueProvider injected by the host (see HarneryProgramContext.critiqueProvider)",
    };
  }
  const findings: CritiqueFinding[] = [];
  for (const tile of tiles) {
    try {
      const tileFindings = await provider({ url, rubric, tile });
      findings.push(...tileFindings.map((f) => ({ ...f, tile: tile.index })));
    } catch (err: unknown) {
      findings.push({
        tile: tile.index,
        severity: "high",
        category: "provider-error",
        description: `critique provider failed on ${tile.label}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const outcome = findings.some((f) => f.severity === "high") ? "fail" : "pass";
  return { rule: "critique", tiles: tiles.length, provider: true, findings, outcome };
}
