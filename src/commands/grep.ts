import { spawn } from "node:child_process";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { resolveBinName, ripgrepAutoInstall } from "../core/config.ts";
import { coordEnv } from "../lib/env.ts";
import { findRg, hintOncePerDay, installRg, rgInstallSupported } from "../lib/tools/ripgrep.ts";

/**
 * `grep`: monorepo-aware code search. Prefers ripgrep (`rg`) when it is on
 * PATH and falls back to GNU `grep -rn` transparently — both engines are
 * driven with equivalent flags and their output is parsed into the same
 * envelope, so results are identical (pinned by tests/unit/grep-engine.test.ts).
 * Smart default excludes (skip dist/.next/node_modules/.git/...), repo
 * scoping (`--repo <name>` or `--all-repos`), and language presets.
 *
 * Engine selection: `HARNERY_GREP_ENGINE=rg|grep` forces one; otherwise `rg`
 * is resolved (managed install, PATH, or opt-in auto-provision; see resolveEngine) and used when available. Repos are searched in
 * parallel, and in `--all-repos` mode the parent scan prunes submodule
 * directories so each match is attributed to exactly one repo (previously the
 * parent scan descended into submodules, double-scanning and double-reporting
 * every submodule match).
 *
 * Default behavior matches extended-regex semantics (`grep -E` / ripgrep's
 * default). Use `-F` / `--literal` to pin to literal-string mode. Output is
 * line-oriented `file:line:content` in TTY mode, `{rows, total, truncated}`
 * in --json mode. Matches are sorted (file, then line) for stable output
 * across runs and engines; with `-C <n>` context, engine order is kept so
 * context groups stay adjacent.
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

export type GrepEngine = "rg" | "grep";

export interface GrepOpts {
  repo?: string;
  allRepos?: boolean;
  lang?: string;
  ignoreCase?: boolean;
  wholeWord?: boolean;
  literal?: boolean;
  filesOnly?: boolean;
  files?: boolean;
  count?: boolean;
  context?: string;
  maxCount?: string;
  limit?: string;
  include?: string[];
  exclude?: string[];
  noDefaultExcludes?: boolean;
  json?: boolean;
}

interface Match {
  repo: string;
  file: string;
  line: number;
  text: string;
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
        "Use --repo, --all-repos, --lang for scoping. Regex by default; -F for literal.",
    )
    .option("--repo <name>", "Scope to one submodule (`.` = parent repo root)")
    .option("--all-repos", "Search parent + every submodule")
    .option("--lang <lang>", `File type preset (${Object.keys(LANG_GLOBS).join(", ")})`)
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
    .option("--max-count <n>", "Stop after N matches per file")
    .option("--limit <n>", "Truncate output to N matches total")
    .option("--include <glob>", "Extra --include glob (repeatable)", collect, [] as string[])
    .option("--exclude <glob>", "Extra --exclude glob (repeatable)", collect, [] as string[])
    .option("--no-default-excludes", "Disable the default skip list (node_modules, dist, etc.)")
    .option("--json", "Structured JSON envelope")
    .action(async (pattern: string, paths: string[], opts: GrepOpts) => {
      try {
        const result = await runGrep(pattern, paths, opts, context);
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
  repos: { name: string; cwd: string; matches: Match[]; truncated: boolean }[];
  total_matches: number;
  total_files: number;
  truncated: boolean;
  elapsed_ms: number;
}

/**
 * Pick the engine + the spawnable rg path. HARNERY_GREP_ENGINE=rg|grep forces
 * one; otherwise findRg() probes HARNERY_RG_PATH → the managed tools-dir
 * install → PATH. On a miss, the host's `.harnery/config.jsonc`
 * `tools.ripgrep.autoInstall` consent triggers a pinned, checksum-verified
 * install into the harnery tools dir (any failure falls back to grep with a
 * stderr note); without consent, a rate-limited stderr hint names the
 * explicit install command instead.
 */
