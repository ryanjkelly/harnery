import { spawn } from "node:child_process";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";

/**
 * `harn callers <symbol>`: find references to a symbol across the monorepo with
 * kind classification (call / import / type / decl / ref). Thin wrapper over
 * grep -rnw with post-filtering: declarations + single-line comments are
 * filtered out by default, and lines starting with " * " (multi-line comment
 * continuation) are dropped. Inherent text-based-search limitations: multi-line
 * string literals and block-comment interiors aren't excluded.
 */

interface CallersOpts {
  repo?: string;
  allRepos?: boolean;
  lang?: string;
  includeDecl?: boolean;
  includeComments?: boolean;
  limit?: string;
  json?: boolean;
}

interface Caller {
  repo: string;
  file: string;
  line: number;
  kind: "call" | "import" | "decl" | "type" | "ref";
  text: string;
}

interface CallersResult {
  symbol: string;
  repos: { name: string; cwd: string }[];
  callers: Caller[];
  by_kind: Record<string, number>;
  total: number;
  truncated: boolean;
  elapsed_ms: number;
}

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
  ts: ["*.ts", "*.tsx"],
  js: ["*.js", "*.jsx", "*.mjs", "*.cjs"],
  py: ["*.py"],
  php: ["*.php"],
  rb: ["*.rb"],
  go: ["*.go"],
  rs: ["*.rs"],
};

export function registerCallersCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  program
    .command("callers <symbol>")
    .description(
      "Find references to a symbol across the monorepo with kind classification " +
        "(call / import / type / decl / ref). Heuristic: filters out declarations + " +
        "single-line comments by default; opt back in with --include-decl / --include-comments.",
    )
    .option("--repo <name>", "Scope to one submodule (`.` = parent repo root)")
    .option("--all-repos", "Search parent + every submodule")
    .option("--lang <lang>", `File type preset (${Object.keys(LANG_GLOBS).join(", ")})`)
    .option("--include-decl", "Include the declaration line(s) too")
    .option("--include-comments", "Include matches in single-line comments")
    .option("--limit <n>", "Truncate output to N matches total", "500")
    .option("--json", "Structured JSON envelope")
    .action(async (symbol: string, opts: CallersOpts) => {
      try {
        const result = await runCallers(symbol, opts, context);
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(result);
          return;
        }
        emit.text(`${renderCallers(result)}\n`);
      } catch (err) {
        emit.error({ code: "callers_failed", message: (err as Error).message });
        process.exit(1);
      }
    });
}

async function runCallers(
  symbol: string,
  opts: CallersOpts,
  context: HarneryProgramContext | undefined,
): Promise<CallersResult> {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) {
    throw new Error(`symbol must be a valid identifier (got: ${symbol})`);
  }

  const started = Date.now();
  const repos = resolveRepos(opts, context);
  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : 500;

  const allCallers: Caller[] = [];
  let truncated = false;

  for (const repo of repos) {
    if (allCallers.length >= limit) {
      truncated = true;
      break;
    }
    const remaining = limit - allCallers.length;
    const found = await grepInRepo(symbol, opts, repo, remaining);
    if (found.truncated) truncated = true;
    allCallers.push(...found.callers);
  }

  const by_kind: Record<string, number> = {};
  for (const c of allCallers) {
    by_kind[c.kind] = (by_kind[c.kind] || 0) + 1;
  }

  return {
    symbol,
    repos: repos.map((r) => ({ name: r.name, cwd: r.cwd })),
    callers: allCallers,
    by_kind,
    total: allCallers.length,
    truncated,
    elapsed_ms: Date.now() - started,
  };
}

