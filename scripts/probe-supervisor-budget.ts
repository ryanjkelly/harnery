import { copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SUPERVISOR_RESOURCE_BUDGET } from "../src/core/supervisor/contract.ts";

interface ProbeResult {
  schema: "harnery.supervisor-budget-probe/v1";
  ref: string;
  samples: number;
  startup_duration_ms: number;
  cycle_duration_ms: { median: number; p95: number };
  collectors: Record<string, { median_ms: number; p95_ms: number }>;
  rss_bytes: { after_warmup: number; max: number };
  cache_bytes: number;
  ceilings: typeof SUPERVISOR_RESOURCE_BUDGET;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const temporaryRoot = mkdtempSync(join(tmpdir(), "harn-supervisor-refs-"));

try {
  const baseline = runRef(repoRoot, temporaryRoot, "baseline", args.baseline);
  const candidate = runRef(repoRoot, temporaryRoot, "candidate", args.candidate);
  const checks = compare(baseline, candidate);
  const output = {
    schema: "harnery.supervisor-budget-comparison/v1",
    baseline,
    candidate,
    checks,
    passed: checks.every((check) => check.passed),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.passed) process.exitCode = 1;
} finally {
  removeWorktree(repoRoot, join(temporaryRoot, "baseline"));
  removeWorktree(repoRoot, join(temporaryRoot, "candidate"));
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function parseArgs(argv: readonly string[]): { baseline: string; candidate: string } {
  let baseline: string | undefined;
  let candidate: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--baseline") baseline = argv[++index];
    else if (token === "--candidate") candidate = argv[++index];
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!baseline || !candidate) {
    throw new Error("usage: probe-supervisor-budget --baseline <ref> --candidate <ref>");
  }
  return { baseline, candidate };
}

function runRef(repoRoot: string, temporaryRoot: string, label: string, ref: string): ProbeResult {
  verifyRef(repoRoot, ref);
  const worktree = join(temporaryRoot, label);
  run(repoRoot, ["git", "worktree", "add", "--detach", worktree, ref]);
  copyFileSync(
    join(repoRoot, "scripts", "probe-supervisor-budget-worker.ts"),
    join(worktree, "scripts", "probe-supervisor-budget-worker.ts"),
  );
  run(worktree, ["bun", "install", "--frozen-lockfile", "--ignore-scripts"]);
  const result = Bun.spawnSync({
    cmd: ["bun", "run", "scripts/probe-supervisor-budget-worker.ts"],
    cwd: worktree,
    env: { ...process.env, HARNERY_PROBE_REF: ref },
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`budget probe failed for ${ref}`);
  return JSON.parse(result.stdout.toString()) as ProbeResult;
}

function verifyRef(repoRoot: string, ref: string): void {
  const result = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--verify", `${ref}^{commit}`],
    cwd: repoRoot,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) throw new Error(`baseline or candidate ref does not resolve: ${ref}`);
}

function removeWorktree(repoRoot: string, path: string): void {
  Bun.spawnSync({
    cmd: ["git", "worktree", "remove", "--force", path],
    cwd: repoRoot,
    stdout: "ignore",
    stderr: "ignore",
  });
}

function run(cwd: string, command: readonly string[]): void {
  const result = Bun.spawnSync({ cmd: [...command], cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed with ${result.exitCode}`);
}

function compare(baseline: ProbeResult, candidate: ProbeResult) {
  const ceilings = candidate.ceilings;
  return [
    hard("rss.max", candidate.rss_bytes.max, ceilings.max_rss_bytes),
    hard("cycle.p95", candidate.cycle_duration_ms.p95, ceilings.max_cycle_duration_ms),
    hard("startup", candidate.startup_duration_ms, ceilings.max_startup_duration_ms),
    hard("cache", candidate.cache_bytes, ceilings.max_cache_bytes),
    relative(
      "rss.max",
      baseline.rss_bytes.max,
      candidate.rss_bytes.max,
      8 * 1_024 * 1_024,
      ceilings.max_regression_ratio,
    ),
    relative(
      "cycle.p95",
      baseline.cycle_duration_ms.p95,
      candidate.cycle_duration_ms.p95,
      8,
      ceilings.max_regression_ratio,
    ),
    relative(
      "startup",
      baseline.startup_duration_ms,
      candidate.startup_duration_ms,
      100,
      ceilings.max_regression_ratio,
    ),
    relative(
      "cache",
      baseline.cache_bytes,
      candidate.cache_bytes,
      512 * 1_024,
      ceilings.max_regression_ratio,
    ),
  ];
}

function hard(metric: string, actual: number, ceiling: number) {
  return {
    kind: "hard",
    metric,
    baseline: null,
    candidate: actual,
    limit: ceiling,
    passed: actual <= ceiling,
  };
}

function relative(
  metric: string,
  baseline: number,
  candidate: number,
  absoluteAllowance: number,
  ratio: number,
) {
  const limit = baseline + Math.max(absoluteAllowance, baseline * (ratio - 1));
  return { kind: "relative", metric, baseline, candidate, limit, passed: candidate <= limit };
}