async function resolveEngine(): Promise<{ engine: GrepEngine; rgBin: string }> {
  const forced = coordEnv("GREP_ENGINE");
  if (forced === "grep") return { engine: "grep", rgBin: "rg" };
  const found = findRg();
  if (found) return { engine: "rg", rgBin: found };
  if (forced === "rg") {
    // Forced rg with none findable: let the spawn error surface loudly.
    return { engine: "rg", rgBin: "rg" };
  }
  if (rgInstallSupported()) {
    if (ripgrepAutoInstall()) {
      try {
        const installed = await installRg((line) => process.stderr.write(`harnery: ${line}\n`));
        return { engine: "rg", rgBin: installed };
      } catch (err) {
        process.stderr.write(
          `harnery: ripgrep auto-install failed (${(err as Error).message}); using grep fallback\n`,
        );
        return { engine: "grep", rgBin: "rg" };
      }
    }
    const bin = resolveBinName();
    hintOncePerDay(
      `${bin} grep: ripgrep not found; using the slower GNU grep fallback. ` +
        `Run \`${bin} doctor --fix\` to install it (pinned + checksum-verified), ` +
        `or set { "tools": { "ripgrep": { "autoInstall": true } } } in .harnery/config.jsonc.`,
    );
  }
  return { engine: "grep", rgBin: "rg" };
}

/** Exported for tests (not part of the package exports map). */
export async function runGrep(
  pattern: string,
  paths: string[],
  opts: GrepOpts,
  context: HarneryProgramContext | undefined,
): Promise<GrepResult> {
  if (!pattern) throw new Error("pattern required");
  if (opts.files) {
    // Filename mode lists files by name glob; content-search flags make no
    // sense here — reject loudly rather than silently ignoring them.
    const incompatible: [unknown, string][] = [
      [opts.lang, "--lang"],
      [opts.count, "-c/--count"],
      [opts.wholeWord, "-w/--whole-word"],
      [opts.literal, "-F/--literal"],
      [opts.maxCount, "--max-count"],
      [opts.include?.length, "--include"],
      [Number.parseInt(opts.context ?? "0", 10) > 0 ? true : undefined, "-C/--context"],
    ];
    for (const [set, flag] of incompatible) {
      if (set) throw new Error(`${flag} does not apply to --files (filename glob) mode`);
    }
  }
  const started = Date.now();

  const { engine, rgBin } = await resolveEngine();
  const repos = resolveRepos(opts, context);
  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : Number.POSITIVE_INFINITY;
  const contextN = Number.parseInt(opts.context ?? "0", 10);
  const sortable = !(Number.isFinite(contextN) && contextN > 0);

  // Host-injected default excludes (generated mirrors, vendored trees, ...)
  // ride the same --no-default-excludes gate as the built-in list.
  const hostExcludeDirs = opts.noDefaultExcludes ? [] : (context?.grepExcludeDirs ?? []);

  // All repos are searched concurrently; each is capped at the global limit
  // (a single repo can never contribute more), then the global budget is
  // applied in repo order below so `--limit` semantics stay deterministic.
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
        repo.cwd,
        repo.name,
        limit,
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
  let budget = limit;

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    if (!repo) continue;
    const collected = perRepo[i] ?? [];
    if (sortable) {
      collected.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    }
    const engineCapped = Number.isFinite(limit) && collected.length >= limit;
    const take = Number.isFinite(budget)
      ? Math.min(collected.length, Math.max(0, budget))
      : collected.length;
    const matches = collected.slice(0, take);
    const repoTruncated = engineCapped || collected.length > take;
    if (repoTruncated) truncated = true;
    if (Number.isFinite(budget)) budget -= take;
    totalMatches += matches.length;
    for (const m of matches) filesSeen.add(`${repo.name}/${m.file}`);
    allRepoResults.push({ name: repo.name, cwd: repo.cwd, matches, truncated: repoTruncated });
  }

  return {
    pattern,
    mode: opts.files ? "files" : opts.literal ? "literal" : "regex",
    engine,
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
  cwd: string,
  repoName: string,
  limit: number,
  engine: GrepEngine,
  rgBin: string,
  extraExcludeDirs: readonly string[],
): Promise<Match[]> {
  // Filename mode: `rg --files` when available; POSIX `find` otherwise (GNU
  // grep has no list-by-name mode). Content mode: rg / grep as selected.
  const [bin, args] = opts.files
    ? engine === "rg"
      ? ([rgBin, buildRgFilesArgs(pattern, paths, opts, extraExcludeDirs)] as const)
      : (["find", buildFindArgs(pattern, paths, opts, extraExcludeDirs)] as const)
    : engine === "rg"
      ? ([rgBin, buildRgArgs(pattern, paths, opts, extraExcludeDirs)] as const)
      : (["grep", buildGrepArgs(pattern, paths, opts, extraExcludeDirs)] as const);

  let matches = await execSearch(bin, args, cwd, limit);
  // -c mode: GNU grep prints a `path:0` row for every searched file; ripgrep
  // omits zero-count rows. Filter zeros on both engines so output matches.
  if (opts.count) matches = matches.filter((m) => m.line > 0);
  return matches.map((m) => ({ ...m, repo: repoName }));
}

