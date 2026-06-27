/**
 * Server logic for the file-browser tree (/api/file/{list,usage,search}). The
 * single-file viewer resolves ONE path to an fd (lib/files.ts `resolveFile`);
 * this module resolves DIRECTORIES — listing children, recursive disk usage,
 * and a cached file-name index for search — reusing the SAME security
 * primitives so nothing here can escape the repo root or surface a file the
 * viewer itself would refuse to serve:
 *
 *   - identical input canonicalization + `..`/backslash/control-byte/`~`
 *     rejection as resolveFile Step 0–2 (see `resolveDir`);
 *   - lexical containment then realpath containment (Step 2.5 + Step 3), so a
 *     symlinked directory pointing outside the root is rejected, not followed;
 *   - the SAME `evaluateDeny` verdict (lib/files.ts) decides visibility, so
 *     `.git`, `.credentials`, `.env`, key/secret files, node_modules, etc. are
 *     HIDDEN from listings, EXCLUDED from usage totals, and EXCLUDED from the
 *     search index — never an existence oracle for secret files.
 *
 * It opens no fds and reads no bytes (no TOCTOU surface); the right-pane viewer
 * re-resolves through the fd-returning `resolveFile` when a file is opened.
 */

import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { coordRoot } from "./coord-reader";
import type {
  DirEntry,
  DirListing,
  DirUsage,
  DirUsageStats,
  SearchResult,
} from "./file-viewer/types";
import {
  evaluateDeny,
  type FilesConfig,
  loadFilesConfig,
  type RejectCode,
  type ResolveReject,
} from "./files";

export type ListResult = ({ ok: true } & DirListing) | ResolveReject;
export type UsageResult = ({ ok: true } & DirUsage) | ResolveReject;
export type SearchResultEnvelope = ({ ok: true } & SearchResult) | ResolveReject;

export interface ListOptions {
  /** Override the containment root (tests use temp dirs). Defaults to
   * realpath(coordRoot()). */
  root?: string;
}

export interface SearchOptions extends ListOptions {
  /** Max matches returned (default 50). */
  limit?: number;
}

function reject(code: RejectCode, status: ResolveReject["status"], detail?: string): ResolveReject {
  return { ok: false, code, status, detail };
}

/** Probe segment used to ask "are this directory's CONTENTS categorically
 * denied?" (e.g. `node_modules`, whose name alone isn't denied but whose every
 * child is, via the `**​/node_modules/**` non-last pattern). A neutral token no
 * floor/secret glob targets, so it only ever matches dir-scoped deny rules. */
const CONTENTS_PROBE = "_";

/** Recursive usage walk safety caps. Each immediate child gets its OWN budget
 * (entries + time) so one huge subtree (a vendored/build dir) can't starve its
 * siblings of a real total — only the genuinely huge child shows `partial`. A
 * global deadline bounds the whole call; children walked after it get a small
 * floor budget (still a number, marked partial) rather than zero. */
const USAGE_PER_CHILD_MAX_ENTRIES = 40_000;
const USAGE_PER_CHILD_MAX_MS = 1_200;
const USAGE_MIN_CHILD_MS = 150;
const USAGE_GLOBAL_MAX_MS = 6_000;
const USAGE_TTL_MS = 60_000;

/** Search-index caps + the build/dependency/cache directories the index skips.
 * These are generic ecosystem conventions (NOT host-specific): nobody fuzzy-
 * searches for a webpack chunk, a vendored dep, or a compiled artifact, and
 * walking them balloons the index past its cap (starving real source of index
 * slots). The TREE and USAGE still show these dirs with real sizes — this skip
 * is a search-quality filter only, distinct from the security deny model.
 * `.git` + node_modules are already denied; listed/implied for clarity. */
