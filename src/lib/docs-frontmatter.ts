import { readFileSync } from "node:fs";
import { JSON_SCHEMA, load as loadYaml } from "js-yaml";

/**
 * Shared YAML-frontmatter parsing + status reads for lifecycle docs
 * (plans / issues / handoffs). Kept generic: no host-specific vocabulary, so
 * it can live next to docs-sweep / docs-lint and ship in the published package.
 */

export interface ParsedFrontmatter {
  /** Parsed YAML mapping (empty object when there is no frontmatter). */
  data: Record<string, unknown>;
  /** Document body after the closing `---` (or the whole text when none). */
  body: string;
  /** Raw YAML block text, or null when the doc has no frontmatter. */
  raw: string | null;
}

/** Doc lifecycle kinds that carry a status. */
export type DocKind = "plan" | "issue" | "handoff";

// Leading `---\n … \n---` block. Tolerates a BOM and CRLF line endings.
const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Split leading YAML frontmatter from a markdown document.
 * Never throws: malformed YAML yields an empty `data` with the block still
 * stripped from `body`, so status readers do not need try/catch.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { data: {}, body: text, raw: null };
  let data: Record<string, unknown> = {};
  try {
    // JSON_SCHEMA keeps values predictable: `date: 2026-07-08` stays a string
    // instead of becoming a Date (the default schema's timestamp type), and
    // there are no YAML 1.1 bool surprises (`no`/`yes`/`on`).
    const parsed = loadYaml(m[1]!, { schema: JSON_SCHEMA });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return { data, body: text.slice(m[0].length), raw: m[1]! };
}

/**
 * Kind-independent token normalization (spacing / casing / punctuation
 * variants). Kind-specific collapses (done -> shipped vs resolved) are applied
 * in `normalizeStatus`.
 */
const GENERIC_NORMALIZE: Record<string, string> = {
  in_progress: "in-progress",
  inprogress: "in-progress",
  "in progress": "in-progress",
  "in-progress": "in-progress",
  wip: "in-progress",
  "wont-fix": "wontfix",
  wontfix: "wontfix",
  proposed: "proposed",
  abandoned: "abandoned",
  open: "open",
  resolved: "resolved",
  shipped: "shipped",
};

// "done"-family tokens collapse to different canonical values per kind.
const DONE_FAMILY = new Set(["done", "complete", "completed", "finished"]);
const KIND_NORMALIZE: Record<DocKind, Record<string, string>> = {
  plan: {
    planning: "proposed",
    draft: "proposed",
    approved: "proposed",
    plan: "proposed",
    open: "proposed",
    deferred: "proposed",
    implemented: "shipped",
    resolved: "shipped",
    fixed: "shipped",
    archived: "shipped",
    shelved: "abandoned",
  },
  issue: {
    "in progress": "open",
    in_progress: "open",
    "in-progress": "open",
    blocked: "open",
    mitigated: "open",
    fixed: "resolved",
    shipped: "resolved",
  },
  handoff: {
    "in progress": "open",
    in_progress: "open",
    "in-progress": "open",
    blocked: "open",
    fixed: "resolved",
    shipped: "resolved",
  },
};
const ALLOWED_BY_KIND: Record<DocKind, ReadonlySet<string>> = {
  plan: new Set(["proposed", "in-progress", "shipped", "abandoned"]),
  issue: new Set(["open", "resolved", "wontfix"]),
  handoff: new Set(["open", "resolved", "abandoned"]),
};
const ALL_CANONICAL = new Set(Object.values(ALLOWED_BY_KIND).flatMap((values) => [...values]));

/**
 * Normalize a raw status token to the canonical enum for its kind.
 * Returns null when the token can't be mapped (caller may fail loud).
 */
export function normalizeStatus(raw: string, kind?: DocKind): string | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  if (DONE_FAMILY.has(t)) {
    // plans ship; issues/handoffs resolve. Default to "shipped" when unknown.
    return kind === "issue" || kind === "handoff" ? "resolved" : "shipped";
  }
  const normalized = (kind ? KIND_NORMALIZE[kind][t] : undefined) ?? GENERIC_NORMALIZE[t];
  if (!normalized) return null;
  const allowed = kind ? ALLOWED_BY_KIND[kind] : ALL_CANONICAL;
  return allowed.has(normalized) ? normalized : null;
}

/** Read and normalize a doc's YAML lifecycle status, or null when absent/invalid. */
export function readDocStatus(filePath: string, kind?: DocKind): string | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  return readDocStatusFromText(content, kind);
}

/** Same as {@link readDocStatus} but from an in-memory string (testable). */
export function readDocStatusFromText(content: string, kind?: DocKind): string | null {
  const { data } = parseFrontmatter(content);
  const yamlStatus = data.status;
  if (typeof yamlStatus === "string" && yamlStatus.trim()) {
    return normalizeStatus(yamlStatus, kind);
  }
  return null;
}

/** Whether a doc carries a non-empty status in leading YAML frontmatter. */
export function hasYamlStatus(content: string): boolean {
  const { data } = parseFrontmatter(content);
  return typeof data.status === "string" && data.status.trim().length > 0;
}