function resolveLangGlobs(opts: GrepOpts): string[] | undefined {
  const langGlobs = opts.lang ? LANG_GLOBS[opts.lang] : undefined;
  if (opts.lang && !langGlobs) {
    throw new Error(`unknown --lang "${opts.lang}". Valid: ${Object.keys(LANG_GLOBS).join(", ")}`);
  }
  return langGlobs;
}

function buildGrepArgs(
  pattern: string,
  paths: string[],
  opts: GrepOpts,
  extraExcludeDirs: readonly string[],
): string[] {
  const args: string[] = ["-rn", "-H", "--color=never", "-I"]; // -I: skip binary files
  if (opts.ignoreCase) args.push("-i");
  if (opts.wholeWord) args.push("-w");
  if (opts.literal) args.push("-F");
  else args.push("-E");
  if (opts.filesOnly) args.push("-l");
  if (opts.count) args.push("-c");
  const contextN = Number.parseInt(opts.context ?? "0", 10);
  if (Number.isFinite(contextN) && contextN > 0) args.push(`-C${contextN}`);
  if (opts.maxCount) {
    const n = Number.parseInt(opts.maxCount, 10);
    if (Number.isFinite(n) && n > 0) args.push(`-m${n}`);
  }

  if (!opts.noDefaultExcludes) {
    for (const d of DEFAULT_EXCLUDE_DIRS) args.push(`--exclude-dir=${d}`);
    for (const f of DEFAULT_EXCLUDE_FILES) args.push(`--exclude=${f}`);
  }
  for (const d of extraExcludeDirs) args.push(`--exclude-dir=${d}`);
  for (const e of opts.exclude ?? []) args.push(`--exclude=${e}`);

  const langGlobs = resolveLangGlobs(opts);
  if (langGlobs) for (const g of langGlobs) args.push(`--include=${g}`);
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
  extraExcludeDirs: readonly string[],
): string[] {
  // --hidden --no-ignore: match GNU grep's semantics (search dotdirs, ignore
  // .gitignore) so the only filters are the explicit exclude lists.
  // --no-config: a user's ripgrep config file must not skew results.
  // --with-filename: rg drops the file prefix for a single explicit file arg,
  // which would break the shared parser.
  const args: string[] = [
    "-n",
    "--no-heading",
    "--with-filename",
    "--color=never",
    "--no-config",
    "--hidden",
    "--no-ignore",
  ];
  if (opts.ignoreCase) args.push("-i");
  if (opts.wholeWord) args.push("-w");
  if (opts.literal) args.push("-F");
  if (opts.filesOnly) args.push("-l");
  if (opts.count) args.push("-c");
  const contextN = Number.parseInt(opts.context ?? "0", 10);
  if (Number.isFinite(contextN) && contextN > 0) args.push(`-C${contextN}`);
  if (opts.maxCount) {
    const n = Number.parseInt(opts.maxCount, 10);
    if (Number.isFinite(n) && n > 0) args.push(`-m${n}`);
  }

  // Gitignore-style globs: a bare name matches (and prunes) at any depth,
  // mirroring grep's --exclude-dir / --exclude basename semantics. ORDER
  // MATTERS: rg globs are last-match-wins, so positives (includes/lang) go
  // first and negatives (excludes) last — otherwise `--include '*.md'` would
  // re-include a .md file inside an excluded node_modules/. grep's
  // --exclude-dir always beats --include, so this keeps the engines aligned.
  const langGlobs = resolveLangGlobs(opts);
  if (langGlobs) for (const g of langGlobs) args.push(`--glob=${g}`);
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

function execSearch(
  bin: string,
  args: string[],
  cwd: string,
  limit: number,
): Promise<Omit<Match, "repo">[]> {
  return new Promise((resolveP, reject) => {
    const proc = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const matches: Omit<Match, "repo">[] = [];
    let buffer = "";
    let stderr = "";
    let truncated = false;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length !== 0) {
          const parsed = parseGrepLine(line);
          if (parsed) matches.push(parsed);
          if (Number.isFinite(limit) && matches.length >= limit) {
            truncated = true;
            proc.kill("SIGTERM");
            return;
          }
        }
        nl = buffer.indexOf("\n");
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (buffer.length > 0 && !truncated) {
        const parsed = parseGrepLine(buffer);
        if (parsed) matches.push(parsed);
      }
      // Exit 1 is "no matches" on both engines: normal, not an error. Exit 2
      // with matches collected means a partial failure (an unreadable file
      // mid-walk); surface the results rather than throwing them away.
      if (code !== null && code !== 0 && code !== 1 && !truncated && matches.length === 0) {
        reject(new Error(`${bin} exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      resolveP(matches);
    });
  });
}

/** Parse `path:line:content` from grep/rg -n output. Returns null for ambiguous (no line number) lines. */
function parseGrepLine(line: string): Omit<Match, "repo"> | null {
  // First colon ends path; second colon ends line number (if numeric).
  const firstColon = line.indexOf(":");
  if (firstColon < 0) {
    // -l mode: just a path. Encode as line=0, text="".
    return { file: normalizeFile(line), line: 0, text: "" };
  }
  const after = line.slice(firstColon + 1);
  const secondColon = after.indexOf(":");
  if (secondColon < 0) {
    // -c mode: `path:count`.
    const count = Number.parseInt(after, 10);
    if (Number.isFinite(count)) {
      return { file: normalizeFile(line.slice(0, firstColon)), line: count, text: "" };
    }
    return { file: normalizeFile(line.slice(0, firstColon)), line: 0, text: after };
  }
  const lineNum = Number.parseInt(after.slice(0, secondColon), 10);
  if (!Number.isFinite(lineNum)) {
    // Probably a context separator like `--`. Skip.
    return null;
  }
  return {
    file: normalizeFile(line.slice(0, firstColon)),
    line: lineNum,
    text: after.slice(secondColon + 1),
  };
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
    if (showRepoHeader) {
      lines.push("");
      lines.push(
        `── ${repo.name} (${repo.matches.length} match${repo.matches.length === 1 ? "" : "es"}) ──`,
      );
    }
    for (const m of repo.matches) {
      if (opts.filesOnly || opts.files) {
        lines.push(m.file);
      } else if (opts.count) {
        lines.push(`${m.file}:${m.line}`);
      } else {
        lines.push(`${m.file}:${m.line}:${m.text}`);
      }
    }
    if (repo.truncated) {
      lines.push("  (truncated; pass --limit to widen)");
    }
  }
  if (r.total_matches === 0) {
    const modeTag = r.mode === "literal" ? " (literal)" : r.mode === "files" ? " (files)" : "";
    lines.push(`(no matches for /${r.pattern}/${modeTag})`);
  } else if (r.repos.length > 1 || r.truncated) {
    lines.push("");
    const summary = `${r.total_matches} match${r.total_matches === 1 ? "" : "es"} across ${r.total_files} file${r.total_files === 1 ? "" : "s"}`;
    const tail = r.truncated ? " (truncated; use --limit)" : "";
    lines.push(`${summary}${tail}  (${r.elapsed_ms}ms, ${r.engine})`);
  }
  return lines.join("\n");
}