const INDEX_SKIP_DIRS = new Set([
  // VCS + JS build output
  ".git",
  ".next",
  ".turbo",
  ".astro",
  ".vercel",
  ".output",
  ".svelte-kit",
  ".nuxt",
  "dist",
  "build",
  "out",
  "coverage",
  // caches
  ".cache",
  ".parcel-cache",
  ".gradle",
  ".terraform",
  // dependency / compiled trees (composer/go vendor, dbt/rust/java target)
  "vendor",
  "target",
  // python tooling
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
]);
const INDEX_MAX_FILES = 50_000;
const INDEX_TTL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Shared directory resolution (the security boundary for every export below)
// ---------------------------------------------------------------------------

interface ResolvedDir {
  ok: true;
  /** realpath(root). */
  ROOT: string;
  /** realpath of the resolved directory. */
  real: string;
  /** Canonical repo-relative path of `real` ("" = repo root). */
  baseRel: string;
  cfg: FilesConfig;
}

/**
 * Canonicalize + contain a directory reference. Empty / "." resolves to the
 * repo root (the viewer rejects the bare root for a *file* open; for a tree it
 * is the entry point). Returns a fail-closed rejection on any violation.
 */
function resolveDir(rawInput: string, opts: ListOptions = {}): ResolvedDir | ResolveReject {
  let ROOT: string;
  try {
    ROOT = realpathSync(opts.root ?? coordRoot());
  } catch (err) {
    return reject("config_error", 500, `root unresolvable: ${(err as Error).message}`);
  }

  const raw = rawInput ?? "";
  if (typeof raw !== "string") return reject("invalid_path", 400, "bad dir param");
  if (raw.length > 4096) return reject("invalid_path", 400, "path too long");
  if (/%[0-9A-Fa-f]{2}/.test(raw)) {
    return reject("invalid_path", 400, "residual percent-encoding");
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control-byte rejection is the point
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return reject("invalid_path", 400, "control bytes in path");
  }
  if (raw.includes("\\")) return reject("invalid_path", 400, "backslash in path");
  if (raw.startsWith("~")) return reject("invalid_path", 400, "~-forms are not accepted");
  const input = raw.normalize("NFC");
  if (input.split("/").includes("..")) return reject("invalid_path", 400, "`..` segment");

  // Lexical containment (no filesystem access yet).
  const lexAbs = path.resolve(ROOT, input);
  const lexRel = path.relative(ROOT, lexAbs);
  const inputIsRoot = lexRel === "";
  if (!inputIsRoot && (lexRel.startsWith("..") || path.isAbsolute(lexRel))) {
    return reject("unresolvable", 400, "path is outside the repo root");
  }

  // Config + deny precheck: a denied directory is never listable.
  let cfg: FilesConfig;
  try {
    cfg = loadFilesConfig(ROOT);
  } catch (err) {
    return reject("config_error", 500, (err as Error).message);
  }
  if (!inputIsRoot && evaluateDeny(lexRel, cfg).denied) {
    return reject("denied", 403, "blocked by policy");
  }

  // Canonical containment via realpath (catches symlinked-out directories).
  let real: string;
  try {
    real = realpathSync(lexAbs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return reject("not_found", 404);
    if (code === "EACCES" || code === "EPERM") return reject("denied", 403, "permission denied");
    return reject("unresolvable", 400, `realpath failed: ${code}`);
  }
  const relFromRoot = path.relative(ROOT, real);
  const realIsRoot = relFromRoot === "";
  if (!realIsRoot && (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot))) {
    return reject("unresolvable", 400, "canonical path is outside the repo root");
  }
  const baseRel = realIsRoot ? "" : relFromRoot.split(path.sep).join("/");

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(real);
  } catch {
    return reject("not_found", 404);
  }
  if (!st.isDirectory()) return reject("not_file", 404, "not a directory");

  return { ok: true, ROOT, real, baseRel, cfg };
}

// ---------------------------------------------------------------------------
// listDir — immediate children (name + kind + file size)
// ---------------------------------------------------------------------------

