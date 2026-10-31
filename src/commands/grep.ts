import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { resolveSearchEngine, type SearchEngine } from "../lib/tools/ripgrep.ts";

/**
 * `grep`: monorepo-aware code search. Prefers ripgrep (`rg`) when it is on
 * PATH and falls back to GNU/BSD grep transparently — both engines are driven
 * with equivalent flags and their output is parsed into the same envelope, so
 * results are identical (pinned by tests/unit/grep-engine.test.ts).
 * Smart default excludes (skip dist/.next/node_modules/.git/...), repo
 * scoping (`--repo <name>` or `--all-repos`), language presets, file-level
 * boolean composition (`--and` / `--without`), and context (`-C`/`-A`/`-B`).
 *
 * Engine selection: `HARNERY_GREP_ENGINE=rg|grep` forces one; otherwise `rg`
 * is resolved (managed install, PATH, or opt-in auto-provision; see
 * resolveEngine) and used when available. Repos are searched in parallel, and
 * in `--all-repos` mode the parent scan prunes submodule directories so each
 * match is attributed to exactly one repo.
 *
 * Output framing: content searches request the NUL filename delimiter
 * (`--null` on both engines — the long spelling, because BSD grep repurposes
 * `-Z` for decompression) so filename boundaries are never inferred from
 * punctuation. Context lines are NOT requested from the engines: matches are
 * selected (and budgeted) first, then context windows are materialized from
 * one file read per selected file, which keeps `--limit` semantics exact and
 * both engines byte-identical.
 *
 * Default behavior matches extended-regex semantics (`grep -E` / ripgrep's
 * default). Use `-F` / `--literal` to pin to literal-string mode. Output is
 * line-oriented `file:line:content` in TTY mode (context rows render
 * grep-style as `file-line-content`); `--json` emits the full GrepResult
 * envelope `{ pattern, mode, engine, and_patterns, without_patterns, repos,
 * total_matches, total_files, truncated, elapsed_ms }`. Matches are sorted
 * (file, then line) for stable output across runs and engines.
 *
 * Bounded output and paging: a search shows at most DEFAULT_LIMIT result rows
 * unless `--limit <n>` or `--all` says otherwise, and clips each printed line
 * to DEFAULT_MAX_COLUMNS characters (`--max-columns 0` turns clipping off).
 * Both defaults exist because every search result is re-read by an agent's
 * next model turn: a typical search returns about a dozen rows, so 50 rows
 * leaves ordinary searches untouched and stops a broad pattern from flooding
 * the context, and 300 columns keeps any hand-written source line while
 * cutting minified or generated ones. When rows are left out, a count pass
 * (the same search with `-c`, which prints one short row per file) supplies
 * the totals, and the last line states how many matches and files were left
 * out and the `--page <n>` that continues. Pages are cut from one global order
 * (repo order, then file path, then line), so `--page 2` starts exactly where
 * page 1 stopped, whichever engine ran. A content page is fetched by searching
 * only the files that hold its rows.
 */

/** Result rows shown when neither --limit nor --all is given. */
export const DEFAULT_LIMIT = 50;
/** Characters kept per printed line unless --max-columns says otherwise. */
export const DEFAULT_MAX_COLUMNS = 300;
/** Explicit file arguments per engine call when fetching a content page. */
const PAGE_FILE_BATCH = 200;

const DEFAULT_EXCLUDE_DIRS = [
  ".git",
  ".cache",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  "vendor",
  "__pycache__",
  ".venv",
  "tmp",
  "tmp-files",
  "coverage",
  ".parcel-cache",
  ".turbo",
  ".harnery",
];

// (no file-name excludes by default).
const DEFAULT_EXCLUDE_FILES: string[] = [];

const LANG_GLOBS: Record<string, string[]> = {
  ts: ["*.ts"],
  tsx: ["*.tsx"],
  js: ["*.js", "*.mjs", "*.cjs"],
  jsx: ["*.jsx"],
  py: ["*.py"],
  php: ["*.php"],
  sql: ["*.sql"],
  md: ["*.md", "*.mdx"],
  sh: ["*.sh", "*.bash"],
  json: ["*.json"],
  yaml: ["*.yaml", "*.yml"],
  rb: ["*.rb"],
  go: ["*.go"],
  rs: ["*.rs"],
};

export type GrepEngine = SearchEngine;

export interface GrepOpts {
  repo?: string;
  allRepos?: boolean;
  /** Repeatable and/or comma-separated (`--lang ts,tsx`). A bare string is accepted for direct callers. */
  lang?: string | string[];
  ignoreCase?: boolean;
  wholeWord?: boolean;
  literal?: boolean;
  filesOnly?: boolean;
  files?: boolean;
  count?: boolean;
  context?: string;
  afterContext?: string;
  beforeContext?: string;
  maxCount?: string;
  limit?: string;
  /** 1-based page of `limit`-sized pages. */
  page?: string;
  /** Lift the default row bound (no paging). */
  all?: boolean;
  /** Characters kept per line; "0" disables clipping. */
  maxColumns?: string;
  include?: string[];
  exclude?: string[];
  and?: string[];
  without?: string[];
  quiet?: boolean;
  noDefaultExcludes?: boolean;
  json?: boolean;
}

export interface Match {
  repo: string;
  file: string;
  line: number;
  text: string;
  /** "match" = primary result row (counts toward totals + --limit); "context" = free -C/-A/-B row. */
  kind: "match" | "context";
  /** Characters removed from `text` by --max-columns clipping (absent when whole). */
  clipped?: number;
}

