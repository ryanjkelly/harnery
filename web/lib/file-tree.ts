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
import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import type { BrowseEntry, BrowseSearchResult } from "./browse-types";
import { coordRoot } from "./coord-reader";
import type { DirListing, DirUsage, DirUsageStats } from "./file-viewer/types";
import {
  evaluateDeny,
  type FilesConfig,
  loadFilesConfig,
  type RejectCode,
  type ResolveReject,
} from "./files";

export type ListResult =
  | ({ ok: true } & Omit<DirListing, "entries"> & { entries: BrowseEntry[] })
  | ResolveReject;
export type UsageResult = ({ ok: true } & DirUsage) | ResolveReject;
export type SearchResultEnvelope = ({ ok: true } & BrowseSearchResult) | ResolveReject;

export interface ListOptions {
  /** Override the containment root (tests use temp dirs). Defaults to
   * realpath(coordRoot()). */
  root?: string;
}

export interface SearchOptions extends ListOptions {
  dir?: string;
  /** Explicitly await the bounded initial index pass. */
  waitForIndex?: boolean;
  maxEntries?: number;
  refreshMs?: number;
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
 * global deadline bounds the whole call; remaining children are explicitly
 * marked partial without extending that deadline. */
const USAGE_PER_CHILD_MAX_ENTRIES = 40_000;
const USAGE_PER_CHILD_MAX_MS = 1_200;
const USAGE_GLOBAL_MAX_MS = 6_000;
const USAGE_TTL_MS = 5 * 60_000;

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
const INDEX_MAX_FILES = 200_000;
const INDEX_MAX_MS = 30_000;
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
export function resolveDir(rawInput: string, opts: ListOptions = {}): ResolvedDir | ResolveReject {
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

  if (
    !realIsRoot &&
    (evaluateDeny(baseRel, cfg).denied || evaluateDeny(`${baseRel}/${CONTENTS_PROBE}`, cfg).denied)
  ) {
    return reject("denied", 403, "blocked by policy");
  }

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

  const entries: BrowseEntry[] = [];
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
      const canonicalRel = tRel.split(path.sep).join("/");
      if (evaluateDeny(canonicalRel, cfg).denied) continue;
      let tst: ReturnType<typeof statSync>;
      try {
        tst = statSync(target);
      } catch {
        continue;
      }
      if (tst.isDirectory()) {
        if (evaluateDeny(`${canonicalRel}/_`, cfg).denied) continue;
        kind = "dir";
      } else if (tst.isFile()) {
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

    let mtime: string | undefined;
    try {
      mtime = statSync(path.join(real, name)).mtime.toISOString();
    } catch {
      /* raced away */
    }
    entries.push({ name, relPath: childRel, kind, ...(kind === "file" ? { size } : {}), mtime });
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
/** Deterministic race seam for containment tests; unset in production. */
export const __fileTreeTestHooks: { beforeDirectoryOpen?: (absolutePath: string) => void } = {};

/** Recheck queued directories after asynchronous yields. Never open a path
 * that was replaced with an alias, even if that alias remains inside root. */
async function openWalkDirectory(absDir: string) {
  __fileTreeTestHooks.beforeDirectoryOpen?.(absDir);
  const before = await lstat(absDir);
  if (!before.isDirectory() || (await realpath(absDir)) !== absDir)
    throw new Error("directory changed");
  const handle = await opendir(absDir);
  try {
    const after = await lstat(absDir);
    if (after.dev !== before.dev || after.ino !== before.ino || (await realpath(absDir)) !== absDir)
      throw new Error("directory changed");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Recursively sum bytes + counts under `absDir`, honoring the deny model and
 * the per-child budget. Symlinks are NOT followed (cycle-safe; they're also
 * hidden from listings). Directory detection uses the Dirent (no extra stat);
 * only files are statted, for their size. */
async function walkUsage(
  absDir: string,
  relDir: string,
  cfg: FilesConfig,
  budget: WalkBudget,
): Promise<DirUsageStats> {
  const stats: DirUsageStats = { fileCount: 0, dirCount: 0, totalBytes: 0 };
  if (budget.partial) return stats;
  let directory: Awaited<ReturnType<typeof openWalkDirectory>>;
  try {
    directory = await openWalkDirectory(absDir);
  } catch {
    budget.partial = true;
    return stats; // unreadable subdir → contributes nothing
  }
  for await (const d of directory) {
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
      const sub = await walkUsage(path.join(absDir, name), childRel, cfg, budget);
      stats.dirCount += 1 + sub.dirCount;
      stats.fileCount += sub.fileCount;
      stats.totalBytes += sub.totalBytes;
    } else if (d.isFile()) {
      if (evaluateDeny(childRel, cfg).denied) continue;
      let sz = 0;
      try {
        const file = await lstat(path.join(absDir, name));
        if (!file.isFile()) continue;
        sz = file.size;
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
export async function dirUsage(rawInput: string, opts: ListOptions = {}): Promise<UsageResult> {
  const r = resolveDir(rawInput, opts);
  if (!r.ok) return r;
  const { ROOT, real, baseRel, cfg } = r;

  const cacheKey = `${ROOT}\u0000${baseRel}\u0000${JSON.stringify(cfg)}`;
  const cached = usageCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return { ok: true, ...cached.value };

  let dirents: Dirent[];
  try {
    dirents = [];
    const directory = await openWalkDirectory(real);
    for await (const entry of directory) dirents.push(entry);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return reject("denied", 403, "permission denied");
    return reject("unresolvable", 400, `readdir failed: ${code}`);
  }

  const globalStart = Date.now();
  const children: Record<string, DirUsageStats> = Object.create(null);
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
      // time to whatever remains before the global deadline.
      const remaining = USAGE_GLOBAL_MAX_MS - (Date.now() - globalStart);
      if (remaining <= 0) {
        anyPartial = true;
        children[name] = { fileCount: 0, dirCount: 0, totalBytes: 0, partial: true };
        self.dirCount += 1;
        continue;
      }
      const budget: WalkBudget = {
        entries: 0,
        start: Date.now(),
        partial: false,
        maxEntries: USAGE_PER_CHILD_MAX_ENTRIES,
        maxMs: Math.min(USAGE_PER_CHILD_MAX_MS, remaining),
      };
      const sub = await walkUsage(path.join(real, name), childRel, cfg, budget);
      children[name] = budget.partial ? { ...sub, partial: true } : sub;
      if (budget.partial) anyPartial = true;
      self.dirCount += 1 + sub.dirCount;
      self.fileCount += sub.fileCount;
      self.totalBytes += sub.totalBytes;
    } else if (d.isFile()) {
      if (evaluateDeny(childRel, cfg).denied) continue;
      let sz = 0;
      try {
        const file = await lstat(path.join(real, name));
        if (!file.isFile()) continue;
        sz = file.size;
      } catch {
        sz = 0;
      }
      self.fileCount += 1;
      self.totalBytes += sz;
    }
  }

  const value: DirUsage = { dir: baseRel, self, children, partial: anyPartial };
  if (usageCache.size >= 32) usageCache.delete(usageCache.keys().next().value!);
  usageCache.set(cacheKey, { expires: Date.now() + USAGE_TTL_MS, value });
  return { ok: true, ...value };
}

// ---------------------------------------------------------------------------
// searchFiles — fuzzy file-name search over a cached, deny-aware index
// ---------------------------------------------------------------------------

interface SearchIndex {
  expires: number;
  entries: { relPath: string; kind: "file" | "dir" }[];
  partial: boolean;
  refreshing?: Promise<void>;
}
const indexCache = new Map<string, SearchIndex>();
let activeIndexBuilds = 0;

/** Cooperative breadth-first refresh. Previous results remain available during
 * refresh; the first pass publishes batches as directories complete. */
function refreshIndex(r: ResolvedDir, index: SearchIndex, opts: SearchOptions): Promise<void> {
  const previous = index.entries.length > 0;
  const fresh: SearchIndex["entries"] = [];
  const queue = [{ abs: r.real, rel: r.baseRel }];
  const maxEntries = Math.max(1, Math.min(INDEX_MAX_FILES, opts.maxEntries ?? INDEX_MAX_FILES));
  const started = Date.now();
  activeIndexBuilds++;
  return (async () => {
    let partial = false;
    scan: for (let cursor = 0; cursor < queue.length; cursor++) {
      const dir = queue[cursor];
      try {
        const handle = await openWalkDirectory(dir.abs);
        for await (const d of handle) {
          if (fresh.length >= maxEntries || Date.now() - started >= INDEX_MAX_MS) {
            partial = true;
            break scan;
          }
          if (d.isSymbolicLink()) continue;
          const childRel = dir.rel ? `${dir.rel}/${d.name}` : d.name;
          if (evaluateDeny(childRel, r.cfg).denied) continue;
          if (d.isDirectory()) {
            if (evaluateDeny(`${childRel}/${CONTENTS_PROBE}`, r.cfg).denied) continue;
            fresh.push({ relPath: childRel, kind: "dir" });
            if (!INDEX_SKIP_DIRS.has(d.name))
              queue.push({ abs: path.join(dir.abs, d.name), rel: childRel });
          } else if (d.isFile()) fresh.push({ relPath: childRel, kind: "file" });
          if (fresh.length % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } catch {
        partial = true;
      }
      if (!previous) index.entries = fresh;
    }
    index.entries = fresh;
    index.partial = partial;
    index.expires = Date.now() + (opts.refreshMs ?? INDEX_TTL_MS);
  })().finally(() => {
    activeIndexBuilds--;
    index.refreshing = undefined;
  });
}

async function getIndex(r: ResolvedDir, opts: SearchOptions): Promise<SearchIndex> {
  // A changed deny policy must not reuse an earlier snapshot.
  const key = `${r.ROOT}\u0000${r.baseRel}\u0000${JSON.stringify(r.cfg)}`;
  let index = indexCache.get(key);
  if (!index) {
    if (indexCache.size >= 12) {
      const idleKey = [...indexCache].find(([, value]) => !value.refreshing)?.[0];
      if (idleKey) indexCache.delete(idleKey);
    }
    index = { expires: 0, entries: [], partial: false };
    indexCache.set(key, index);
  }
  if (index.expires <= Date.now() && !index.refreshing && activeIndexBuilds < 2)
    index.refreshing = refreshIndex(r, index, opts);
  if (index.refreshing) {
    if (opts.waitForIndex) await index.refreshing;
    else if (!index.entries.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        index.refreshing,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 40);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
  }
  return index;
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
 * shorter path. Folders are indexed for navigation as well as files.
 */
export async function searchFiles(
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResultEnvelope> {
  const r = resolveDir(opts.dir ?? "", opts);
  if (!r.ok) return r;
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

  const q = (query ?? "").toLowerCase().trim();
  if (q.length === 0) {
    return { ok: true, query: query ?? "", matches: [], total: 0, truncated: false };
  }

  const index = await getIndex(r, opts);
  const indexing = Boolean(index.refreshing) || index.expires <= Date.now();

  const scored: { p: string; kind: "dir" | "file"; score: number }[] = [];
  const compare = (a: (typeof scored)[number], b: (typeof scored)[number]) =>
    a.score - b.score || a.p.length - b.p.length || a.p.localeCompare(b.p);
  let total = 0;
  let visited = 0;
  const entries = index.entries;
  const available = entries.length;
  for (let entryIndex = 0; entryIndex < available; entryIndex++) {
    const entry = entries[entryIndex];
    if (++visited % 2048 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const p = entry.relPath;
    const lp = p.toLowerCase();
    const base = lp.slice(lp.lastIndexOf("/") + 1);
    let score: number;
    if (base === q) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (base.includes(q)) score = 2;
    else if (lp.includes(q)) score = 3;
    else if (isSubsequence(q, lp)) score = 4;
    else continue;
    total++;
    const match = { p, kind: entry.kind, score };
    let low = 0;
    let high = scored.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compare(scored[mid], match) <= 0) low = mid + 1;
      else high = mid;
    }
    if (low < limit) {
      scored.splice(low, 0, match);
      if (scored.length > limit) scored.pop();
    }
  }

  const matches = scored.slice(0, limit).map((s) => ({ relPath: s.p, kind: s.kind }));
  return {
    ok: true,
    query: query ?? "",
    matches,
    total,
    truncated: index.partial || indexing || total > limit,
    indexing,
  };
}

/** Reset the usage + search-index caches (tests / explicit invalidation). */
export function __resetFileTreeCaches(): void {
  usageCache.clear();
  indexCache.clear();
}