/**
 * List the immediate children of `rawInput` (repo-relative; "" / "." = root).
 * File entries carry their byte `size`; directory sizes come from `dirUsage`.
 */
export function listDir(rawInput: string, opts: ListOptions = {}): ListResult {
  const r = resolveDir(rawInput, opts);
  if (!r.ok) return r;
  const { ROOT, real, baseRel, cfg } = r;

  let dirents: Dirent[];
  try {
    dirents = readdirSync(real, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return reject("denied", 403, "permission denied");
    return reject("unresolvable", 400, `readdir failed: ${code}`);
  }

  const entries: DirEntry[] = [];
  for (const d of dirents) {
    const name = d.name;
    if (name === "." || name === "..") continue;
    const childRel = baseRel ? `${baseRel}/${name}` : name;

    // Classify kind, resolving symlinks WITH containment (a symlink whose
    // target escapes the root, or is broken, is skipped — never followed out).
    // Capture file byte size in the same stat (drives the row size + bars).
    let kind: "dir" | "file";
    let size: number | undefined;
    if (d.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(path.join(real, name));
      } catch {
        continue; // broken symlink
      }
      const tRel = path.relative(ROOT, target);
      if (tRel !== "" && (tRel.startsWith("..") || path.isAbsolute(tRel))) continue; // escapes root
      let tst: ReturnType<typeof statSync>;
      try {
        tst = statSync(target);
      } catch {
        continue;
      }
      if (tst.isDirectory()) kind = "dir";
      else if (tst.isFile()) {
        kind = "file";
        size = tst.size;
      } else continue; // socket / fifo / device
    } else if (d.isDirectory()) {
      kind = "dir";
    } else if (d.isFile()) {
      kind = "file";
      try {
        size = statSync(path.join(real, name)).size;
      } catch {
        size = undefined; // raced away; still listable, size just unknown
      }
    } else {
      continue; // fifo / socket / device / etc.
    }

    // Deny filter: hide denied entries entirely (don't leak the name). For
    // directories, also hide when their CONTENTS are categorically denied
    // (e.g. node_modules), so the tree never shows a dead, unexpandable folder.
    if (evaluateDeny(childRel, cfg).denied) continue;
    if (kind === "dir" && evaluateDeny(`${childRel}/${CONTENTS_PROBE}`, cfg).denied) continue;

    entries.push(
      kind === "file" ? { name, relPath: childRel, kind, size } : { name, relPath: childRel, kind },
    );
  }

  // Directories first, then files; case-insensitive name order within each.
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  return { ok: true, dir: baseRel, entries };
}

// ---------------------------------------------------------------------------
// dirUsage — recursive disk usage + file/folder counts (deny-aware, capped)
// ---------------------------------------------------------------------------

interface WalkBudget {
  entries: number;
  start: number;
  partial: boolean;
  maxEntries: number;
  maxMs: number;
}

const usageCache = new Map<string, { expires: number; value: DirUsage }>();

/** Recursively sum bytes + counts under `absDir`, honoring the deny model and
 * the per-child budget. Symlinks are NOT followed (cycle-safe; they're also
 * hidden from listings). Directory detection uses the Dirent (no extra stat);
 * only files are statted, for their size. */
