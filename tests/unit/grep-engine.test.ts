import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GrepOpts, type GrepResult, runGrep } from "../../src/commands/grep.ts";

/**
 * Engine-parity suite: the same search run through GNU grep and ripgrep must
 * produce identical envelopes (modulo `engine` + `elapsed_ms`). This is what
 * lets the command silently prefer rg when it's on PATH — any semantic drift
 * between the engines fails here.
 */

const hasRg = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;

let fixtureRoot: string;

/** Strip the run-specific fields so envelopes can be deep-compared across engines. */
function comparable(r: GrepResult): Omit<GrepResult, "engine" | "elapsed_ms"> {
  const { engine: _engine, elapsed_ms: _elapsed, ...rest } = r;
  return rest;
}

async function runWith(
  engine: "rg" | "grep",
  pattern: string,
  paths: string[],
  opts: GrepOpts,
  context?: Parameters<typeof runGrep>[3],
): Promise<GrepResult> {
  const prev = process.env.HARNERY_GREP_ENGINE;
  process.env.HARNERY_GREP_ENGINE = engine;
  try {
    return await runGrep(pattern, paths, opts, context);
  } finally {
    if (prev === undefined) delete process.env.HARNERY_GREP_ENGINE;
    else process.env.HARNERY_GREP_ENGINE = prev;
  }
}