export function registerGrepCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  program
    .command("grep <pattern> [paths...]")
    .description(
      "Monorepo-aware code search (ripgrep when available, GNU grep fallback). " +
        "Skips dist/.next/node_modules/.git/... by default. " +
        "Use --repo, --all-repos, --lang for scoping; --and/--without for file-level composition. " +
        "Regex by default; -F for literal.",
    )
    .option("--repo <name>", "Scope to one submodule (`.` = parent repo root)")
    .option("--all-repos", "Search parent + every submodule")
    .option(
      "--lang <lang>",
      `File type preset, repeatable or comma-separated (${Object.keys(LANG_GLOBS).join(", ")})`,
      collect,
      [] as string[],
    )
    .option("-i, --ignore-case", "Case-insensitive match")
    .option("-w, --whole-word", "Match whole words only")
    .option("-F, --literal", "Treat <pattern> as a literal string (no regex)")
    .option("-l, --files-only", "Only print file names containing a match")
    .option(
      "--files",
      "Filename search: treat <pattern> as a filename glob and list matching files " +
        "(rg --files when available, POSIX find fallback)",
    )
    .option("-c, --count", "Print match count per file (suppresses content)")
    .option("-C, --context <n>", "Print N lines of context around each match", "0")
    .option("-A, --after-context <n>", "Print N lines after each match (overrides -C's after side)")
    .option(
      "-B, --before-context <n>",
      "Print N lines before each match (overrides -C's before side)",
    )
    .option("--max-count <n>", "Stop after N matches per file")
    .option("--limit <n>", `Show at most N result rows per page (default ${DEFAULT_LIMIT})`)
    .option("--page <n>", "Show page N of --limit-sized pages (1-based; default 1)")
    .option("--all", "Show every result row (no default bound, no paging)")
    .option(
      "--max-columns <n>",
      `Clip each printed line to N characters (default ${DEFAULT_MAX_COLUMNS}; 0 = no clipping)`,
    )
    .option(
      "--and <pattern>",
      "Only show files that ALSO contain this pattern (file-level, repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--without <pattern>",
      "Drop files that contain this pattern (file-level, repeatable)",
      collect,
      [] as string[],
    )
    .option("-q, --quiet", "No output; exit 0 if any match exists, 1 if none")
    .option("--include <glob>", "Extra --include glob (repeatable)", collect, [] as string[])
    .option("--exclude <glob>", "Extra --exclude glob (repeatable)", collect, [] as string[])
    .option("--no-default-excludes", "Disable the default skip list (node_modules, dist, etc.)")
    .option("--json", "Structured JSON envelope")
    .action(async (pattern: string, paths: string[], opts: GrepOpts) => {
      try {
        const result = await runGrep(pattern, paths, opts, context);
        if (opts.quiet) {
          // No output by contract; grep-conventional status. exitCode (not
          // process.exit) so an embedding host isn't terminated mid-flush.
          process.exitCode = result.total_matches > 0 ? 0 : 1;
          return;
        }
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(result);
          return;
        }
        emit.text(`${renderResult(result, opts)}\n`);
      } catch (err) {
        emit.error({ code: "grep_failed", message: (err as Error).message });
        process.exit(1);
      }
    });
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

export interface GrepResult {
  pattern: string;
  mode: "regex" | "literal" | "files";
  engine: GrepEngine;
  and_patterns: string[];
  without_patterns: string[];
  repos: { name: string; cwd: string; matches: Match[]; truncated: boolean }[];
  /** Result rows shown on this page (context rows excluded). */
  total_matches: number;
  /** Files with at least one shown row. */
  total_files: number;
  /** More rows exist after this page. */
  truncated: boolean;
  /** Page size; null with --all. */
  limit: number | null;
  page: number;
  /** Result rows / files the whole search found, across every page. */
  available_matches: number;
  available_files: number;
  /** Rows / files the search found that this page does not show. */
  omitted_matches: number;
  omitted_files: number;
  /** The --page value that continues, or null on the last page. */
  next_page: number | null;
  elapsed_ms: number;
}

/** Validated, resolved options — built once before repo fan-out. */
interface NormOpts {
  limit: number; // page size; Infinity with --all
  offset: number; // rows skipped before this page
  page: number;
  maxColumns: number; // Infinity when clipping is off
  maxCount: number | undefined;
  before: number;
  after: number;
  langGlobs: string[] | undefined;
  andPatterns: string[];
  withoutPatterns: string[];
}

/**
 * Parse a strictly-decimal integer option. Rejects empty, negative, signed,
 * fractional, and trailing-junk values before any engine is spawned.
 */
