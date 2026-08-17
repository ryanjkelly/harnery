// Diff-aware QA planner: classify a page change against a baseline signature
// and emit a machine-readable review manifest BEFORE any expensive work runs.
//
// The motivating failure is spend without proportionality: a one-word copy
// edit and a theme rewrite both trigger the same full-page, every-context
// vision review. This module makes review proportional to the change:
//   - text/data-only edits produce zero vision calls;
//   - a local component change reviews only that component's stable root;
//   - global CSS, unprovable blast radius, or a missing baseline widen to
//     full coverage — ambiguity always widens, never silently downgrades.
//
// Everything here is pure data-in/data-out: signatures are captured elsewhere
// (the browser client), baselines are persisted elsewhere (qa-snapshot.ts),
// and execution happens elsewhere (the critique engine). Keeping the planner
// pure means the classification can be reviewed, logged, and overridden
// before a single model call is made.
//
// One deliberate portability boundary: a stylesheet change classifies as
// `large-structural` here because CSS blast radius is not provable from
// digests alone. A host that can map component-scoped stylesheets to
// selectors can downgrade after the fact; the portable layer never does.

/** FNV-1a 32-bit over a string, hex-encoded, with a length suffix so the
 * (tiny) collision surface also has to match on length. Used for text and
 * stylesheet digests — a comparison fingerprint, not a security hash. */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, "0")}-${text.length}`;
}

/** One element's structural fingerprint inside a captured page. */
export interface QaNodeSignature {
  /** Structural path from body: `body>div:0>table:1>tr:4>td:2` (index among
   * element siblings). Position-sensitive by design — reordering IS a
   * structural change. */
  path: string;
  tag: string;
  /** Canonical attribute string: sorted `name=value` pairs joined with \x1f.
   * Raw (not digested) so a reviewer can see WHICH attribute changed. */
  attrs: string;
  /** Digest of the element's direct text-node content (whitespace-normalized),
   * absent when the element has no direct text. */
  text?: string;
  /** Nearest strict-ancestor stable anchor (unique `#id` or
   * `[data-qa-scope="…"]`), with the anchor element's own path so nested
   * anchors can be deduped to the outermost root. Absent for nodes with no
   * anchored ancestor (e.g. direct children of body on an anchor-free page). */
  anchor?: { selector: string; path: string };
}

export interface QaStylesheetSignature {
  /** External sheet href, or `inline:<index>` for a `<style>` block. */
  key: string;
  kind: "external" | "inline";
  /** Content digest, or the literal `"unavailable"` when the sheet's text
   * could not be read (cross-origin without CORS). Unavailable digests widen
   * classification to `unknown` — style stability can't be proven. */
  digest: string;
}

/** A captured page signature: everything the classifier needs, nothing the
 * critique engine does. Produced by the browser client, persisted by the
 * snapshot store. */
export interface QaSignature {
  url: string;
  /** ISO capture time. */
  capturedAt: string;
  nodes: QaNodeSignature[];
  stylesheets: QaStylesheetSignature[];
  /** True when the capture hit its node cap. A truncated signature cannot
   * prove absence of change — the classifier widens to `unknown`. */
  truncated?: boolean;
}

export type ChangeClass =
  | "text-data-only"
  | "local-visual"
  | "interaction-state"
  | "large-structural"
  | "unknown";

export interface QaScope {
  selector: string;
  reason: string;
  /** How many elements the selector matched at capture time (1 for anchors —
   * uniqueness is verified during capture; explicit selectors carry the
   * caller-counted value). */
  matches: number;
}

export interface QaClassification {
  /** `interaction-state` is never inferred from signatures — it is declared
   * by explicit state inputs at manifest time. */
  change_class: Exclude<ChangeClass, "interaction-state">;
  reasons: string[];
  /** Paths whose direct text content changed (structure + attrs identical). */
  text_changed_paths: string[];
  /** Paths added, removed, or with changed attributes. */
  structural_changed_paths: string[];
  /** Stylesheet keys whose digest changed, appeared, or disappeared. */
  stylesheets_changed: string[];
  /** Stable scope roots covering every structural change (local-visual only). */
  scopes: QaScope[];
  /** True when baseline and current are indistinguishable. */
  identical: boolean;
}

