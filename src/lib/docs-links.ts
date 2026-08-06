import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sh } from "./exec.ts";

/**
 * Internal Markdown link checker.
 *
 * Answers one question per link: does this relative target, and the heading
 * fragment it points at, actually exist right now? File-existence checks alone
 * miss fragments, which silently land a reader at the top of the page, and they
 * miss case-only mismatches, which work on macOS and break on Linux.
 *
 * The design constraint is noise. A checker that reports hundreds of items
 * nobody intends to fix gets ignored, so several categories are excluded by
 * construction rather than left for a human to filter:
 *
 * - External links, mail/tel schemes, protocol-relative URLs, and bare anchors
 *   into non-Markdown targets are not resolved at all.
 * - Fenced code blocks and inline code spans are stripped before parsing, so a
 *   documented example link is never mistaken for a real one.
 * - Targets carrying template syntax (`{{x}}`, `${x}`, `<placeholder>`) are
 *   skipped as unresolvable by design.
 * - Root-absolute targets (`/foo`) are counted but not resolved: in practice
 *   they are site routes far more often than repo paths.
 * - Findings in immutable-history documents are downgraded to warnings, because
 *   an audit or changelog that names a path as it existed then is correct.
 *
 * The remaining escape hatch is explicit: `<!-- links-allow: reason -->` on the
 * link's line, or `<!-- links-allow-file: reason -->` anywhere in the file.
 */

// Module-level context, initialized by initDocsContext() before any other
// function here runs. Mirrors the docs-lint.ts convention.
let REPO_ROOT = "";
let SUBMODULES: readonly string[] = [];
let EXTRA_EXCLUDED_PREFIXES: readonly string[] = [];

export function initDocsContext(opts: {
  repoRoot: string;
  submodules: readonly string[];
  extraExcludedPrefixes?: readonly string[];
}): void {
  REPO_ROOT = opts.repoRoot;
  SUBMODULES = opts.submodules;
  EXTRA_EXCLUDED_PREFIXES = opts.extraExcludedPrefixes ?? [];
}

export type LinkSeverity = "error" | "warning";

export type LinkRule = "missing-target" | "missing-fragment" | "case-mismatch" | "escapes-repo";

export interface LinkFinding {
  severity: LinkSeverity;
  repo: string;
  /** Source file, relative to its repo root. */
  path: string;
  line: number;
  rule: LinkRule;
  /** The raw link target as written, fragment included. */
  target: string;
  message: string;
  /** Populated for case-mismatch: the path that does exist on disk. */
  suggestion?: string;
}

export interface LinkOpts {
  /** Limit to one submodule, or "." for the parent repo. */
  repo?: string;
  /** Skip heading-fragment validation; check target existence only. */
  noFragments?: boolean;
  /** Report findings in immutable-history docs at error severity too. */
  strict?: boolean;
  /** Also flag links that resolve outside their own repo root. */
  checkEscapes?: boolean;
}

export interface LinkReport {
  repo: string | null;
  files_scanned: number;
  links_checked: number;
  links_skipped: number;
  error_count: number;
  warning_count: number;
  findings: LinkFinding[];
}

/** Framework/generated dirs excluded at any depth. Mirrors docs-lint.ts. */
const EXCLUDED_PREFIXES = [".agents/", ".claude/", ".harnery/", ".codex/", ".cursor/"];

/**
 * Path segments whose documents record a past state. A link there naming a file
 * that has since moved is accurate history, not a defect, so findings are
 * downgraded to warnings unless --strict.
 */
const HISTORY_SEGMENTS = ["archive/", "audits/", "changelogs/", "handoffs/", "decisions/"];

/** Schemes and forms that are never resolved against the filesystem. */
const EXTERNAL_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Template/placeholder syntax that makes a target unresolvable by design. */
const PLACEHOLDER = /[{}<>$*]|\.\.\.|%s|%d/;

/** Fragments like #L42 or #L10-L20 are line refs into source, not headings. */
const LINE_REF_FRAGMENT = /^L\d+(?:[-,]L?\d+)?$/;