function parseIntOpt(flag: string, raw: string, min: number): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${flag} expects a non-negative integer, got "${raw}"`);
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (n < min) throw new Error(`${flag} must be >= ${min}, got ${n}`);
  return n;
}

function normalizeLangs(lang: string | string[] | undefined): string[] | undefined {
  const rawValues = typeof lang === "string" ? [lang] : (lang ?? []);
  const keys: string[] = [];
  for (const raw of rawValues) {
    for (const piece of raw.split(",")) {
      const key = piece.trim();
      if (key === "") continue;
      if (!LANG_GLOBS[key]) {
        throw new Error(`unknown --lang "${key}". Valid: ${Object.keys(LANG_GLOBS).join(", ")}`);
      }
      if (!keys.includes(key)) keys.push(key);
    }
  }
  if (keys.length === 0) return undefined;
  const globs: string[] = [];
  for (const key of keys) {
    const langGlobs = LANG_GLOBS[key];
    if (!langGlobs) continue;
    for (const g of langGlobs) if (!globs.includes(g)) globs.push(g);
  }
  return globs;
}

/** Validate numerics, resolve context sides, expand langs, enforce the compatibility matrix. */
function normalizeOpts(opts: GrepOpts): NormOpts {
  if (opts.all && opts.limit) throw new Error("--all does not combine with --limit");
  if (opts.all && opts.page) throw new Error("--all does not combine with --page");
  const limit = opts.all
    ? Number.POSITIVE_INFINITY
    : opts.limit
      ? parseIntOpt("--limit", opts.limit, 1)
      : DEFAULT_LIMIT;
  const page = opts.page ? parseIntOpt("--page", opts.page, 1) : 1;
  const maxColumnsRaw =
    opts.maxColumns !== undefined
      ? parseIntOpt("--max-columns", opts.maxColumns, 0)
      : DEFAULT_MAX_COLUMNS;
  const maxCount = opts.maxCount ? parseIntOpt("--max-count", opts.maxCount, 1) : undefined;
  const c = opts.context !== undefined ? parseIntOpt("-C/--context", opts.context, 0) : 0;
  const before =
    opts.beforeContext !== undefined
      ? parseIntOpt("-B/--before-context", opts.beforeContext, 0)
      : c;
  const after =
    opts.afterContext !== undefined ? parseIntOpt("-A/--after-context", opts.afterContext, 0) : c;
  const andPatterns = opts.and ?? [];
  const withoutPatterns = opts.without ?? [];
  const contextActive = before > 0 || after > 0;

  if (opts.files) {
    // Filename mode lists files by name glob; content-search flags make no
    // sense here — reject loudly rather than silently ignoring them.
    const incompatible: [unknown, string][] = [
      [normalizeLangs(opts.lang)?.length, "--lang"],
      [opts.count, "-c/--count"],
      [opts.wholeWord, "-w/--whole-word"],
      [opts.literal, "-F/--literal"],
      [opts.maxCount, "--max-count"],
      [opts.include?.length, "--include"],
      [contextActive ? true : undefined, "-C/-A/-B context"],
      [andPatterns.length ? true : undefined, "--and"],
      [withoutPatterns.length ? true : undefined, "--without"],
    ];
    for (const [set, flag] of incompatible) {
      if (set) throw new Error(`${flag} does not apply to --files (filename glob) mode`);
    }
  }
  if (contextActive) {
    const rejected: [unknown, string][] = [
      [opts.filesOnly, "-l/--files-only"],
      [opts.count, "-c/--count"],
      [opts.quiet, "-q/--quiet"],
    ];
    for (const [set, flag] of rejected) {
      if (set) throw new Error(`-C/-A/-B context does not combine with ${flag}`);
    }
  }
  if (opts.quiet) {
    const rejected: [unknown, string][] = [
      [opts.json, "--json"],
      [opts.filesOnly, "-l/--files-only"],
      [opts.count, "-c/--count"],
      [opts.limit, "--limit"],
      [opts.page, "--page"],
      [opts.all, "--all"],
    ];
    for (const [set, flag] of rejected) {
      if (set) throw new Error(`-q/--quiet does not combine with ${flag}`);
    }
  }

  return {
    // -q only needs existence: one accepted primary row settles the exit code.
    limit: opts.quiet ? 1 : limit,
    offset: opts.quiet || !Number.isFinite(limit) ? 0 : (page - 1) * limit,
    page,
    maxColumns: maxColumnsRaw === 0 ? Number.POSITIVE_INFINITY : maxColumnsRaw,
    maxCount,
    before,
    after,
    langGlobs: normalizeLangs(opts.lang),
    andPatterns,
    withoutPatterns,
  };
}

/** Exported for tests (not part of the package exports map). */
export async function runGrep(
  pattern: string,
  paths: string[],
  opts: GrepOpts,
  context: HarneryProgramContext | undefined,
): Promise<GrepResult> {
  if (!pattern) throw new Error("pattern required");
  const norm = normalizeOpts(opts);
  const started = Date.now();

  const { engine, rgBin } = await resolveSearchEngine("grep");
  const repos = resolveRepos(opts, context);

  // Host-injected default excludes (generated mirrors, vendored trees, ...)
  // ride the same --no-default-excludes gate as the built-in list.
  const hostExcludeDirs = opts.noDefaultExcludes ? [] : (context?.grepExcludeDirs ?? []);

  // In --all-repos mode the parent scan prunes submodule dirs — each
  // submodule gets its own scoped scan, so descending from the parent would
  // double-scan and double-report every submodule match. This pruning is
  // correctness (one repo owns each match), so it applies even when
  // --no-default-excludes is set.
  const extraDirsFor = (repo: { name: string }): string[] => {
    const dedupeDirs = opts.allRepos && repo.name === "parent" ? (context?.submodules ?? []) : [];
    return [...hostExcludeDirs, ...dedupeDirs];
  };
  const scan = (
    repo: { name: string; cwd: string },
    scanPaths: string[],
    scanOpts: GrepOpts,
    scanNorm: NormOpts,
    acceptLimit: number,
  ): Promise<Match[]> =>
    runGrepInRepo(
      pattern,
      scanPaths,
      scanOpts,
      scanNorm,
      repo.cwd,
      repo.name,
      acceptLimit,
      engine,
      rgBin,
      extraDirsFor(repo),
    );
  const byPosition = (a: Match, b: Match) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line;

  // Every path yields, per repo, the selected rows (sorted) plus what the
  // whole search found there, so the page window can be stated exactly.
  let selected: Match[][];
  let available: { matches: number; files: Set<string> }[];
  let after: boolean[]; // rows exist in this repo after the page window

  if (opts.quiet) {
    // Existence only: one accepted row settles the exit code, so the engine is
    // stopped at the first hit and no count pass runs.
    selected = await Promise.all(repos.map((repo) => scan(repo, paths, opts, norm, 1)));
    available = selected.map((rows) => ({
      matches: rows.length,
      files: new Set(rows.map((m) => m.file)),
    }));
    after = selected.map(() => false);
  } else if (!Number.isFinite(norm.limit) || opts.files || opts.filesOnly || opts.count) {
    // --all, or a mode whose rows are files (one short row each): collect the
    // complete result, then cut the page from its sorted order.
    const all = await Promise.all(
      repos.map((repo) => scan(repo, paths, opts, norm, Number.POSITIVE_INFINITY)),
    );
    for (const rows of all) rows.sort(byPosition);
    available = all.map((rows) => ({
      matches: rows.length,
      files: new Set(rows.map((m) => m.file)),
    }));
    const windows = pageWindows(
      all.map((rows) => rows.map(() => 1)),
      norm.offset,
      norm.limit,
    );
    selected = all.map((rows, i) => rows.slice(windows[i]?.start ?? 0, windows[i]?.end ?? 0));
    after = all.map((rows, i) => (windows[i]?.end ?? 0) < rows.length);
  } else {
    // Content page. The count pass reports one row per file (path + matching
    // line count) for the whole search; the page window is computed from those
    // counts, and only the files holding the window's rows are searched again.
    const countOpts: GrepOpts = { ...opts, count: true };
    const counts = await Promise.all(
      repos.map((repo) => scan(repo, paths, countOpts, norm, Number.POSITIVE_INFINITY)),
    );
    for (const rows of counts) rows.sort(byPosition);
    available = counts.map((rows) => ({
      matches: rows.reduce((sum, r) => sum + r.line, 0),
      files: new Set(rows.map((r) => r.file)),
    }));
    // Expand per-file counts into a row index space without materializing rows.
    const windows = pageWindows(
      counts.map((rows) => rows.map((r) => r.line)),
      norm.offset,
      norm.limit,
    );
    // The selected files already passed --and/--without, so the page fetch
    // skips the membership scans.
    const fetchNorm: NormOpts = { ...norm, andPatterns: [], withoutPatterns: [] };
    selected = await Promise.all(
      repos.map(async (repo, i) => {
        const w = windows[i];
        const rows = counts[i] ?? [];
        if (!w || w.start >= w.end) return [];
        const picks = sliceFiles(rows, w.start, w.end);
        const fetched: Match[] = [];
        for (let b = 0; b < picks.length; b += PAGE_FILE_BATCH) {
          const batch = picks.slice(b, b + PAGE_FILE_BATCH);
          fetched.push(
            ...(await scan(
              repo,
              batch.map((p) => p.file),
              opts,
              fetchNorm,
              Number.POSITIVE_INFINITY,
            )),
          );
        }
        fetched.sort(byPosition);
        const out: Match[] = [];
        for (const pick of picks) {
          const inFile = fetched.filter((m) => m.file === pick.file);
          out.push(...inFile.slice(pick.skip, pick.skip + pick.take));
        }
        return out;
      }),
    );
    after = counts.map((_, i) => (windows[i]?.end ?? 0) < (available[i]?.matches ?? 0));
  }

  const allRepoResults: GrepResult["repos"] = [];
  let totalMatches = 0;
  const filesSeen = new Set<string>();
  let availableMatches = 0;
  let availableFiles = 0;

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    if (!repo) continue;
    let matches = selected[i] ?? [];
    totalMatches += matches.length;
    availableMatches += available[i]?.matches ?? 0;
    availableFiles += available[i]?.files.size ?? 0;
    for (const m of matches) filesSeen.add(`${repo.name}/${m.file}`);
    // Context is materialized only for the SELECTED rows, after paging, so
    // context rows never consume the limit and trailing context is never cut
    // off by an engine kill.
    if (!opts.files && !opts.filesOnly && !opts.count && (norm.before > 0 || norm.after > 0)) {
      matches = await materializeContext(matches, repo.cwd, norm.before, norm.after);
    }
    if (Number.isFinite(norm.maxColumns)) matches = matches.map((m) => clip(m, norm.maxColumns));
    allRepoResults.push({ name: repo.name, cwd: repo.cwd, matches, truncated: after[i] ?? false });
  }

  const truncated = allRepoResults.some((r) => r.truncated);
  return {
    pattern,
    mode: opts.files ? "files" : opts.literal ? "literal" : "regex",
    engine,
    and_patterns: norm.andPatterns,
    without_patterns: norm.withoutPatterns,
    repos: allRepoResults,
    total_matches: totalMatches,
    total_files: filesSeen.size,
    truncated,
    limit: Number.isFinite(norm.limit) && !opts.quiet ? norm.limit : null,
    page: opts.quiet ? 1 : norm.page,
    available_matches: availableMatches,
    available_files: availableFiles,
    omitted_matches: availableMatches - totalMatches,
    omitted_files: availableFiles - filesSeen.size,
    next_page: truncated && !opts.quiet ? norm.page + 1 : null,
    elapsed_ms: Date.now() - started,
  };
}

/**
 * Cut the page window [offset, offset + limit) out of one global row order:
 * repos in order, each repo's rows in sorted order. `weights[i][j]` is how many
 * rows item j of repo i stands for (1 for a row, a file's count in the count
 * pass). Returns each repo's window as row indices local to that repo.
 */
function pageWindows(
  weights: number[][],
  offset: number,
  limit: number,
): { start: number; end: number }[] {
  const end = offset + limit;
  let base = 0;
  return weights.map((items) => {
    const size = items.reduce((sum, w) => sum + w, 0);
    const start = Math.min(size, Math.max(0, offset - base));
    const stop = Math.min(size, Math.max(0, end - base));
    base += size;
    return { start, end: stop };
  });
}

/** Which files (and which of their rows) a local row window covers. */
function sliceFiles(
  counts: Match[],
  start: number,
  end: number,
): { file: string; skip: number; take: number }[] {
  const picks: { file: string; skip: number; take: number }[] = [];
  let pos = 0;
  for (const row of counts) {
    const fileStart = pos;
    const fileEnd = pos + row.line;
    pos = fileEnd;
    if (fileEnd <= start) continue;
    if (fileStart >= end) break;
    const skip = Math.max(0, start - fileStart);
    const take = Math.min(fileEnd, end) - fileStart - skip;
    if (take > 0) picks.push({ file: row.file, skip, take });
  }
  return picks;
}

/** Clip a row's text to `max` characters, recording how many were removed. */
function clip(m: Match, max: number): Match {
  if (m.text.length <= max) return m;
  return { ...m, text: m.text.slice(0, max), clipped: m.text.length - max };
}

function resolveRepos(
  opts: GrepOpts,
  context: HarneryProgramContext | undefined,
): { name: string; cwd: string }[] {
  const repoRoot = context?.repoRoot;
  const submodules = context?.submodules;
  if (opts.allRepos) {
    if (!repoRoot || !submodules) {
      throw new Error("--all-repos requires harnery to be configured with repoRoot + submodules");
    }
    const out: { name: string; cwd: string }[] = [{ name: "parent", cwd: repoRoot }];
    for (const name of submodules) out.push({ name, cwd: `${repoRoot}/${name}` });
    return out;
  }
  if (opts.repo) {
    if (opts.repo === "." || opts.repo === "parent") {
      if (!repoRoot) {
        throw new Error('--repo "." requires harnery to be configured with repoRoot');
      }
      return [{ name: "parent", cwd: repoRoot }];
    }
    if (!submodules || !repoRoot) {
      throw new Error(
        `--repo "${opts.repo}" requires harnery to be configured with repoRoot + submodules`,
      );
    }
    const found = submodules.find((n) => n === opts.repo);
    if (!found) {
      throw new Error(`unknown repo "${opts.repo}". Valid: parent (.), ${submodules.join(", ")}`);
    }
    return [{ name: found, cwd: `${repoRoot}/${found}` }];
  }
  return [{ name: "cwd", cwd: process.cwd() }];
}

async function runGrepInRepo(
  pattern: string,
  paths: string[],
  opts: GrepOpts,
  norm: NormOpts,
  cwd: string,
  repoName: string,
  acceptLimit: number,
  engine: GrepEngine,
  rgBin: string,
  extraExcludeDirs: readonly string[],
): Promise<Match[]> {
  // File-level boolean composition: build the complete auxiliary file sets
  // FIRST (no limit — a partial set can't prove absence), then feed the
  // primary scan an in-stream predicate. Running the primary with its limit
  // and filtering afterwards would let non-qualifying early hits consume the
  // budget and hide later valid results.
  let predicate: ((file: string) => boolean) | undefined;
  if (norm.andPatterns.length > 0 || norm.withoutPatterns.length > 0) {
    const requiredSets: Set<string>[] = [];
    // Sequential, not parallel: repeated flags must not multiply peak child
    // process concurrency by repos x patterns. Repo workers stay parallel.
    for (const p of norm.andPatterns) {
      const files = await runFileSetScan(
        p,
        paths,
        opts,
        norm,
        cwd,
        engine,
        rgBin,
        extraExcludeDirs,
      );
      if (files.size === 0) return []; // intersection is already empty
      requiredSets.push(files);
    }
    const forbidden = new Set<string>();
    for (const p of norm.withoutPatterns) {
      const files = await runFileSetScan(
        p,
        paths,
        opts,
        norm,
        cwd,
        engine,
        rgBin,
        extraExcludeDirs,
      );
      for (const f of files) forbidden.add(f);
    }
    predicate = (file) => requiredSets.every((s) => s.has(file)) && !forbidden.has(file);
  }

  const [bin, args, decodeMode] = buildEngineInvocation(
    pattern,
    paths,
    opts,
    norm,
    engine,
    rgBin,
    extraExcludeDirs,
    false,
  );

  let matches = await execSearch(bin, args, cwd, acceptLimit, decodeMode, predicate, false);
  // -c mode: GNU grep prints a `path:0` row for every searched file; ripgrep
  // omits zero-count rows. Filter zeros on both engines so output matches.
  if (opts.count) matches = matches.filter((m) => m.line > 0);
  return matches.map((m) => ({ ...m, repo: repoName }));
}

/** Membership scan for one --and/--without pattern: complete files-only set, strict failure. */
async function runFileSetScan(
  pattern: string,
  paths: string[],
  opts: GrepOpts,
  norm: NormOpts,
  cwd: string,
  engine: GrepEngine,
  rgBin: string,
  extraExcludeDirs: readonly string[],
): Promise<Set<string>> {
  const [bin, args, decodeMode] = buildEngineInvocation(
    pattern,
    paths,
    opts,
    norm,
    engine,
    rgBin,
    extraExcludeDirs,
    true,
  );
  const rows = await execSearch(
    bin,
    args,
    cwd,
    Number.POSITIVE_INFINITY,
    decodeMode,
    undefined,
    true,
  );
  return new Set(rows.map((r) => r.file));
}

type DecodeMode = "content" | "count" | "filesOnly" | "plainLines";

/**
 * Build one engine invocation. `membership: true` forces files-only mode for
 * --and/--without set scans (match-shaping + scope flags shared with the
 * primary; output flags not applied).
 */
function buildEngineInvocation(
  pattern: string,
  paths: string[],
  opts: GrepOpts,
  norm: NormOpts,
  engine: GrepEngine,
  rgBin: string,
  extraExcludeDirs: readonly string[],
  membership: boolean,
): [string, string[], DecodeMode] {
  if (opts.files) {
    // Filename mode keeps its existing rg/find framing (plain lines).
    return engine === "rg"
      ? [rgBin, buildRgFilesArgs(pattern, paths, opts, extraExcludeDirs), "plainLines"]
      : ["find", buildFindArgs(pattern, paths, opts, extraExcludeDirs), "plainLines"];
  }
  const filesOnly = membership || Boolean(opts.filesOnly);
  const count = !membership && Boolean(opts.count);
  const decodeMode: DecodeMode = filesOnly ? "filesOnly" : count ? "count" : "content";
  const args =
    engine === "rg"
      ? buildRgArgs(pattern, paths, opts, norm, extraExcludeDirs, { filesOnly, count })
      : buildGrepArgs(pattern, paths, opts, norm, extraExcludeDirs, { filesOnly, count });
  return [engine === "rg" ? rgBin : "grep", args, decodeMode];
}

interface OutputShape {
  filesOnly: boolean;
  count: boolean;
}

function buildGrepArgs(
  pattern: string,
  paths: string[],
  opts: GrepOpts,
  norm: NormOpts,
  extraExcludeDirs: readonly string[],
  shape: OutputShape,
): string[] {
  // --null (NOT -Z: BSD grep repurposes -Z for decompression): NUL after the
  // filename, so paths containing colons/dashes can't confuse the decoder.
  // -I: skip binary files. Context is never requested from the engine — see
  // materializeContext.
  const args: string[] = ["-rn", "-H", "--null", "--color=never", "-I"];
  if (opts.ignoreCase) args.push("-i");
  if (opts.wholeWord) args.push("-w");
  if (opts.literal) args.push("-F");
  else args.push("-E");
  if (shape.filesOnly) args.push("-l");
  if (shape.count) args.push("-c");
  if (norm.maxCount !== undefined) args.push(`-m${norm.maxCount}`);

  if (!opts.noDefaultExcludes) {
    for (const d of DEFAULT_EXCLUDE_DIRS) args.push(`--exclude-dir=${d}`);
    for (const f of DEFAULT_EXCLUDE_FILES) args.push(`--exclude=${f}`);
  }
  for (const d of extraExcludeDirs) args.push(`--exclude-dir=${d}`);
  for (const e of opts.exclude ?? []) args.push(`--exclude=${e}`);

  if (norm.langGlobs) for (const g of norm.langGlobs) args.push(`--include=${g}`);
  for (const g of opts.include ?? []) args.push(`--include=${g}`);

  args.push("--", pattern);
  if (paths.length > 0) args.push(...paths);
  else args.push(".");
  return args;
}

function buildRgArgs(
  pattern: string,
  paths: string[],
  opts: GrepOpts,
  norm: NormOpts,
  extraExcludeDirs: readonly string[],
  shape: OutputShape,
): string[] {
  // --hidden --no-ignore: match GNU grep's semantics (search dotdirs, ignore
  // .gitignore) so the only filters are the explicit exclude lists.
  // --no-config: a user's ripgrep config file must not skew results.
  // --with-filename: rg drops the file prefix for a single explicit file arg,
  // which would break the shared decoder.
  // --null: NUL after the filename (same spelling as GNU/BSD grep's long flag).
  const args: string[] = [
    "-n",
    "--no-heading",
    "--with-filename",
    "--null",
    "--color=never",
    "--no-config",
    "--hidden",
    "--no-ignore",
  ];
  if (opts.ignoreCase) args.push("-i");
  if (opts.wholeWord) args.push("-w");
  if (opts.literal) args.push("-F");
  if (shape.filesOnly) args.push("-l");
  if (shape.count) args.push("-c");
  if (norm.maxCount !== undefined) args.push(`-m${norm.maxCount}`);

  // Gitignore-style globs: a bare name matches (and prunes) at any depth,
  // mirroring grep's --exclude-dir / --exclude basename semantics. ORDER
  // MATTERS: rg globs are last-match-wins, so positives (includes/lang) go
  // first and negatives (excludes) last — otherwise `--include '*.md'` would
  // re-include a .md file inside an excluded node_modules/. grep's
  // --exclude-dir always beats --include, so this keeps the engines aligned.
  if (norm.langGlobs) for (const g of norm.langGlobs) args.push(`--glob=${g}`);
  for (const g of opts.include ?? []) args.push(`--glob=${g}`);

  if (!opts.noDefaultExcludes) {
    for (const d of DEFAULT_EXCLUDE_DIRS) args.push(`--glob=!${d}`);
    for (const f of DEFAULT_EXCLUDE_FILES) args.push(`--glob=!${f}`);
  }
  for (const d of extraExcludeDirs) args.push(`--glob=!${d}`);
  for (const e of opts.exclude ?? []) args.push(`--glob=!${e}`);

  args.push("--", pattern);
  if (paths.length > 0) args.push(...paths);
  else args.push(".");
  return args;
}

/**
 * Filename mode via ripgrep: `--files` lists files; a single positive glob
 * acts as a whitelist, negative globs prune. `--iglob` gives -i semantics.
 */
function buildRgFilesArgs(
  pattern: string,
  paths: string[],
  opts: GrepOpts,
  extraExcludeDirs: readonly string[],
): string[] {
  const args: string[] = ["--files", "--hidden", "--no-ignore", "--no-config", "--color=never"];
  // Positive pattern FIRST, negatives last (rg globs are last-match-wins;
  // excludes must beat the pattern — see the ordering note in buildRgArgs).
  args.push(`${opts.ignoreCase ? "--iglob" : "--glob"}=${pattern}`);
  if (!opts.noDefaultExcludes) {
    for (const d of DEFAULT_EXCLUDE_DIRS) args.push(`--glob=!${d}`);
    for (const f of DEFAULT_EXCLUDE_FILES) args.push(`--glob=!${f}`);
  }
  for (const d of extraExcludeDirs) args.push(`--glob=!${d}`);
  for (const e of opts.exclude ?? []) args.push(`--glob=!${e}`);
  if (paths.length > 0) args.push(...paths);
  else args.push(".");
  return args;
}

/**
 * Filename mode via POSIX find (the no-ripgrep fallback):
 *   find <paths> ( -name d1 -o -name d2 ... ) -prune -o -type f -name <glob> [! -name <ex>]... -print
 * Sticks to POSIX operators (`(`, `-o`, `!`) so BSD/macOS find behaves the same.
 */
function buildFindArgs(
  pattern: string,
  paths: string[],
  opts: GrepOpts,
  extraExcludeDirs: readonly string[],
): string[] {
  const args: string[] = paths.length > 0 ? [...paths] : ["."];
  const pruneDirs = [...(opts.noDefaultExcludes ? [] : DEFAULT_EXCLUDE_DIRS), ...extraExcludeDirs];
  if (pruneDirs.length > 0) {
    args.push("(");
    pruneDirs.forEach((d, i) => {
      if (i > 0) args.push("-o");
      args.push("-name", d);
    });
    args.push(")", "-prune", "-o");
  }
  args.push("-type", "f", opts.ignoreCase ? "-iname" : "-name", pattern);
  const fileExcludes = [
    ...(opts.noDefaultExcludes ? [] : DEFAULT_EXCLUDE_FILES),
    ...(opts.exclude ?? []),
  ];
  for (const e of fileExcludes) args.push("!", "-name", e);
  args.push("-print");
  return args;
}

/**
 * Streaming decoder for NUL-framed engine output. Exported for direct
 * chunk-boundary tests. Record shapes (both engines, pinned by the parity
 * suite):
 *   content:    <path>NUL<line>:<text>LF
 *   count:      <path>NUL<count>LF   (BSD grep ignores --null here: <path>:<count>LF)
 *   filesOnly:  <path>NUL            (NUL is the record terminator)
 *   plainLines: <path>LF             (files mode: rg --files / find)
 *
 * Operates on Buffers so a chunk boundary can fall anywhere — including
 * inside a multi-byte UTF-8 sequence — without corrupting a record: bytes
 * are only decoded to strings once a full record is framed.
 */
export class NulDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  constructor(private readonly mode: DecodeMode) {}

  push(chunk: Buffer): Omit<Match, "repo" | "kind">[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const rows: Omit<Match, "repo" | "kind">[] = [];
    if (this.mode === "filesOnly") {
      let nul = this.buffer.indexOf(0);
      while (nul >= 0) {
        const path = this.buffer.subarray(0, nul).toString("utf8");
        this.buffer = this.buffer.subarray(nul + 1);
        // Engines may still newline-separate NUL-terminated records in edge
        // configurations; a bare leading LF is framing residue, not a path.
        const cleaned = path.startsWith("\n") ? path.slice(1) : path;
        if (cleaned.length > 0) rows.push({ file: normalizeFile(cleaned), line: 0, text: "" });
        nul = this.buffer.indexOf(0);
      }
      return rows;
    }
    let nl = this.buffer.indexOf(0x0a);
    while (nl >= 0) {
      const record = this.buffer.subarray(0, nl);
      this.buffer = this.buffer.subarray(nl + 1);
      const row = this.decodeRecord(record);
      if (row) rows.push(row);
      nl = this.buffer.indexOf(0x0a);
    }
    return rows;
  }

  /** Flush a trailing unterminated record (engine killed mid-write, or no final LF). */
  flush(): Omit<Match, "repo" | "kind">[] {
    if (this.buffer.length === 0) return [];
    const record = this.buffer;
    this.buffer = Buffer.alloc(0);
    if (this.mode === "filesOnly") {
      // A partial filesOnly record has no terminating NUL — an engine killed
      // mid-path would yield a corrupt name; drop it.
      return [];
    }
    const row = this.decodeRecord(record);
    return row ? [row] : [];
  }

  private decodeRecord(record: Buffer): Omit<Match, "repo" | "kind"> | null {
    if (this.mode === "plainLines") {
      const path = record.toString("utf8");
      if (path.length === 0) return null;
      return { file: normalizeFile(path), line: 0, text: "" };
    }
    const nul = record.indexOf(0);
    if (nul < 0) {
      // BSD grep honours --null for content and -l records but IGNORES it under
      // -c, emitting `<path>:<count>` where GNU grep emits `<path>NUL<count>`.
      // Without this fallback every count row is dropped as unframed chatter, so
      // `grep -c` returns nothing on a host whose only engine is BSD grep. The
      // count is always a terminal run of digits, so a greedy match on the LAST
      // colon recovers the path even when the path itself contains colons.
      if (this.mode === "count") {
        const bsd = /^(.*):(\d+)$/.exec(record.toString("utf8"));
        if (!bsd) return null;
        return {
          file: normalizeFile(bsd[1] as string),
          line: Number.parseInt(bsd[2] as string, 10),
          text: "",
        };
      }
      return null; // not a NUL-framed record (stray engine chatter)
    }
    const file = normalizeFile(record.subarray(0, nul).toString("utf8"));
    const rest = record.subarray(nul + 1).toString("utf8");
    if (this.mode === "count") {
      const count = Number.parseInt(rest, 10);
      if (!Number.isFinite(count)) return null;
      return { file, line: count, text: "" };
    }
    // content: <line>:<text>. The engines never emit context/separator rows
    // (context is materialized from file reads), so `:` is always present.
    const colon = rest.indexOf(":");
    if (colon < 0) return null;
    const lineNum = Number.parseInt(rest.slice(0, colon), 10);
    if (!Number.isFinite(lineNum)) return null;
    return { file, line: lineNum, text: rest.slice(colon + 1) };
  }
}

function execSearch(
  bin: string,
  args: string[],
  cwd: string,
  acceptLimit: number,
  decodeMode: DecodeMode,
  filePredicate: ((file: string) => boolean) | undefined,
  strict: boolean,
): Promise<Match[]> {
  return new Promise((resolveP, reject) => {
    const proc = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const decoder = new NulDecoder(decodeMode);
    const matches: Match[] = [];
    let stderr = "";
    let killed = false;

    const accept = (rows: Omit<Match, "repo" | "kind">[]): boolean => {
      for (const row of rows) {
        if (filePredicate && !filePredicate(row.file)) continue;
        matches.push({ ...row, repo: "", kind: "match" });
        if (Number.isFinite(acceptLimit) && matches.length >= acceptLimit) return true;
      }
      return false;
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      if (killed) return;
      if (accept(decoder.push(chunk))) {
        killed = true;
        proc.kill("SIGTERM");
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (!killed) accept(decoder.flush());
      // Exit 1 is "no matches" on both engines: normal, not an error.
      // Primary scans tolerate exit 2 with matches collected (an unreadable
      // file mid-walk): surface the results rather than throwing them away.
      // STRICT scans (--and/--without membership) must reject on ANY partial
      // failure — an incomplete set cannot prove that a file lacks a pattern.
      const failed = code !== null && code !== 0 && code !== 1 && !killed;
      if (failed && (strict || matches.length === 0)) {
        reject(new Error(`${bin} exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      resolveP(matches);
    });
  });
}

