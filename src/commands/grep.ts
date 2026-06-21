import { spawn } from "node:child_process";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";

/**
 * `grep`: monorepo-aware code search. Thin wrapper over grep -rn with
 * smart default excludes (skip dist/.next/node_modules/.git/...), repo
 * scoping (`--repo <name>` or `--all-repos`), and language presets.
 *
 * Default behavior matches grep's "regex" semantics (`-E` extended). Use
 * `-F` / `--literal` to pin to literal-string mode. Output is line-oriented
 * `file:line:content` in TTY mode, `{rows, total, truncated}` in --json mode.
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

interface GrepOpts {
  repo?: string;
  allRepos?: boolean;
  lang?: string;
  ignoreCase?: boolean;
  wholeWord?: boolean;
  literal?: boolean;
  filesOnly?: boolean;
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
      "Monorepo-aware code search. Skips dist/.next/node_modules/.git/... by default. " +
        "Use --repo, --all-repos, --lang for scoping. Regex by default; -F for literal.",
    )
    .option("--repo <name>", "Scope to one submodule (`.` = parent repo root)")
    .option("--all-repos", "Search parent + every submodule")
    .option("--lang <lang>", `File type preset (${Object.keys(LANG_GLOBS).join(", ")})`)
    .option("-i, --ignore-case", "Case-insensitive match")
    .option("-w, --whole-word", "Match whole words only")
    .option("-F, --literal", "Treat <pattern> as a literal string (no regex)")
    .option("-l, --files-only", "Only print file names containing a match")
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

interface GrepResult {
  pattern: string;
  mode: "regex" | "literal";
  repos: { name: string; cwd: string; matches: Match[]; truncated: boolean }[];
  total_matches: number;
  total_files: number;
  truncated: boolean;
  elapsed_ms: number;
}

async function runGrep(
  pattern: string,
  paths: string[],
  opts: GrepOpts,
  context: HarneryProgramContext | undefined,
): Promise<GrepResult> {
  if (!pattern) throw new Error("pattern required");
  const started = Date.now();

  const repos = resolveRepos(opts, context);
  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : Number.POSITIVE_INFINITY;

  const allRepoResults: GrepResult["repos"] = [];
  let totalMatches = 0;
  const filesSeen = new Set<string>();
  let truncated = false;

  for (const repo of repos) {
    if (truncated) break;
    const repoLimit = Number.isFinite(limit)
      ? Math.max(0, limit - totalMatches)
      : Number.POSITIVE_INFINITY;
    if (repoLimit === 0) {
      truncated = true;
      allRepoResults.push({ name: repo.name, cwd: repo.cwd, matches: [], truncated: true });
      break;
    }
    const matches = await runGrepInRepo(pattern, paths, opts, repo.cwd, repo.name, repoLimit);
    let repoTruncated = false;
    if (Number.isFinite(repoLimit) && matches.length >= repoLimit) {
      repoTruncated = true;
      truncated = true;
    }
    totalMatches += matches.length;
    for (const m of matches) filesSeen.add(`${repo.name}/${m.file}`);
    allRepoResults.push({ name: repo.name, cwd: repo.cwd, matches, truncated: repoTruncated });
  }

  return {
    pattern,
    mode: opts.literal ? "literal" : "regex",
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
): Promise<Match[]> {
  const args: string[] = ["-rn", "--color=never", "-I"]; // -I: skip binary files
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
  for (const e of opts.exclude ?? []) args.push(`--exclude=${e}`);

  const langGlobs = opts.lang ? LANG_GLOBS[opts.lang] : undefined;
  if (opts.lang && !langGlobs) {
    throw new Error(`unknown --lang "${opts.lang}". Valid: ${Object.keys(LANG_GLOBS).join(", ")}`);
  }
  if (langGlobs) for (const g of langGlobs) args.push(`--include=${g}`);
  for (const g of opts.include ?? []) args.push(`--include=${g}`);

  args.push("--", pattern);
  if (paths.length > 0) args.push(...paths);
  else args.push(".");

  const matches = await execGrep(args, cwd, limit);
  return matches.map((m) => ({ ...m, repo: repoName }));
}

function execGrep(args: string[], cwd: string, limit: number): Promise<Omit<Match, "repo">[]> {
  return new Promise((resolveP, reject) => {
    const proc = spawn("grep", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
      // grep exits 1 on "no matches": normal, not an error.
      if (code !== null && code !== 0 && code !== 1 && !truncated) {
        reject(new Error(`grep exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      resolveP(matches);
    });
  });
}

/** Parse `path:line:content` from grep -n output. Returns null for ambiguous (no line number) lines. */
function parseGrepLine(line: string): Omit<Match, "repo"> | null {
  // First colon ends path; second colon ends line number (if numeric).
  const firstColon = line.indexOf(":");
  if (firstColon < 0) {
    // -l mode: just a path. Encode as line=0, text="".
    return { file: line, line: 0, text: "" };
  }
  const after = line.slice(firstColon + 1);
  const secondColon = after.indexOf(":");
  if (secondColon < 0) {
    // -c mode: `path:count`.
    const count = Number.parseInt(after, 10);
    if (Number.isFinite(count)) return { file: line.slice(0, firstColon), line: count, text: "" };
    return { file: line.slice(0, firstColon), line: 0, text: after };
  }
  const lineNum = Number.parseInt(after.slice(0, secondColon), 10);
  if (!Number.isFinite(lineNum)) {
    // Probably a context separator like `--`. Skip.
    return null;
  }
  return {
    file: line.slice(0, firstColon),
    line: lineNum,
    text: after.slice(secondColon + 1),
  };
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
      if (opts.filesOnly) {
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
    lines.push(`(no matches for /${r.pattern}/${r.mode === "literal" ? " (literal)" : ""})`);
  } else if (r.repos.length > 1 || r.truncated) {
    lines.push("");
    const summary = `${r.total_matches} match${r.total_matches === 1 ? "" : "es"} across ${r.total_files} file${r.total_files === 1 ? "" : "s"}`;
    const tail = r.truncated ? " (truncated; use --limit)" : "";
    lines.push(`${summary}${tail}  (${r.elapsed_ms}ms)`);
  }
  return lines.join("\n");
}
