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

const ALLOWED_BY_KIND: Record<DocKind, ReadonlySet<string>> = {
  plan: new Set(["proposed", "in-progress", "shipped", "abandoned"]),
  issue: new Set(["open", "resolved", "wontfix"]),
  handoff: new Set(["open", "resolved", "abandoned"]),
};
/** Read a canonical v2 lifecycle status, or null when absent or invalid. */
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
  if (data.schema !== "harnery-doc/v2") return null;
  if (kind && data.type !== kind) return null;
  if (typeof data.status !== "string") return null;
  if (kind) return ALLOWED_BY_KIND[kind].has(data.status) ? data.status : null;
  return Object.values(ALLOWED_BY_KIND).some((allowed) => allowed.has(data.status as string))
    ? data.status
    : null;
}

/** Whether a doc carries a non-empty status in leading YAML frontmatter. */
export function hasYamlStatus(content: string): boolean {
  const { data } = parseFrontmatter(content);
  return typeof data.status === "string" && data.status.trim().length > 0;
}