/** Run both engines and assert the envelopes match; returns the grep one. */
async function bothEngines(
  pattern: string,
  paths: string[],
  opts: GrepOpts,
  context?: Parameters<typeof runGrep>[3],
): Promise<GrepResult> {
  const viaGrep = await runWith("grep", pattern, paths, opts, context);
  if (hasRg) {
    const viaRg = await runWith("rg", pattern, paths, opts, context);
    expect(comparable(viaRg)).toEqual(comparable(viaGrep));
  }
  return viaGrep;
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "harnery-grep-"));
  const write = (rel: string, content: string) => {
    const abs = join(fixtureRoot, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  };

  // Parent-repo files.
  write("alpha.ts", "export const needle = 1;\nplain line\nconst needle2 = 2;\n");
  write("beta.md", "docs mention needle once\n");
  write("clean.txt", "nothing to see\n");
  // Hidden dir: searched (engines run with hidden dirs enabled).
  write(".dotconf/hidden.ts", "hidden needle\n");
  // Default-excluded dir: never searched.
  write("node_modules/dep/index.js", "needle inside node_modules\n");
  // Host-injected exclude (mirror dir).
  write(".mirror-data/copy.md", "needle inside mirror\n");
  // A "submodule" checkout with its own hit, to exercise parent pruning.
  write("subrepo/inner.ts", "submodule needle\n");
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("grep engine parity", () => {
  test("explicit path search finds expected files only", async () => {
    const r = await bothEngines("needle", [fixtureRoot], {});
    const files = new Set(r.repos.flatMap((repo) => repo.matches.map((m) => m.file)));
    const names = [...files].map((f) => f.replace(`${fixtureRoot}/`, ""));
    expect(names).toContain("alpha.ts");
    expect(names).toContain("beta.md");
    expect(names).toContain(".dotconf/hidden.ts");
    expect(names).toContain(".mirror-data/copy.md"); // no host excludes in this run
    expect(names).not.toContain("node_modules/dep/index.js");
  });

  test("matches are sorted by (file, line) for stable cross-engine output", async () => {
    const r = await bothEngines("needle", [fixtureRoot], {});
    const flat = r.repos.flatMap((repo) => repo.matches.map((m) => `${m.file}:${m.line}`));
    const sorted = [...flat].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    // Same file ordering; within-file line order preserved numerically.
    expect(flat.map((f) => f.split(":")[0])).toEqual(sorted.map((f) => f.split(":")[0]));
  });

  test("-l files-only mode", async () => {
    const r = await bothEngines("needle", [fixtureRoot], { filesOnly: true });
    for (const repo of r.repos) {
      for (const m of repo.matches) {
        expect(m.line).toBe(0);
        expect(m.text).toBe("");
      }
    }
    expect(r.total_matches).toBeGreaterThan(0);
  });

  test("-c count mode filters zero-count rows on both engines", async () => {
    const r = await bothEngines("needle", [fixtureRoot], { count: true });
    for (const repo of r.repos) {
      for (const m of repo.matches) expect(m.line).toBeGreaterThan(0);
    }
    // clean.txt has no matches: must not appear as a :0 row.
    const files = r.repos.flatMap((repo) => repo.matches.map((m) => m.file));
    expect(files.some((f) => f.endsWith("clean.txt"))).toBe(false);
  });

  test("case-insensitive + whole-word + literal flags", async () => {
    const r = await bothEngines("NEEDLE", [fixtureRoot], {
      ignoreCase: true,
      wholeWord: true,
      literal: true,
    });
    const files = r.repos.flatMap((repo) => repo.matches.map((m) => m.file));
    // `needle` appears as a whole word in alpha.ts line 1 (not needle2).
    expect(files.some((f) => f.endsWith("alpha.ts"))).toBe(true);
    const alphaMatches = r.repos
      .flatMap((repo) => repo.matches)
      .filter((m) => m.file.endsWith("alpha.ts"));
    expect(alphaMatches.every((m) => m.line === 1)).toBe(true);
  });

  test("--include glob narrows to one extension", async () => {
    const r = await bothEngines("needle", [fixtureRoot], { include: ["*.md"] });
    const files = r.repos.flatMap((repo) => repo.matches.map((m) => m.file));
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.endsWith(".md"))).toBe(true);
  });

  test("--limit truncates and flags the envelope", async () => {
    // Under a limit, WHICH matches survive depends on engine walk order
    // (documented), so assert count + flag parity rather than identity.
    const viaGrep = await runWith("grep", "needle", [fixtureRoot], { limit: "2" });
    expect(viaGrep.total_matches).toBe(2);
    expect(viaGrep.truncated).toBe(true);
    if (hasRg) {
      const viaRg = await runWith("rg", "needle", [fixtureRoot], { limit: "2" });
      expect(viaRg.total_matches).toBe(2);
      expect(viaRg.truncated).toBe(true);
    }
  });

  test("no matches is normal (exit 1), not an error", async () => {
    const r = await bothEngines("definitely-not-present-zzz", [fixtureRoot], {});
    expect(r.total_matches).toBe(0);
    expect(r.truncated).toBe(false);
  });

  test("host grepExcludeDirs hides mirror dirs; --no-default-excludes restores them", async () => {
    const context = { grepExcludeDirs: [".mirror-data"] };
    const r = await bothEngines("needle", [fixtureRoot], {}, context);
    const files = r.repos.flatMap((repo) => repo.matches.map((m) => m.file));
    expect(files.some((f) => f.includes(".mirror-data"))).toBe(false);

    const rAll = await bothEngines("needle", [fixtureRoot], { noDefaultExcludes: true }, context);
    const allFiles = rAll.repos.flatMap((repo) => repo.matches.map((m) => m.file));
    expect(allFiles.some((f) => f.includes(".mirror-data"))).toBe(true);
    expect(allFiles.some((f) => f.includes("node_modules"))).toBe(true);
  });

  test("--all-repos prunes submodule dirs from the parent scan (no double-reporting)", async () => {
    const context = { repoRoot: fixtureRoot, submodules: ["subrepo"] };
    const r = await bothEngines("needle", [], { allRepos: true }, context);

    const parent = r.repos.find((repo) => repo.name === "parent");
    const sub = r.repos.find((repo) => repo.name === "subrepo");
    expect(parent).toBeDefined();
    expect(sub).toBeDefined();

    // The submodule's match appears exactly once: under the submodule.
    expect(sub?.matches.map((m) => m.file)).toContain("inner.ts");
    expect(parent?.matches.some((m) => m.file.includes("subrepo"))).toBe(false);

    // Parent still finds its own files.
    expect(parent?.matches.some((m) => m.file.endsWith("alpha.ts"))).toBe(true);
  });

  test("envelope reports which engine ran", async () => {
    const viaGrep = await runWith("grep", "needle", [fixtureRoot], {});
    expect(viaGrep.engine).toBe("grep");
    if (hasRg) {
      const viaRg = await runWith("rg", "needle", [fixtureRoot], {});
      expect(viaRg.engine).toBe("rg");
    }
  });

  test.skipIf(!hasRg)("rg output is deterministic across runs", async () => {
    const a = await runWith("rg", "needle", [fixtureRoot], {});
    const b = await runWith("rg", "needle", [fixtureRoot], {});
    expect(comparable(a)).toEqual(comparable(b));
  });
});