/**
 * A fragment beginning with a slash is a single-page-app hash route
 * (`#/marketing/contact`), not a heading anchor. These show up in Markdown
 * captured from a rendered site and can never resolve to a heading.
 */
const HASH_ROUTE_FRAGMENT = /^\//;

/** Fragments that are structurally incapable of naming a heading. */
function isNonHeadingFragment(fragment: string): boolean {
  return LINE_REF_FRAGMENT.test(fragment) || HASH_ROUTE_FRAGMENT.test(fragment);
}

const ALLOW_LINE = /<!--\s*links-allow\s*:/;
const ALLOW_FILE = /<!--\s*links-allow-file\s*:/;

function submodulePath(name: string): string {
  return resolve(REPO_ROOT, name);
}

function isSubmoduleInitialized(name: string): boolean {
  return existsSync(resolve(REPO_ROOT, name, ".git"));
}

function getTargetRepos(opts: LinkOpts): { name: string; path: string }[] {
  const all: { name: string; path: string }[] = [{ name: "(root)", path: REPO_ROOT }];
  for (const name of SUBMODULES) {
    if (!isSubmoduleInitialized(name)) continue;
    all.push({ name, path: submodulePath(name) });
  }
  if (opts.repo) {
    const filter = opts.repo === "." ? "(root)" : opts.repo;
    return all.filter((r) => r.name === filter);
  }
  return all;
}

function isExcluded(rel: string): boolean {
  const all = [...EXCLUDED_PREFIXES, ...EXTRA_EXCLUDED_PREFIXES];
  return all.some((p) => rel.startsWith(p) || rel.includes(`/${p}`));
}