function walkUsage(
  absDir: string,
  relDir: string,
  cfg: FilesConfig,
  budget: WalkBudget,
): DirUsageStats {
  const stats: DirUsageStats = { fileCount: 0, dirCount: 0, totalBytes: 0 };
  if (budget.partial) return stats;
  let dirents: Dirent[];
  try {
    dirents = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return stats; // unreadable subdir → contributes nothing
  }
  for (const d of dirents) {
    if (budget.entries >= budget.maxEntries || Date.now() - budget.start > budget.maxMs) {
      budget.partial = true;
      return stats;
    }
    const name = d.name;
    if (name === "." || name === "..") continue;
    if (d.isSymbolicLink()) continue; // never follow (cycles; hidden from listing too)
    budget.entries++;
    const childRel = `${relDir}/${name}`;
    if (d.isDirectory()) {
      if (evaluateDeny(childRel, cfg).denied) continue;
      if (evaluateDeny(`${childRel}/${CONTENTS_PROBE}`, cfg).denied) continue;
      const sub = walkUsage(path.join(absDir, name), childRel, cfg, budget);
      stats.dirCount += 1 + sub.dirCount;
      stats.fileCount += sub.fileCount;
      stats.totalBytes += sub.totalBytes;
    } else if (d.isFile()) {
      if (evaluateDeny(childRel, cfg).denied) continue;
      let sz = 0;
      try {
        sz = statSync(path.join(absDir, name)).size;
      } catch {
        sz = 0;
      }
      stats.fileCount += 1;
      stats.totalBytes += sz;
    }
  }
  return stats;
}

/**
 * Recursive disk usage + file/folder counts for `rawInput` and a per-immediate-
 * child-directory breakdown (so the tree can size every row's bar from one
 * call). Excludes everything the listing hides (node_modules, .git, secrets).
 * `partial: true` means a safety cap was hit and totals are a floor, not exact.
 * Per-process TTL cache (60s) keyed by canonical path.
 */
export function dirUsage(rawInput: string, opts: ListOptions = {}): UsageResult {
  const r = resolveDir(rawInput, opts);
  if (!r.ok) return r;
  const { ROOT, real, baseRel, cfg } = r;

  const cacheKey = `${ROOT}\u0000${baseRel}`;
  const cached = usageCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return { ok: true, ...cached.value };

  let dirents: Dirent[];
  try {
    dirents = readdirSync(real, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return reject("denied", 403, "permission denied");
    return reject("unresolvable", 400, `readdir failed: ${code}`);
  }

  const globalStart = Date.now();
  const children: Record<string, DirUsageStats> = {};
  const self: DirUsageStats = { fileCount: 0, dirCount: 0, totalBytes: 0 };
  let anyPartial = false;

  for (const d of dirents) {
    const name = d.name;
    if (name === "." || name === "..") continue;
    if (d.isSymbolicLink()) continue;
    const childRel = baseRel ? `${baseRel}/${name}` : name;
    if (d.isDirectory()) {
      if (evaluateDeny(childRel, cfg).denied) continue;
      if (evaluateDeny(`${childRel}/${CONTENTS_PROBE}`, cfg).denied) continue;
      // Fresh budget per child: a huge sibling can't starve this one. Cap the
      // time to whatever's left of the global deadline (floor USAGE_MIN_CHILD_MS
      // so late children still get a real number, just marked partial).
      const remaining = USAGE_GLOBAL_MAX_MS - (Date.now() - globalStart);
      const budget: WalkBudget = {
        entries: 0,
        start: Date.now(),
        partial: false,
        maxEntries: USAGE_PER_CHILD_MAX_ENTRIES,
        maxMs: Math.max(USAGE_MIN_CHILD_MS, Math.min(USAGE_PER_CHILD_MAX_MS, remaining)),
      };
      const sub = walkUsage(path.join(real, name), childRel, cfg, budget);
      children[name] = budget.partial ? { ...sub, partial: true } : sub;
      if (budget.partial) anyPartial = true;
      self.dirCount += 1 + sub.dirCount;
      self.fileCount += sub.fileCount;
      self.totalBytes += sub.totalBytes;
    } else if (d.isFile()) {
      if (evaluateDeny(childRel, cfg).denied) continue;
      let sz = 0;
      try {
        sz = statSync(path.join(real, name)).size;
      } catch {
        sz = 0;
      }
      self.fileCount += 1;
      self.totalBytes += sz;
    }
  }

  const value: DirUsage = { dir: baseRel, self, children, partial: anyPartial };
  usageCache.set(cacheKey, { expires: Date.now() + USAGE_TTL_MS, value });
  return { ok: true, ...value };
}

// ---------------------------------------------------------------------------
// searchFiles — fuzzy file-name search over a cached, deny-aware index
// ---------------------------------------------------------------------------

const indexCache = new Map<string, { expires: number; files: string[]; truncated: boolean }>();

function indexWalk(
  absDir: string,
  relDir: string,
  cfg: FilesConfig,
  acc: string[],
  state: { truncated: boolean },
): void {
  if (acc.length >= INDEX_MAX_FILES) {
    state.truncated = true;
    return;
  }
  let dirents: Dirent[];
  try {
    dirents = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirents) {
    const name = d.name;
    if (name === "." || name === "..") continue;
    if (d.isSymbolicLink()) continue;
    const childRel = relDir ? `${relDir}/${name}` : name;
    if (d.isDirectory()) {
      if (INDEX_SKIP_DIRS.has(name)) continue;
      if (evaluateDeny(childRel, cfg).denied) continue;
      if (evaluateDeny(`${childRel}/${CONTENTS_PROBE}`, cfg).denied) continue;
      indexWalk(path.join(absDir, name), childRel, cfg, acc, state);
      if (acc.length >= INDEX_MAX_FILES) {
        state.truncated = true;
        return;
      }
    } else if (d.isFile()) {
      if (evaluateDeny(childRel, cfg).denied) continue;
      acc.push(childRel);
    }
  }
}

function getIndex(
  ROOT: string,
  real: string,
  cfg: FilesConfig,
): { files: string[]; truncated: boolean } {
  const cached = indexCache.get(ROOT);
  if (cached && cached.expires > Date.now()) {
    return { files: cached.files, truncated: cached.truncated };
  }
  const acc: string[] = [];
  const state = { truncated: false };
  indexWalk(real, "", cfg, acc, state);
  indexCache.set(ROOT, {
    expires: Date.now() + INDEX_TTL_MS,
    files: acc,
    truncated: state.truncated,
  });
  return { files: acc, truncated: state.truncated };
}

/** True if every char of `q` appears in `s` in order (subsequence fuzzy). */
function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++;
  }
  return i === q.length;
}