export interface ClassifyOptions {
  /** More distinct scope roots than this widens to large-structural: a change
   * that touches many independent regions is a page-level change no matter
   * how well-anchored each region is. Default 4. */
  maxScopes?: number;
}

const UNAVAILABLE = "unavailable";

function diffStylesheets(baseline: QaStylesheetSignature[], current: QaStylesheetSignature[]) {
  const base = new Map(baseline.map((s) => [s.key, s.digest]));
  const cur = new Map(current.map((s) => [s.key, s.digest]));
  const unavailable = [...baseline, ...current].some((s) => s.digest === UNAVAILABLE);
  const changed: string[] = [];
  for (const [key, digest] of cur) {
    const prior = base.get(key);
    if (prior === undefined || prior !== digest) changed.push(key);
  }
  for (const key of base.keys()) {
    if (!cur.has(key)) changed.push(key);
  }
  return { changed: changed.sort(), unavailable };
}

/**
 * Classify current against baseline. Pure: no browser, no filesystem. The
 * bias is stated in the plan and enforced here — ambiguity widens (to
 * `unknown`/`large-structural`), never narrows. A `null` baseline is the
 * "no baseline available" case and is always `unknown`.
 */
export function classifySignatures(
  baseline: QaSignature | null,
  current: QaSignature,
  opts: ClassifyOptions = {},
): QaClassification {
  const maxScopes = opts.maxScopes ?? 4;
  const none: Omit<QaClassification, "change_class" | "reasons"> = {
    text_changed_paths: [],
    structural_changed_paths: [],
    stylesheets_changed: [],
    scopes: [],
    identical: false,
  };
  if (!baseline) {
    return {
      ...none,
      change_class: "unknown",
      reasons: ["no baseline available — cannot prove any change class"],
    };
  }

  if (baseline.truncated || current.truncated) {
    return {
      ...none,
      change_class: "unknown",
      reasons: [
        "signature capture was truncated at its node cap — absence of change cannot be proven",
      ],
    };
  }

  const sheets = diffStylesheets(baseline.stylesheets, current.stylesheets);
  if (sheets.unavailable) {
    return {
      ...none,
      change_class: "unknown",
      stylesheets_changed: sheets.changed,
      reasons: [
        "stylesheet digest unavailable (cross-origin without CORS) — style stability cannot be proven, DOM equality alone never proves text-only",
      ],
    };
  }

  const baseNodes = new Map(baseline.nodes.map((n) => [n.path, n]));
  const curNodes = new Map(current.nodes.map((n) => [n.path, n]));
  const textChanged: string[] = [];
  const structuralChanged = new Map<string, QaNodeSignature>();
  for (const [path, node] of curNodes) {
    const prior = baseNodes.get(path);
    if (!prior) {
      structuralChanged.set(path, node); // added
    } else if (prior.tag !== node.tag || prior.attrs !== node.attrs) {
      structuralChanged.set(path, node);
    } else if ((prior.text ?? "") !== (node.text ?? "")) {
      textChanged.push(path);
    }
  }
  for (const [path, node] of baseNodes) {
    if (!curNodes.has(path) && !structuralChanged.has(path)) {
      structuralChanged.set(path, node); // removed — anchor comes from baseline side
    }
  }

  if (sheets.changed.length > 0) {
    return {
      ...none,
      change_class: "large-structural",
      text_changed_paths: textChanged.sort(),
      structural_changed_paths: [...structuralChanged.keys()].sort(),
      stylesheets_changed: sheets.changed,
      reasons: [
        `stylesheet changed (${sheets.changed.join(", ")}) — CSS blast radius is not provable portably, widening to full coverage`,
      ],
    };
  }

  if (structuralChanged.size === 0) {
    if (textChanged.length === 0) {
      return {
        ...none,
        change_class: "text-data-only",
        identical: true,
        reasons: ["no differences detected between baseline and current signatures"],
      };
    }
    return {
      ...none,
      change_class: "text-data-only",
      text_changed_paths: textChanged.sort(),
      reasons: [
        `only direct text content changed (${textChanged.length} node${textChanged.length === 1 ? "" : "s"}); element structure, attributes, and stylesheet digests are unchanged`,
      ],
    };
  }

  // Structural changes: lift every changed node to its nearest strict-ancestor
  // stable anchor. Any node without one is an unprovable boundary — widen.
  const anchorless: string[] = [];
  const scopeNodes = new Map<string, { path: string; count: number }>();
  for (const [path, node] of structuralChanged) {
    if (!node.anchor) {
      anchorless.push(path);
      continue;
    }
    const existing = scopeNodes.get(node.anchor.selector);
    if (existing) existing.count++;
    else scopeNodes.set(node.anchor.selector, { path: node.anchor.path, count: 1 });
  }
  if (anchorless.length > 0) {
    return {
      ...none,
      change_class: "large-structural",
      text_changed_paths: textChanged.sort(),
      structural_changed_paths: [...structuralChanged.keys()].sort(),
      reasons: [
        `${anchorless.length} changed node${anchorless.length === 1 ? "" : "s"} without a stable ancestor (first: ${anchorless.sort()[0]}) — visual impact cannot be proven to stay inside stable selectors`,
      ],
    };
  }

  // Dedupe nested anchors to the outermost root: reviewing a container once
  // beats one model call per anchored descendant.
  const entries = [...scopeNodes.entries()].sort((a, b) => a[1].path.length - b[1].path.length);
  const roots: Array<[string, { path: string; count: number }]> = [];
  for (const entry of entries) {
    const container = roots.find(([, root]) => entry[1].path.startsWith(`${root.path}>`));
    if (container) container[1].count += entry[1].count;
    else roots.push(entry);
  }

  if (roots.length > maxScopes) {
    return {
      ...none,
      change_class: "large-structural",
      text_changed_paths: textChanged.sort(),
      structural_changed_paths: [...structuralChanged.keys()].sort(),
      reasons: [
        `changes span ${roots.length} independent scope roots (limit ${maxScopes}) — a multi-region change is a page-level change`,
      ],
    };
  }

  return {
    change_class: "local-visual",
    identical: false,
    text_changed_paths: textChanged.sort(),
    structural_changed_paths: [...structuralChanged.keys()].sort(),
    stylesheets_changed: [],
    scopes: roots
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([selector, root]) => ({
        selector,
        reason: `nearest stable ancestor of ${root.count} changed node${root.count === 1 ? "" : "s"}`,
        matches: 1,
      })),
    reasons: [
      `structural changes contained by ${roots.length} stable scope root${roots.length === 1 ? "" : "s"}`,
    ],
  };
}

