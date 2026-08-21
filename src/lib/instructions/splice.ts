/**
 * Pure splicer for harnery's machine-owned content in a consumer's repo.
 *
 * Two shapes of machine-owned content, both hash-versioned so drift is a
 * byte-compare and a re-splice is idempotent (applying twice = identical bytes):
 *
 *   1. A **managed region** inside a larger file the consumer also edits
 *      (`AGENTS.md`, `CLAUDE.md`), delimited by sentinel comments:
 *        <!-- harnery:begin <region> v=<hash> -->
 *        …rendered body…
 *        <!-- harnery:end <region> -->
 *      Everything outside the sentinels is never touched.
 *
 *   2. A **fully-owned file** harnery creates whole (a shipped skill's
 *      `SKILL.md`), carrying an ownership header comment so `deinit` deletes
 *      only files harnery generated and `--check` flags a hand-edit:
 *        <!-- harnery:generated <name> v=<hash>; machine-owned … -->
 *
 * Modeled on the first host's HTML-theme splicer (regenerate + byte-compare,
 * sha256-8 hash, content outside the region untouchable). Pure (no fs) so it's
 * unit-testable like `wireHooks`/`unwireHooks`.
 */

import { createHash } from "node:crypto";

/** 8-hex-char content hash stamped into every managed marker. */
export function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimHorizontalWhitespaceBeforeNewlines(content: string): string {
  const chunks: string[] = [];
  let segmentStart = 0;
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) !== 10) continue;
    let segmentEnd = index;
    while (segmentEnd > segmentStart) {
      const code = content.charCodeAt(segmentEnd - 1);
      if (code !== 32 && code !== 9) break;
      segmentEnd--;
    }
    chunks.push(content.slice(segmentStart, segmentEnd), "\n");
    segmentStart = index + 1;
  }
  chunks.push(content.slice(segmentStart));
  return chunks.join("");
}

/**
 * Marker comment style. Markdown/HTML files wrap markers in HTML comments;
 * shell files (git hooks) use `#` line comments. The style only changes the
 * marker syntax — hashing, splice, remove, and check semantics are identical.
 */
export type CommentStyle = "html" | "hash";

function markerPair(style: CommentStyle): { open: string; close: string } {
  return style === "hash" ? { open: "#", close: "" } : { open: "<!--", close: "-->" };
}

/** Capture regex for a named managed region: begin-marker, body, end-marker. */
function regionRe(region: string, style: CommentStyle = "html"): RegExp {
  const r = escapeRe(region);
  const { open, close } = markerPair(style);
  const o = escapeRe(open);
  const c = close ? `\\s*${escapeRe(close)}` : "";
  return new RegExp(
    `(${o}\\s*harnery:begin ${r}(?:\\s+v=([0-9a-f]*))?${c ? c : "[ \\t]*"})([\\s\\S]*?)(${o}\\s*harnery:end ${r}${c ? c : "[ \\t]*"})`,
  );
}

/** Canonical region block: begin-marker, body flanked by newlines, end-marker. */
export function regionBlock(region: string, body: string, style: CommentStyle = "html"): string {
  const { open, close } = markerPair(style);
  const tail = close ? ` ${close}` : "";
  return `${open} harnery:begin ${region} v=${shortHash(body)}${tail}\n${body}\n${open} harnery:end ${region}${tail}`;
}

export type ManagedStatus = "fresh" | "stale" | "missing";

export interface SpliceResult {
  text: string;
  changed: boolean;
  /** the region was already present before this splice */
  had: boolean;
  /** present-but-differs (hash or body); only meaningful when `had` is true */
  stale: boolean;
}

/**
 * Re-splice (or first-time append) a managed region into `content`. Idempotent:
 * applying twice yields identical bytes. Content outside the markers is never
 * touched; a re-splice replaces the region wherever the consumer moved it. When
 * absent, the block is appended after existing content (blank-line separated);
 * an empty/whitespace-only `content` becomes just the block.
 */
export function spliceRegion(
  content: string,
  region: string,
  body: string,
  style: CommentStyle = "html",
): SpliceResult {
  const re = regionRe(region, style);
  const m = content.match(re);
  const fresh = regionBlock(region, body, style);
  if (m) {
    const stale = m[2] !== shortHash(body) || m[3] !== `\n${body}\n`;
    // Replacer fn avoids `$`-in-body being read as a capture reference.
    const text = content.replace(re, () => fresh);
    return { text, changed: text !== content, had: true, stale };
  }
  const trimmed = content.trimEnd();
  const text = trimmed ? `${trimmed}\n\n${fresh}\n` : `${fresh}\n`;
  return { text, changed: true, had: false, stale: false };
}

/**
 * Remove a managed region, collapsing the blank lines it leaves behind. Returns
 * `removed: false` (content unchanged) when the region is absent. When the region
 * was the file's only content, the result is the empty string — the caller
 * decides whether to delete the file.
 */
export function removeRegion(
  content: string,
  region: string,
  style: CommentStyle = "html",
): { text: string; removed: boolean } {
  const re = regionRe(region, style);
  if (!re.test(content)) return { text: content, removed: false };
  const stripped = trimHorizontalWhitespaceBeforeNewlines(content.replace(re, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: stripped ? `${stripped}\n` : "", removed: true };
}

/** Region freshness: missing, stale (hash or body drifted), or fresh. */
export function checkRegion(
  content: string,
  region: string,
  body: string,
  style: CommentStyle = "html",
): ManagedStatus {
  const m = content.match(regionRe(region, style));
  if (!m) return "missing";
  return m[2] === shortHash(body) && m[3] === `\n${body}\n` ? "fresh" : "stale";
}

// ── Fully-owned files (shipped skills) ──────────────────────────────────────

const OWNED_RE = /<!--\s*harnery:generated\s+(\S+)\s+v=([0-9a-f]*)[\s\S]*?-->/;

/** True when a file carries harnery's ownership header (deinit may delete it). */
export function isOwnedFile(content: string): boolean {
  return OWNED_RE.test(content);
}

/**
 * Wrap a skill file: frontmatter, then a hash-stamped ownership header comment,
 * then the body. The hash covers the trimmed body so `--check` catches a
 * hand-edit even if the marker was left alone. `binName` renders the regenerate
 * / remove hint in the host's own bin.
 */
export function buildOwnedSkill(opts: {
  name: string;
  description: string;
  binName: string;
  body: string;
}): string {
  const fm = [
    "---",
    `name: ${opts.name}`,
    `description: ${JSON.stringify(opts.description)}`,
    "---",
  ].join("\n");
  const body = opts.body.trim();
  const marker =
    `<!-- harnery:generated ${opts.name} v=${shortHash(body)}; machine-owned; ` +
    `regenerated by \`${opts.binName} init\`, removed by \`${opts.binName} deinit\`. ` +
    `Edit the harnery template, not this file. -->`;
  return `${fm}\n${marker}\n\n${body}\n`;
}

/** Owned-skill freshness against a freshly-rendered body (trimmed compare). */
export function checkOwnedSkill(content: string, freshBody: string): ManagedStatus {
  const m = OWNED_RE.exec(content);
  if (!m) return "missing";
  const body = content.slice(m.index + m[0].length).trim();
  return m[2] === shortHash(freshBody.trim()) && body === freshBody.trim() ? "fresh" : "stale";
}