/**
 * Materialize -C/-A/-B context for already-selected match rows: one file
 * read per selected file, intervals clamped + merged, match rows keep the
 * engine-captured text, other window lines become kind:"context" rows.
 * An unreadable file (deleted since the scan — the accepted TOCTOU window)
 * degrades to its match rows without context rather than failing the search.
 */
async function materializeContext(
  selected: Match[],
  cwd: string,
  before: number,
  after: number,
): Promise<Match[]> {
  const byFile = new Map<string, Match[]>();
  for (const m of selected) {
    const rows = byFile.get(m.file);
    if (rows) rows.push(m);
    else byFile.set(m.file, [m]);
  }

  const out: Match[] = [];
  for (const [file, rows] of byFile) {
    const abs = isAbsolute(file) ? file : join(cwd, file);
    let lines: string[] | null = null;
    try {
      const content = await readFile(abs, "utf8");
      lines = content.split("\n");
      if (lines.at(-1) === "") lines.pop();
    } catch {
      lines = null;
    }
    if (lines === null) {
      out.push(...rows);
      continue;
    }
    // Merge overlapping/adjacent [line-before, line+after] windows.
    const intervals: [number, number][] = rows
      .map((m): [number, number] => [
        Math.max(1, m.line - before),
        Math.min(lines.length, m.line + after),
      ])
      .sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const iv of intervals) {
      const last = merged.at(-1);
      if (last && iv[0] <= last[1] + 1) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    const matchByLine = new Map(rows.map((m) => [m.line, m]));
    const emitted = new Set<Match>();
    for (const [start, end] of merged) {
      if (start > end) continue;
      for (let n = start; n <= end; n++) {
        const m = matchByLine.get(n);
        if (m) {
          out.push(m);
          emitted.add(m);
        } else {
          const repo = rows[0]?.repo ?? "";
          out.push({ repo, file, line: n, text: lines[n - 1] ?? "", kind: "context" });
        }
      }
    }
    // A match whose line exceeds the file's current length (file shrank
    // since the scan) sits outside every clamped window — still emit it.
    for (const m of rows) {
      if (!emitted.has(m)) out.push(m);
    }
  }
  return out;
}