export interface QaContext {
  viewport: string;
  theme: "light" | "dark";
  state: string;
}

export interface QaManifest {
  schema_version: 1;
  change_class: ChangeClass;
  classification_reasons: string[];
  source_revision?: string;
  baseline_revision?: string;
  /** Which resolution-order source produced the baseline:
   * `qa-snapshot:<capturedAt>`, `production-render:<capturedAt>`,
   * `revision-render:<rev>`, or `none`. */
  baseline_source: string;
  scopes: QaScope[];
  contexts: QaContext[];
  checks: {
    deterministic: string[];
    visual: "none" | "scoped" | "full-page";
  };
  concurrency: { headless: number; metered: number };
  reuse: { mode: "none" | "exact-digest" | "band-diff"; cache: boolean };
  /** Provider-call ceiling for the plan, so cost is visible before execution.
   * Full-page tile counts need a rendered page; callers pass an estimate. */
  predicted: { tiles_ceiling: number; model_calls_ceiling: number };
  /** Present when the run cannot produce a trustworthy verdict (e.g. unknown
   * class without permission to widen). An incomplete run is never a pass. */
  incomplete?: { reason: string };
}

export interface ManifestOptions {
  baselineSource: string;
  sourceRevision?: string;
  baselineRevision?: string;
  /** Explicit scope selectors from the producing task — resolution order rung
   * 1; they override lifted anchors entirely. */
  explicitScopes?: QaScope[];
  /** Named interaction states to review (before/after pairs, etc.). Any
   * non-empty list promotes a text/local classification to
   * `interaction-state` and appends one context per state. */
  states?: string[];
  /** Viewports for the full matrix (default ["desktop", "mobile"]). */
  viewports?: string[];
  /** Estimated full-page tile count per context, from the caller's render
   * knowledge (page height / band step, capped). Default 24 (the tile cap). */
  estimatedFullPageTiles?: number;
  concurrency?: { headless: number; metered: number };
  reuse?: { mode: "none" | "exact-digest" | "band-diff"; cache: boolean };
  deterministicChecks?: string[];
  /** When false (default), an `unknown` classification widens to full
   * large-structural coverage. When true, the manifest instead marks itself
   * incomplete with zero contexts — the caller wants a hard stop. */
  stopOnUnknown?: boolean;
}

