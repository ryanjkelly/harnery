import { readFileSync } from "node:fs";
import { JSON_SCHEMA, load as loadYaml } from "js-yaml";

/**
 * Shared YAML-frontmatter parsing + status dual-read for lifecycle docs
 * (plans / issues / handoffs). Kept generic: no host-specific vocabulary, so
 * it can live next to docs-sweep / docs-lint and ship in the published package.
 *
 * During the bold-header -> frontmatter cutover, `readDocStatus` prefers a YAML
 * `status:` key and falls back to the legacy `**Status:**` bold line, so sweep
 * and lint stay green while docs are converted in bulk.
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
 * stripped from `body`, so callers can dual-read without try/catch.
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

// Legacy bold status line — capture the remainder of the line so the trailing
// note (` - phase 1`, ` (see below)`, em-dash prose) can be stripped by
// `boldStatusToken`. e.g. `**Status:** in-progress - phase 1 shipped`.
const BOLD_STATUS_RE = /\*\*Status:\*\*\s*(.+)/;

// Note separators per the plan: ` - ` (spaced hyphen), en/em-dash, ` (`.
// A hyphen with NO surrounding spaces (inside `in-progress`) is left intact.
const STATUS_NOTE_SEP = /\s+[-–—]\s+|\s*\(/;

/** Extract the status token from a legacy bold line, dropping any trailing note. */
function boldStatusToken(line: string): string {
  return line.split(STATUS_NOTE_SEP)[0]!.trim();
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
  return GENERIC_NORMALIZE[t] ?? t;
}

/**
 * Read a doc's lifecycle status, preferring YAML `status:` and falling back to
 * the legacy `**Status:**` bold line. Returns the normalized canonical token,
 * or null when neither shape is present.
 */
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
  // Fall back to the legacy bold header in the opening block.
  const head = content.split("\n").slice(0, 20).join("\n");
  const m = head.match(BOLD_STATUS_RE);
  return m ? normalizeStatus(boldStatusToken(m[1]!), kind) : null;
}

/** Whether a doc carries a status in EITHER shape (for lint dual-read). */
export function hasAnyStatus(content: string): boolean {
  const { data } = parseFrontmatter(content);
  if (typeof data.status === "string" && data.status.trim()) return true;
  const head = content.split("\n").slice(0, 20).join("\n");
  return BOLD_STATUS_RE.test(head);
}
