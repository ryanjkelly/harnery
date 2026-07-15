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
 */

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
    .option("--limit <n>", "Truncate output to N matches total")
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
  total_matches: number;
  total_files: number;
  truncated: boolean;
  elapsed_ms: number;
}

/** Validated, resolved options — built once before repo fan-out. */
interface NormOpts {
  limit: number; // Infinity when unset
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
  const limit = opts.limit ? parseIntOpt("--limit", opts.limit, 1) : Number.POSITIVE_INFINITY;
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
    ];
    for (const [set, flag] of rejected) {
      if (set) throw new Error(`-q/--quiet does not combine with ${flag}`);
    }
  }

  return {
    // -q only needs existence: one accepted primary row settles the exit code.
    limit: opts.quiet ? 1 : limit,
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

  // All repos are searched concurrently; each collects at most limit+1
  // accepted rows (one row of lookahead, so "exactly N results" is
  // distinguishable from "more than N"), then the global budget is applied
  // in repo order below so `--limit` semantics stay deterministic.
  const acceptLimit = Number.isFinite(norm.limit) ? norm.limit + 1 : Number.POSITIVE_INFINITY;
  const perRepo = await Promise.all(
    repos.map((repo) => {
      // In --all-repos mode the parent scan prunes submodule dirs — each
      // submodule gets its own scoped scan, so descending from the parent
      // would double-scan and double-report every submodule match. This
      // pruning is correctness (one repo owns each match), so it applies
      // even when --no-default-excludes is set.
      const dedupeDirs = opts.allRepos && repo.name === "parent" ? (context?.submodules ?? []) : [];
      const extraDirs = [...hostExcludeDirs, ...dedupeDirs];
      return runGrepInRepo(
        pattern,
        paths,
        opts,
        norm,
        repo.cwd,
        repo.name,
        acceptLimit,
        engine,
        rgBin,
        extraDirs,
      );
    }),
  );

  const allRepoResults: GrepResult["repos"] = [];
  let totalMatches = 0;
  const filesSeen = new Set<string>();
  let truncated = false;
  let budget = norm.limit;

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    if (!repo) continue;
    const collected = perRepo[i] ?? [];
    collected.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    const take = Number.isFinite(budget)
      ? Math.min(collected.length, Math.max(0, budget))
      : collected.length;
    let matches = collected.slice(0, take);
    // truncated only when an accepted primary row was actually omitted —
    // the lookahead row (or a later-repo surplus) is the proof.
    const repoTruncated = collected.length > take;
    if (repoTruncated) truncated = true;
    if (Number.isFinite(budget)) budget -= take;
    totalMatches += matches.length;
    for (const m of matches) filesSeen.add(`${repo.name}/${m.file}`);
    // Context is materialized only for the SELECTED rows, after budgeting,
    // so context rows never consume the limit and trailing context is never
    // cut off by an engine kill.
    if (!opts.files && !opts.filesOnly && !opts.count && (norm.before > 0 || norm.after > 0)) {
      matches = await materializeContext(matches, repo.cwd, norm.before, norm.after);
    }
    allRepoResults.push({ name: repo.name, cwd: repo.cwd, matches, truncated: repoTruncated });
  }

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
    elapsed_ms: Date.now() - started,
  };
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
 *   count:      <path>NUL<count>LF
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
    if (nul < 0) return null; // not a NUL-framed record (stray engine chatter)
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

function renderResult(r: GrepResult, opts: GrepOpts): string {
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
      } else if (m.kind === "context") {
        lines.push(`${m.file}-${m.line}-${m.text}`);
      } else {
        lines.push(`${m.file}:${m.line}:${m.text}`);
      }
      prev = m;
    }
    if (repo.truncated) {
      lines.push("  (truncated; raise --limit)");
    }
  }
  if (r.total_matches === 0) {
    const modeTag = r.mode === "literal" ? " (literal)" : r.mode === "files" ? " (files)" : "";
    lines.push(`(no matches for /${r.pattern}/${modeTag})`);
  } else if (r.repos.length > 1 || r.truncated) {
    lines.push("");
    const summary = `${r.total_matches} match${r.total_matches === 1 ? "" : "es"} across ${r.total_files} file${r.total_files === 1 ? "" : "s"}`;
    const tail = r.truncated ? " (truncated; raise --limit)" : "";
    lines.push(`${summary}${tail}  (${r.elapsed_ms}ms, ${r.engine})`);
  }
  return lines.join("\n");
}