/** Both engines may emit a leading `./` for the default path; strip it so output is engine-identical. */
function normalizeFile(file: string): string {
  return file.startsWith("./") ? file.slice(2) : file;
}

/** Exported for tests (not part of the package exports map). */
export function renderResult(r: GrepResult, opts: GrepOpts): string {
  const lines: string[] = [];
  const showRepoHeader = r.repos.length > 1;
  for (const repo of r.repos) {
    if (repo.matches.length === 0) continue;
    const primary = repo.matches.filter((m) => m.kind === "match").length;
    if (showRepoHeader) {
      lines.push("");
      lines.push(`── ${repo.name} (${primary} match${primary === 1 ? "" : "es"}) ──`);
    }
    // Context mode: `--` between disjoint windows (file change or line gap).
    const contextMode = repo.matches.some((x) => x.kind === "context");
    let prev: Match | undefined;
    for (const m of repo.matches) {
      if (contextMode && prev && (prev.file !== m.file || m.line !== prev.line + 1)) {
        lines.push("--");
      }
      if (opts.filesOnly || opts.files) {
        lines.push(m.file);
      } else if (opts.count) {
        lines.push(`${m.file}:${m.line}`);
      } else {
        const sep = m.kind === "context" ? "-" : ":";
        const more = m.clipped ? ` …[+${m.clipped} chars]` : "";
        lines.push(`${m.file}${sep}${m.line}${sep}${m.text}${more}`);
      }
      prev = m;
    }
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const matchWord = (n: number) => `${n} match${n === 1 ? "" : "es"}`;
  const fileRows = Boolean(opts.files || opts.filesOnly || opts.count);
  if (r.total_matches === 0 && r.available_matches === 0) {
    const modeTag = r.mode === "literal" ? " (literal)" : r.mode === "files" ? " (files)" : "";
    lines.push(`(no matches for /${r.pattern}/${modeTag})`);
  } else if (r.omitted_matches > 0) {
    // Something was left out: state the window, what was left out, and how to
    // continue. Never printed when the page shows everything.
    const first = r.limit === null ? 1 : (r.page - 1) * r.limit + 1;
    const last = first + r.total_matches - 1;
    const shown =
      r.total_matches === 0
        ? `Page ${r.page} is past the end`
        : fileRows
          ? `Showing ${first}-${last} of ${plural(r.available_matches, "file")}`
          : `Showing matches ${first}-${last} of ${r.available_matches} (in ${plural(r.available_files, "file")})`;
    const left = fileRows
      ? `${plural(r.omitted_matches, "file")} left out`
      : `${matchWord(r.omitted_matches)} in ${plural(r.omitted_files, "other file")} left out`;
    const next =
      r.next_page !== null ? `. Next: --page ${r.next_page}, or --all for everything` : "";
    lines.push("");
    lines.push(`${shown}; ${left}${next}.  (${r.elapsed_ms}ms, ${r.engine})`);
  } else if (r.repos.length > 1) {
    lines.push("");
    const summary = `${matchWord(r.total_matches)} across ${plural(r.total_files, "file")}`;
    lines.push(`${summary}  (${r.elapsed_ms}ms, ${r.engine})`);
  }
  return lines.join("\n");
}