function resolveRepos(
  opts: CallersOpts,
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

function grepInRepo(
  symbol: string,
  opts: CallersOpts,
  repo: { name: string; cwd: string },
  limit: number,
): Promise<{ callers: Caller[]; truncated: boolean }> {
  const args: string[] = ["-rnw", "--color=never", "-I", "-E"];
  for (const d of DEFAULT_EXCLUDE_DIRS) args.push(`--exclude-dir=${d}`);
  for (const f of DEFAULT_EXCLUDE_FILES) args.push(`--exclude=${f}`);
  const langGlobs = opts.lang ? LANG_GLOBS[opts.lang] : undefined;
  if (opts.lang && !langGlobs) {
    throw new Error(`unknown --lang "${opts.lang}". Valid: ${Object.keys(LANG_GLOBS).join(", ")}`);
  }
  if (langGlobs) for (const g of langGlobs) args.push(`--include=${g}`);
  args.push("--", symbol, ".");

  return new Promise((resolveP, reject) => {
    const proc = spawn("grep", args, { cwd: repo.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const callers: Caller[] = [];
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
          const parsed = parseCallerLine(line, symbol, opts, repo.name);
          if (parsed) callers.push(parsed);
          if (callers.length >= limit) {
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
        const parsed = parseCallerLine(buffer, symbol, opts, repo.name);
        if (parsed) callers.push(parsed);
      }
      if (code !== null && code !== 0 && code !== 1 && !truncated) {
        reject(new Error(`grep exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      resolveP({ callers, truncated });
    });
  });
}

function parseCallerLine(
  line: string,
  symbol: string,
  opts: CallersOpts,
  repoName: string,
): Caller | null {
  const firstColon = line.indexOf(":");
  if (firstColon < 0) return null;
  const after = line.slice(firstColon + 1);
  const secondColon = after.indexOf(":");
  if (secondColon < 0) return null;
  const lineNum = Number.parseInt(after.slice(0, secondColon), 10);
  if (!Number.isFinite(lineNum)) return null;

  const file = line.slice(0, firstColon).replace(/^\.\//, "");
  const text = after.slice(secondColon + 1);

  if (!opts.includeComments) {
    if (/^\s*(\/\/|#|--)/.test(text)) return null;
  }
  if (/^\s*\*[\s/]/.test(text)) return null; // /* multi-line comment continuation

  const kind = classifyMatch(text, symbol);
  if (kind === "decl" && !opts.includeDecl) return null;

  return { repo: repoName, file, line: lineNum, kind, text };
}

function classifyMatch(text: string, symbol: string): Caller["kind"] {
  const sym = escapeRegex(symbol);

  if (
    new RegExp(
      `^\\s*(export\\s+)?(async\\s+)?(function|class|interface|type|enum|namespace)\\s+${sym}\\b`,
    ).test(text)
  ) {
    return "decl";
  }
  if (new RegExp(`^\\s*(export\\s+)?(const|let|var)\\s+${sym}\\b`).test(text)) return "decl";
  if (
    new RegExp(`^\\s*(public|private|protected)\\s+(static\\s+)?function\\s+${sym}\\b`).test(text)
  ) {
    return "decl";
  }
  if (new RegExp(`^\\s*(async\\s+)?def\\s+${sym}\\b`).test(text)) return "decl";
  if (new RegExp(`^\\s*class\\s+${sym}\\b`).test(text)) return "decl";

  if (/^\s*(import\b|from\b|use\s+|require\s*\(|include\s|require_once\s)/.test(text)) {
    return "import";
  }

  if (new RegExp(`\\b${sym}\\s*\\(`).test(text)) return "call";

  if (
    new RegExp(
      `(:\\s*${sym}\\b|extends\\s+${sym}\\b|implements\\s+${sym}\\b|as\\s+${sym}\\b|<${sym}[>\\s,])`,
    ).test(text)
  ) {
    return "type";
  }

  return "ref";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderCallers(r: CallersResult): string {
  const lines: string[] = [];

  if (r.total === 0) {
    lines.push(`callers · ${r.symbol}: no matches`);
    return lines.join("\n");
  }

  const summary = Object.entries(r.by_kind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");
  lines.push(`callers · ${r.symbol} (${r.total} total: ${summary}, ${r.elapsed_ms}ms)`);

  const byRepo = new Map<string, Caller[]>();
  for (const c of r.callers) {
    if (!byRepo.has(c.repo)) byRepo.set(c.repo, []);
    byRepo.get(c.repo)!.push(c);
  }

  const showRepoHeader = byRepo.size > 1;

  for (const [repo, callers] of byRepo) {
    if (showRepoHeader) {
      lines.push("");
      lines.push(`── ${repo} (${callers.length}) ──`);
    }
    let lastFile = "";
    for (const c of callers) {
      if (c.file !== lastFile) {
        lines.push("");
        lines.push(`  ${c.file}`);
        lastFile = c.file;
      }
      const kindLabel = `[${c.kind}]`.padEnd(8);
      const snippet = c.text.trim().slice(0, 100);
      lines.push(`    L${c.line.toString().padEnd(5)} ${kindLabel} ${snippet}`);
    }
  }

  if (r.truncated) {
    lines.push("");
    lines.push("(truncated; pass --limit to widen)");
  }

  return lines.join("\n");
}
