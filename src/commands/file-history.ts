import { existsSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { exec } from "../lib/exec.ts";

/**
 * `file-history <path>`: concise per-file git history. Total commits, distinct
 * authors, first/last touched dates, total line impact, and the N most-recent
 * commits with +/- counts. Follows renames. Submodule-aware via git itself:
 * runs the log inside whichever repo `git rev-parse --show-toplevel` resolves
 * from the file's directory, so submodule files get the submodule's history.
 */

interface FileHistoryOpts {
  limit?: string;
  since?: string;
  author?: string;
  json?: boolean;
}

interface CommitEntry {
  sha: string;
  short_sha: string;
  author: string;
  date: string;
  subject: string;
  added: number;
  removed: number;
}

interface FileHistoryResult {
  file: string;
  repo: string;
  total_commits: number;
  authors: { name: string; commits: number }[];
  first_commit: { sha: string; date: string } | null;
  last_commit: { sha: string; date: string } | null;
  total_added: number;
  total_removed: number;
  commits: CommitEntry[];
}

export function registerFileHistoryCommand(program: Command, emit: EmitContext): void {
  program
    .command("file-history <path>")
    .description(
      "Concise per-file git history: summary stats + N most-recent commits with line impact.",
    )
    .option("--limit <n>", "Show N most-recent commits", "20")
    .option("--since <date>", "Restrict to commits since DATE (e.g. '30 days ago', '2026-01-01')")
    .option("--author <pat>", "Filter to commits by author (substring match)")
    .option("--json", "Structured JSON envelope")
    .action(async (path: string, opts: FileHistoryOpts) => {
      try {
        const result = await runFileHistory(path, opts);
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(result);
          return;
        }
        emit.text(`${renderFileHistory(result)}\n`);
      } catch (err) {
        emit.error({ code: "file_history_failed", message: (err as Error).message });
        process.exit(1);
      }
    });
}

async function runFileHistory(path: string, opts: FileHistoryOpts): Promise<FileHistoryResult> {
  const absPath = resolve(path);
  if (!existsSync(absPath)) throw new Error(`no such file: ${path}`);

  const repo = await detectRepo(absPath);
  const relPath = relative(repo.cwd, absPath);
  if (relPath.startsWith("..")) {
    throw new Error(`path outside detected repo (${repo.cwd}): ${absPath}`);
  }

  const args = [
    "log",
    "--no-merges",
    "--follow",
    "--pretty=format:%H%x09%an%x09%aI%x09%s",
    "--shortstat",
  ];
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.author) args.push(`--author=${opts.author}`);
  args.push("--", relPath);

  const log = await exec(["git", ...args], { cwd: repo.cwd, timeout: 30_000 });
  if (log.exitCode !== 0) throw new Error(`git log failed: ${log.stderr || log.stdout}`);

  const commits = parseGitLog(log.stdout);

  const authorMap = new Map<string, number>();
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const c of commits) {
    authorMap.set(c.author, (authorMap.get(c.author) || 0) + 1);
    totalAdded += c.added;
    totalRemoved += c.removed;
  }
  const authors = Array.from(authorMap.entries())
    .map(([name, commits]) => ({ name, commits }))
    .sort((a, b) => b.commits - a.commits);

  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : 20;
  const recentCommits = commits.slice(0, Number.isFinite(limit) ? limit : 20);

  return {
    file: relPath,
    repo: repo.name,
    total_commits: commits.length,
    authors,
    first_commit:
      commits.length > 0
        ? { sha: commits[commits.length - 1]!.short_sha, date: commits[commits.length - 1]!.date }
        : null,
    last_commit: commits.length > 0 ? { sha: commits[0]!.short_sha, date: commits[0]!.date } : null,
    total_added: totalAdded,
    total_removed: totalRemoved,
    commits: recentCommits,
  };
}

function parseGitLog(output: string): CommitEntry[] {
  const commits: CommitEntry[] = [];
  const lines = output.split("\n");
  let current: CommitEntry | null = null;

  for (const line of lines) {
    if (line.includes("\t")) {
      if (current) commits.push(current);
      const [sha, author, date, ...rest] = line.split("\t");
      current = {
        sha: sha!,
        short_sha: sha!.slice(0, 8),
        author: author!,
        date: date!,
        subject: rest.join("\t"),
        added: 0,
        removed: 0,
      };
    } else if (current && /\bfile[s]?\b.*changed/.test(line)) {
      const ins = line.match(/(\d+) insertion/);
      const del = line.match(/(\d+) deletion/);
      if (ins) current.added = Number.parseInt(ins[1]!, 10);
      if (del) current.removed = Number.parseInt(del[1]!, 10);
    }
  }
  if (current) commits.push(current);

  return commits;
}

async function detectRepo(absPath: string): Promise<{ name: string; cwd: string }> {
  const dir = dirname(absPath);
  const result = await exec(["git", "rev-parse", "--show-toplevel"], { cwd: dir });
  if (result.exitCode !== 0) {
    throw new Error(`not inside a git repository: ${absPath}`);
  }
  const cwd = result.stdout.trim();
  return { name: basename(cwd), cwd };
}

function renderFileHistory(r: FileHistoryResult): string {
  const lines: string[] = [];
  lines.push(`file-history · ${r.repo}/${r.file}`);
  lines.push("");

  if (r.total_commits === 0) {
    lines.push("(no commits found for this path)");
    return lines.join("\n");
  }

  lines.push(
    `summary: ${r.total_commits} commit${r.total_commits === 1 ? "" : "s"} by ${r.authors.length} author${r.authors.length === 1 ? "" : "s"}, +${r.total_added}/-${r.total_removed} lines`,
  );
  if (r.last_commit) lines.push(`  last:  ${r.last_commit.sha}  ${r.last_commit.date}`);
  if (r.first_commit) lines.push(`  first: ${r.first_commit.sha}  ${r.first_commit.date}`);

  if (r.authors.length > 0) {
    lines.push("");
    lines.push("authors:");
    for (const a of r.authors.slice(0, 5)) {
      lines.push(`  ${a.commits.toString().padStart(3)}  ${a.name}`);
    }
    if (r.authors.length > 5) lines.push(`  ... +${r.authors.length - 5} more`);
  }

  lines.push("");
  lines.push(`recent (showing ${r.commits.length} of ${r.total_commits}):`);
  for (const c of r.commits) {
    const dateOnly = c.date.slice(0, 10);
    const sig = `+${c.added}/-${c.removed}`.padStart(10);
    const author = c.author.slice(0, 18).padEnd(18);
    lines.push(`  ${c.short_sha}  ${dateOnly}  ${sig}  ${author}  ${c.subject}`);
  }

  return lines.join("\n");
}
