/**
 * Benchmark `harn grep`'s two engines (ripgrep vs GNU grep) over a synthetic
 * multi-repo tree, or over a real directory you point it at.
 *
 *   bun scripts/bench-grep.ts                       # synthetic tree (default)
 *   bun scripts/bench-grep.ts --repos 12 --files 400 --iterations 5
 *   bun scripts/bench-grep.ts --path /some/monorepo --pattern someSymbol
 *
 * Synthetic mode builds N fake "repos" of M files each (~1.5KB per file, a
 * seeded fraction containing the needle), then times runGrep with the engine
 * forced via HARNERY_GREP_ENGINE. Repos are searched concurrently by the
 * command itself, so this exercises the real code path end to end. Not run in
 * CI (timings are hardware-dependent); the correctness parity between engines
 * is pinned by tests/unit/grep-engine.test.ts instead.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGrep } from "../src/commands/grep.ts";

interface Args {
  repos: number;
  files: number;
  iterations: number;
  path?: string;
  pattern: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { repos: 8, files: 300, iterations: 3, pattern: "needle_bench_7f3a" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? "";
    if (a === "--repos") out.repos = Number.parseInt(next(), 10);
    else if (a === "--files") out.files = Number.parseInt(next(), 10);
    else if (a === "--iterations") out.iterations = Number.parseInt(next(), 10);
    else if (a === "--path") out.path = next();
    else if (a === "--pattern") out.pattern = next();
  }
  return out;
}

const FILLER =
  "const value = compute(input);\nfunction compute(x) { return x * 31 % 97; }\n" +
  "// routine line of code that does not match anything interesting\n";

function buildSyntheticTree(repos: number, filesPerRepo: number, pattern: string): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-grep-bench-"));
  for (let r = 0; r < repos; r++) {
    const repoDir = join(root, `repo-${r}`);
    for (let f = 0; f < filesPerRepo; f++) {
      const dir = join(repoDir, `pkg-${f % 10}`);
      mkdirSync(dir, { recursive: true });
      // Every 17th file carries the needle so matches are sparse but present.
      const body = f % 17 === 0 ? `${FILLER}export const ${pattern} = ${f};\n` : FILLER.repeat(8);
      writeFileSync(join(dir, `mod-${f}.ts`), body);
    }
    // Noise dirs that the default excludes should skip.
    const nm = join(repoDir, "node_modules", "dep");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "index.js"), `module.exports = "${pattern}";\n`.repeat(50));
  }
  return root;
}

async function timeEngine(
  engine: "rg" | "grep",
  pattern: string,
  context: { repoRoot: string; submodules: string[] } | undefined,
  paths: string[],
  iterations: number,
): Promise<{ median_ms: number; runs: number[]; matches: number }> {
  process.env.HARNERY_GREP_ENGINE = engine;
  const runs: number[] = [];
  let matches = 0;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const r = await runGrep(pattern, paths, context ? { allRepos: true } : {}, context);
    runs.push(Math.round(performance.now() - t0));
    matches = r.total_matches;
  }
  delete process.env.HARNERY_GREP_ENGINE;
  const sorted = [...runs].sort((a, b) => a - b);
  return { median_ms: sorted[Math.floor(sorted.length / 2)] ?? 0, runs, matches };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const hasRg = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  if (!hasRg) console.error("note: rg not on PATH — benchmarking grep only");

  let root: string;
  let context: { repoRoot: string; submodules: string[] } | undefined;
  let paths: string[] = [];
  let cleanup = false;

  if (args.path) {
    root = args.path;
    paths = [root];
    console.log(`target: ${root} (real tree), pattern: /${args.pattern}/`);
  } else {
    console.log(
      `building synthetic tree: ${args.repos} repos x ${args.files} files (~1.5KB each)...`,
    );
    root = buildSyntheticTree(args.repos, args.files, args.pattern);
    context = {
      repoRoot: root,
      submodules: Array.from({ length: args.repos - 1 }, (_, i) => `repo-${i + 1}`),
    };
    cleanup = true;
  }

  try {
    const engines: ("rg" | "grep")[] = hasRg ? ["grep", "rg"] : ["grep"];
    const results: Record<string, { median_ms: number; runs: number[]; matches: number }> = {};
    for (const engine of engines) {
      results[engine] = await timeEngine(engine, args.pattern, context, paths, args.iterations);
    }

    console.log(`\niterations: ${args.iterations} (median reported)\n`);
    console.log("engine | median_ms | runs_ms          | matches");
    console.log("------ | --------- | ---------------- | -------");
    for (const [engine, r] of Object.entries(results)) {
      console.log(
        `${engine.padEnd(6)} | ${String(r.median_ms).padStart(9)} | ${r.runs.join(", ").padEnd(16)} | ${r.matches}`,
      );
    }
    const g = results.grep;
    const rg = results.rg;
    if (g && rg && rg.median_ms > 0) {
      console.log(`\nspeedup (grep/rg): ${(g.median_ms / rg.median_ms).toFixed(1)}x`);
      if (g.matches !== rg.matches) {
        console.error(`WARNING: match counts differ (grep=${g.matches}, rg=${rg.matches})`);
        process.exitCode = 1;
      }
    }
  } finally {
    if (cleanup) rmSync(root, { recursive: true, force: true });
  }
}

await main();