const DEFAULT_DETERMINISTIC = ["console", "overflow", "truncation", "placeholder"];

/**
 * Turn a classification into an executable review manifest. Pure: rendering,
 * baseline acquisition, and critique execution stay in the caller. The
 * separation is the point — the manifest can be printed by a dry run,
 * reviewed, and overridden before expensive work starts.
 */
export function buildQaManifest(
  classification: QaClassification,
  opts: ManifestOptions,
): QaManifest {
  const viewports = opts.viewports ?? ["desktop", "mobile"];
  const fullPageTiles = opts.estimatedFullPageTiles ?? 24;
  const states = opts.states ?? [];
  const scopes = opts.explicitScopes?.length ? opts.explicitScopes : classification.scopes;

  let changeClass: ChangeClass = classification.change_class;
  const reasons = [...classification.reasons];
  if (opts.explicitScopes?.length && changeClass === "unknown") {
    // Explicit scope input is resolution-order rung 1: the producing task
    // knows its own blast radius better than a missing baseline does.
    changeClass = "local-visual";
    reasons.push("explicit scope selectors supplied — overriding unknown classification");
  }
  if (states.length > 0 && (changeClass === "text-data-only" || changeClass === "local-visual")) {
    changeClass = "interaction-state";
    reasons.push(`explicit interaction states requested: ${states.join(", ")}`);
  }

  let incomplete: { reason: string } | undefined;
  if (classification.change_class === "unknown" && changeClass === "unknown") {
    if (opts.stopOnUnknown) {
      incomplete = { reason: classification.reasons[0] ?? "classification unknown" };
    } else {
      reasons.push("unknown class widened to large-structural coverage");
    }
  }

  const matrix: QaContext[] = viewports.flatMap((viewport) =>
    (["light", "dark"] as const).map((theme) => ({ viewport, theme, state: "default" })),
  );
  let contexts: QaContext[];
  let visual: QaManifest["checks"]["visual"];
  switch (changeClass) {
    case "text-data-only":
      contexts = [];
      visual = "none";
      break;
    case "local-visual":
      contexts = viewports.map((viewport) => ({ viewport, theme: "light", state: "default" }));
      visual = "scoped";
      break;
    case "interaction-state":
      contexts = [
        { viewport: viewports[0] ?? "desktop", theme: "light", state: "default" },
        ...states.map((state) => ({
          viewport: viewports[0] ?? "desktop",
          theme: "light" as const,
          state,
        })),
      ];
      visual = "scoped";
      break;
    default:
      contexts = incomplete ? [] : matrix;
      visual = "full-page";
      break;
  }

  const tilesPerContext =
    visual === "none" ? 0 : visual === "scoped" ? Math.max(1, scopes.length) : fullPageTiles;
  const tilesCeiling = tilesPerContext * contexts.length;

  return {
    schema_version: 1,
    change_class: changeClass,
    classification_reasons: reasons,
    ...(opts.sourceRevision ? { source_revision: opts.sourceRevision } : {}),
    ...(opts.baselineRevision ? { baseline_revision: opts.baselineRevision } : {}),
    baseline_source: opts.baselineSource,
    scopes: visual === "none" ? [] : scopes,
    contexts,
    checks: {
      deterministic: opts.deterministicChecks ?? DEFAULT_DETERMINISTIC,
      visual,
    },
    concurrency: opts.concurrency ?? { headless: 4, metered: 2 },
    reuse: opts.reuse ?? { mode: "none", cache: false },
    predicted: { tiles_ceiling: tilesCeiling, model_calls_ceiling: tilesCeiling },
    ...(incomplete ? { incomplete } : {}),
  };
}