/**
 * Fuzzy file-name search over the repo's file index (built once per ROOT, TTL
 * 5min, excluding denied + build-artifact dirs). Ranks exact/prefix/substring
 * basename matches above full-path matches above subsequence matches, then by
 * shorter path. Directories are not indexed (the viewer opens files).
 */
export function searchFiles(query: string, opts: SearchOptions = {}): SearchResultEnvelope {
  const r = resolveDir("", opts); // index is rooted at the repo root
  if (!r.ok) return r;
  const { ROOT, real, cfg } = r;
  const limit = opts.limit ?? 50;

  const q = (query ?? "").toLowerCase().trim();
  if (q.length === 0) {
    return { ok: true, query: query ?? "", matches: [], total: 0, truncated: false };
  }

  const { files, truncated: indexTruncated } = getIndex(ROOT, real, cfg);

  const scored: { p: string; score: number }[] = [];
  for (const p of files) {
    const lp = p.toLowerCase();
    const base = lp.slice(lp.lastIndexOf("/") + 1);
    let score: number;
    if (base === q) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (base.includes(q)) score = 2;
    else if (lp.includes(q)) score = 3;
    else if (isSubsequence(q, lp)) score = 4;
    else continue;
    scored.push({ p, score });
  }
  scored.sort((a, b) => a.score - b.score || a.p.length - b.p.length || (a.p < b.p ? -1 : 1));

  const matches = scored.slice(0, limit).map((s) => ({ relPath: s.p }));
  return {
    ok: true,
    query: query ?? "",
    matches,
    total: scored.length,
    truncated: indexTruncated || scored.length > limit,
  };
}

/** Reset the usage + search-index caches (tests / explicit invalidation). */
export function __resetFileTreeCaches(): void {
  usageCache.clear();
  indexCache.clear();
}