async function findMarkdownFiles(root: string): Promise<string[]> {
  const result = await sh('git ls-files --cached "**/*.md" "*.md"', { cwd: root });
  if (result.exitCode !== 0 || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .filter((f) => f.endsWith(".md"))
    .filter((f) => !isExcluded(f));
}

function isHistoryDoc(rel: string): boolean {
  return HISTORY_SEGMENTS.some((seg) => rel.startsWith(seg) || rel.includes(`/${seg}`));
}

// --- Markdown parsing ---------------------------------------------------

/**
 * Blank out fenced code blocks, preserving line count so reported line numbers
 * stay accurate. Replacing rather than deleting keeps the line index trivially
 * correct.
 */
export function maskFences(content: string): string {
  const lines = content.split("\n");
  let fence: string | null = null;
  const out: string[] = [];

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      // Inside a fence: blank everything, and close on a matching marker.
      if (
        fenceMatch &&
        fenceMatch[1]!.startsWith(fence[0]!) &&
        fenceMatch[1]!.length >= fence.length
      ) {
        fence = null;
      }
      out.push("");
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Blank fenced blocks and inline code spans, preserving line count and column
 * positions. This is the input for link extraction only.
 *
 * Anchor collection deliberately uses {@link maskFences} instead: a heading is
 * very often entirely inline code (`### \`some command\``), and masking the span
 * would erase the heading text and with it the anchor the document really has.
 */
export function maskCode(content: string): string {
  return (
    maskFences(content)
      .split("\n")
      // Longest-run-first so ``a `b` c`` is handled as one span.
      .map((line) => line.replace(/(`+)(?:(?!\1).)*\1/g, (m) => " ".repeat(m.length)))
      .join("\n")
  );
}

export interface ExtractedLink {
  target: string;
  line: number;
}

/**
 * Read one inline destination starting just after the `(` of a `](`. Returns
 * the destination and the index of the closing paren, or null if the
 * destination is malformed or runs off the end of the line.
 *
 * Parens are balanced rather than stopped at the first `)`, so a target like
 * `foo_(bar).md` survives; an optional "title" or 'title' is discarded.
 */
function readDestination(
  line: string,
  start: number,
): { dest: string; end: number; bracketed: boolean } | null {
  let i = start;
  while (i < line.length && /\s/.test(line[i]!)) i++;

  let dest = "";
  let bracketed = false;
  if (line[i] === "<") {
    const close = line.indexOf(">", i + 1);
    if (close === -1) return null;
    dest = line.slice(i + 1, close);
    bracketed = true;
    i = close + 1;
  } else {
    let depth = 0;
    while (i < line.length) {
      const ch = line[i]!;
      if (ch === "\\" && i + 1 < line.length) {
        dest += line[i + 1];
        i += 2;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === "(") depth++;
      if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
      dest += ch;
      i++;
    }
  }

  // Skip an optional title, then require the closing paren.
  while (i < line.length && /\s/.test(line[i]!)) i++;
  const q = line[i];
  if (q === '"' || q === "'") {
    const close = line.indexOf(q, i + 1);
    if (close === -1) return null;
    i = close + 1;
    while (i < line.length && /\s/.test(line[i]!)) i++;
  }
  if (line[i] !== ")") return null;
  return { dest, end: i, bracketed };
}

/**
 * Angle brackets serve two unrelated purposes in a destination: escaping a
 * filename that contains spaces, and standing in for a value the reader
 * supplies (`[docs](<your-repo>)`). Unwrapping erases the difference, so a
 * bracketed destination only counts as a path when it is shaped like one.
 */
function looksLikePath(dest: string): boolean {
  return dest.includes("/") || /\.[a-z0-9]+$/i.test(dest);
}

/**
 * Pull every link target out of masked Markdown: inline links, images, and
 * reference definitions.
 *
 * The scan keys off each `](` rather than trying to match the link text, which
 * is what makes nested constructs work: in `[![alt](img.png)](page.md)` both
 * destinations are found, where a text-matching regex sees only one. Angle-
 * bracket-wrapped destinations are unwrapped here so a legitimately spaced
 * filename is not later mistaken for placeholder syntax.
 */
export function extractLinks(masked: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  // [id]: dest "title" — but never [^id]:, which is a footnote definition
  // whose body is prose, not a destination; parsing it would turn the first
  // word of every footnote into a phantom link target.
  const refDef = /^\s{0,3}\[[^\]^][^\]]*\]:\s*(\S+)/;

  masked.split("\n").forEach((line, i) => {
    const lineNo = i + 1;

    for (let at = line.indexOf("]("); at !== -1; at = line.indexOf("](", at + 1)) {
      const parsed = readDestination(line, at + 2);
      if (!parsed) continue;
      if (parsed.bracketed && !looksLikePath(parsed.dest)) continue;
      if (parsed.dest) links.push({ target: parsed.dest, line: lineNo });
      // Continue from just before the closing paren; overlapping starts are
      // fine because indexOf resumes at at+1 regardless.
    }

    const ref = line.match(refDef);
    if (ref?.[1]) {
      let dest = ref[1];
      if (dest.startsWith("<") && dest.endsWith(">")) {
        dest = dest.slice(1, -1);
        if (!looksLikePath(dest)) return;
      }
      links.push({ target: dest, line: lineNo });
    }
  });

  return links;
}

/**
 * GitHub's heading-anchor slug: lowercase, drop punctuation other than hyphen
 * and underscore, then map each remaining space to one hyphen. Duplicate slugs
 * in one document get -1, -2, ... suffixes in document order.
 *
 * Runs of whitespace are deliberately NOT collapsed. Dropping a punctuation
 * mark leaves the spaces that surrounded it, so "Intent — capture" becomes
 * "intent--capture" with a double hyphen, and that is the anchor GitHub renders
 * and the one real links in the wild are written against.
 */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * Every fragment a reader can legitimately target in one document: Markdown
 * heading slugs (ATX and Setext), explicit `{#custom-id}` suffixes, and HTML
 * `id=` / `name=` attributes, which docs use for stable anchors that survive a
 * heading rename.
 */
export function collectAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  const masked = maskFences(content);
  const lines = masked.split("\n");

  const addHeading = (raw: string): void => {
    let text = raw.trim();
    const custom = text.match(/\{#([^}]+)\}\s*$/);
    if (custom?.[1]) {
      anchors.add(custom[1].toLowerCase());
      text = text.slice(0, custom.index).trim();
    }
    // Strip inline markup so "**Bold** `code`" slugs like GitHub's does.
    // Underscores are special: GitHub keeps literal ones (`not_in_channel`
    // anchors as not_in_channel), and GFM emphasis never binds intra-word,
    // so only word-boundary underscores are markup. `_` counts as a word
    // character in JS regex, so \b sits exactly at the space-to-underscore
    // seam these delimiters occupy.
    text = text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*~`]/g, "")
      .replace(/\b_+|_+\b/g, "")
      .replace(/<[^>]+>/g, "");
    const base = slugify(text);
    if (!base) return;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  };

  lines.forEach((line, i) => {
    const atx = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (atx?.[1] !== undefined) {
      addHeading(atx[1]);
      return;
    }
    // Setext: an underline of = or - directly under non-blank text.
    if (/^\s{0,3}(=+|-{2,})\s*$/.test(line) && i > 0 && lines[i - 1]!.trim()) {
      addHeading(lines[i - 1]!);
    }
  });

  // HTML anchors are read from the unmasked source: they often sit inside
  // raw HTML blocks that the fence mask leaves alone anyway, and an id inside
  // a code sample is harmless to accept.
  for (const m of content.matchAll(/<[a-z][^>]*?\s(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
    if (m[1]) anchors.add(m[1].toLowerCase());
  }

  return anchors;
}

// --- Resolution ---------------------------------------------------------

/**
 * Case-insensitive sibling lookup. Only called once a target has already been
 * proven missing, so the directory read stays off the hot path.
 */
function findCaseVariant(absPath: string): string | null {
  const dir = dirname(absPath);
  const base = absPath.slice(dir.length + 1);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const hit = entries.find((e) => e.toLowerCase() === base.toLowerCase());
  return hit && hit !== base ? join(dir, hit) : null;
}

/** Does the target path exist, allowing the extension-less form of a doc? */
function resolveTarget(absPath: string): { found: string | null; isDir: boolean } {
  if (existsSync(absPath)) {
    let isDir = false;
    try {
      isDir = statSync(absPath).isDirectory();
    } catch {
      /* race or permission: treat as file */
    }
    return { found: absPath, isDir };
  }
  // GitHub resolves an extension-less link to a sibling .md when one exists.
  if (!/\.[a-z0-9]+$/i.test(absPath) && existsSync(`${absPath}.md`)) {
    return { found: `${absPath}.md`, isDir: false };
  }
  return { found: null, isDir: false };
}

interface CheckFileOpts {
  repoName: string;
  repoPath: string;
  /** Source file path relative to repoPath. */
  rel: string;
  content: string;
  noFragments: boolean;
  strict: boolean;
  checkEscapes: boolean;
  /** Cache of absolute file path -> anchor set, shared across the run. */
  anchorCache: Map<string, Set<string>>;
}

interface FileResult {
  findings: LinkFinding[];
  checked: number;
  skipped: number;
}

export function checkFile(opts: CheckFileOpts): FileResult {
  const { repoName, repoPath, rel, content, anchorCache } = opts;
  const findings: LinkFinding[] = [];
  let checked = 0;
  let skipped = 0;

  if (ALLOW_FILE.test(content)) return { findings, checked, skipped };

  const sourceLines = content.split("\n");
  const sourceAbs = join(repoPath, rel);
  const sourceDir = dirname(sourceAbs);
  const history = isHistoryDoc(rel);
  const sev: LinkSeverity = history && !opts.strict ? "warning" : "error";

  const add = (
    line: number,
    rule: LinkRule,
    target: string,
    message: string,
    suggestion?: string,
  ): void => {
    findings.push({
      severity: sev,
      repo: repoName,
      path: rel,
      line,
      rule,
      target,
      message,
      suggestion,
    });
  };

  for (const { target, line } of extractLinks(maskCode(content))) {
    if (ALLOW_LINE.test(sourceLines[line - 1] ?? "")) {
      skipped++;
      continue;
    }
    if (EXTERNAL_SCHEME.test(target) || PLACEHOLDER.test(target)) {
      skipped++;
      continue;
    }

    const hashAt = target.indexOf("#");
    const rawPath = hashAt === -1 ? target : target.slice(0, hashAt);
    const fragment = hashAt === -1 ? "" : target.slice(hashAt + 1);

    // Root-absolute targets are site routes far more often than repo paths.
    if (rawPath.startsWith("/")) {
      skipped++;
      continue;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      decoded = rawPath;
    }

    // Same-document fragment.
    if (!decoded) {
      if (!fragment || opts.noFragments) {
        skipped++;
        continue;
      }
      checked++;
      if (isNonHeadingFragment(fragment)) continue;
      const anchors = anchorCache.get(sourceAbs) ?? collectAnchors(content);
      anchorCache.set(sourceAbs, anchors);
      if (!anchors.has(decodeFragment(fragment))) {
        add(line, "missing-fragment", target, `no heading or anchor "#${fragment}" in this file`);
      }
      continue;
    }

    checked++;
    const absTarget = resolve(sourceDir, decoded);
    const { found, isDir } = resolveTarget(absTarget);

    if (!found) {
      const variant = findCaseVariant(absTarget);
      if (variant) {
        add(
          line,
          "case-mismatch",
          target,
          "target differs only by case; this resolves on macOS and fails on Linux",
          relative(repoPath, variant),
        );
      } else {
        add(line, "missing-target", target, "target does not exist");
      }
      continue;
    }

    if (opts.checkEscapes && isOutside(repoPath, found)) {
      add(
        line,
        "escapes-repo",
        target,
        "target resolves outside this repo; the link breaks for a standalone clone",
      );
    }

    if (opts.noFragments || !fragment || isDir || !found.endsWith(".md")) continue;
    if (isNonHeadingFragment(fragment)) continue;

    let anchors = anchorCache.get(found);
    if (!anchors) {
      try {
        anchors = collectAnchors(readFileSync(found, "utf8"));
      } catch {
        continue;
      }
      anchorCache.set(found, anchors);
    }
    if (!anchors.has(decodeFragment(fragment))) {
      add(line, "missing-fragment", target, `no heading or anchor "#${fragment}" in ${decoded}`);
    }
  }

  return { findings, checked, skipped };
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment).toLowerCase();
  } catch {
    return fragment.toLowerCase();
  }
}

function isOutside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel);
}

// --- Runner -------------------------------------------------------------

export async function runLinks(opts: LinkOpts): Promise<LinkReport> {
  const findings: LinkFinding[] = [];
  const anchorCache = new Map<string, Set<string>>();
  let filesScanned = 0;
  let linksChecked = 0;
  let linksSkipped = 0;

  for (const { name, path } of getTargetRepos(opts)) {
    for (const rel of await findMarkdownFiles(path)) {
      let content: string;
      try {
        content = readFileSync(join(path, rel), "utf8");
      } catch {
        continue;
      }
      filesScanned++;
      const result = checkFile({
        repoName: name,
        repoPath: path,
        rel,
        content,
        noFragments: !!opts.noFragments,
        strict: !!opts.strict,
        checkEscapes: !!opts.checkEscapes,
        anchorCache,
      });
      findings.push(...result.findings);
      linksChecked += result.checked;
      linksSkipped += result.skipped;
    }
  }

  return {
    repo: opts.repo ?? null,
    files_scanned: filesScanned,
    links_checked: linksChecked,
    links_skipped: linksSkipped,
    error_count: findings.filter((f) => f.severity === "error").length,
    warning_count: findings.filter((f) => f.severity === "warning").length,
    findings,
  };
}
