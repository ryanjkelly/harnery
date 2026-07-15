import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GrepOpts,
  type GrepResult,
  type Match,
  NulDecoder,
  runGrep,
} from "../../src/commands/grep.ts";

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
  // Same extension as a positive include glob — must STAY excluded (rg globs
  // are last-match-wins; regression guard for positive-glob ordering).
  write("node_modules/dep/readme.md", "needle inside node_modules markdown\n");
  // Host-injected exclude (mirror dir).
  write(".mirror-data/copy.md", "needle inside mirror\n");
  // A "submodule" checkout with its own hit, to exercise parent pruning.
  write("subrepo/inner.ts", "submodule needle\n");

  // NUL-framing fixtures: paths that break punctuation-based parsers.
  write("framing/note-2-draft.md", "quark here\n");
  write("framing/odd:colon.txt", "quark line\n");
  write("framing/with space.txt", "quark spaced\n");

  // Context fixtures. ctx/main.txt: matches on lines 1 and 5 of 8.
  write("ctx/main.txt", "one cmark\nline2\nline3\nline4\nfive cmark\nline6\nline7\nline8\n");
  write("ctx/tricky.txt", "pre:fix-line\na:b-c cmark d:e\npost-line:9\n");
  write("ctx/crlf.txt", "l1 crmark\r\nl2\r\nl3\r\n");
  write("ctx/exact.txt", "hit xmark\nhit xmark\nhit xmark\n");

  // Boolean-composition fixtures.
  write("comp/a-first.md", "zapple only\n");
  write("comp/both.md", "zapple\nzbanana\n");
  write("comp/onlyb.md", "zbanana\n");
  write("comp/all3.md", "zapple zbanana zcherry\n");

  // Multi-lang fixtures.
  write("lang/x.ts", "quarklang ts\n");
  write("lang/y.tsx", "quarklang tsx\n");
  write("lang/z.js", "quarklang js\n");
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
    // A .md file inside node_modules must stay excluded even though it
    // matches the positive include glob (rg last-match-wins ordering).
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
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

describe("grep --files filename mode (rg --files vs find fallback)", () => {
  test("basename glob matches at any depth, hidden included, node_modules pruned", async () => {
    const r = await bothEngines("*.ts", [fixtureRoot], { files: true });
    expect(r.mode).toBe("files");
    const names = r.repos
      .flatMap((repo) => repo.matches.map((m) => m.file.replace(`${fixtureRoot}/`, "")))
      .sort();
    expect(names).toContain("alpha.ts");
    expect(names).toContain(".dotconf/hidden.ts");
    expect(names).toContain("subrepo/inner.ts");
    expect(names.some((f) => f.includes("node_modules"))).toBe(false);
    for (const repo of r.repos) {
      for (const m of repo.matches) {
        expect(m.line).toBe(0);
        expect(m.text).toBe("");
      }
    }
  });

  test("case-insensitive filename glob (-i)", async () => {
    const r = await bothEngines("ALPHA.TS", [fixtureRoot], { files: true, ignoreCase: true });
    const names = r.repos.flatMap((repo) => repo.matches.map((m) => m.file));
    expect(names.some((f) => f.endsWith("alpha.ts"))).toBe(true);
  });

  test("host grepExcludeDirs prunes mirrors in files mode too", async () => {
    const context = { grepExcludeDirs: [".mirror-data"] };
    const r = await bothEngines("*.md", [fixtureRoot], { files: true }, context);
    const names = r.repos.flatMap((repo) => repo.matches.map((m) => m.file));
    expect(names.some((f) => f.endsWith("beta.md"))).toBe(true);
    expect(names.some((f) => f.includes(".mirror-data"))).toBe(false);
  });

  test("--exclude file glob applies", async () => {
    const r = await bothEngines("*.ts", [fixtureRoot], { files: true, exclude: ["hidden.ts"] });
    const names = r.repos.flatMap((repo) => repo.matches.map((m) => m.file));
    expect(names.some((f) => f.endsWith("hidden.ts"))).toBe(false);
    expect(names.some((f) => f.endsWith("alpha.ts"))).toBe(true);
  });

  test("--limit truncates file lists", async () => {
    const viaFind = await runWith("grep", "*.ts", [fixtureRoot], { files: true, limit: "1" });
    expect(viaFind.total_matches).toBe(1);
    expect(viaFind.truncated).toBe(true);
  });

  test("content-search flags are rejected in files mode", async () => {
    for (const opts of [
      { files: true, lang: "ts" },
      { files: true, count: true },
      { files: true, literal: true },
      { files: true, context: "2" },
      { files: true, and: ["x"] },
      { files: true, without: ["x"] },
    ] satisfies GrepOpts[]) {
      expect(runWith("grep", "*.ts", [fixtureRoot], opts)).rejects.toThrow(/--files/);
    }
  });
});

describe("NUL framing", () => {
  test("hyphenated, colon-bearing, and spaced paths decode correctly", async () => {
    const r = await bothEngines("quark", [join(fixtureRoot, "framing")], {});
    const rows = r.repos.flatMap((repo) => repo.matches);
    const byFile = new Map(rows.map((m) => [m.file.split("/").at(-1), m]));
    expect(byFile.get("note-2-draft.md")).toMatchObject({ line: 1, text: "quark here" });
    expect(byFile.get("odd:colon.txt")).toMatchObject({ line: 1, text: "quark line" });
    expect(byFile.get("with space.txt")).toMatchObject({ line: 1, text: "quark spaced" });
    expect(r.total_matches).toBe(3);
    expect(r.total_files).toBe(3);
  });

  test("decoder survives a chunk boundary at every byte offset (incl. inside UTF-8)", () => {
    // Path carries a multi-byte char AND a dash-digit-dash; text carries a colon.
    const record = Buffer.from("pä-3-th\u000012:tex:t\n", "utf8");
    for (let split = 0; split <= record.length; split++) {
      const dec = new NulDecoder("content");
      const rows = [
        ...dec.push(record.subarray(0, split)),
        ...dec.push(record.subarray(split)),
        ...dec.flush(),
      ];
      expect(rows).toEqual([{ file: "pä-3-th", line: 12, text: "tex:t" }]);
    }
  });

  test("filesOnly decoder: NUL-terminated records; partial trailing record dropped", () => {
    const dec = new NulDecoder("filesOnly");
    const rows = [
      ...dec.push(Buffer.from("a.ts\u0000b/c.md\u0000partial-pa", "utf8")),
      ...dec.flush(),
    ];
    expect(rows).toEqual([
      { file: "a.ts", line: 0, text: "" },
      { file: "b/c.md", line: 0, text: "" },
    ]);
  });

  test("count decoder parses path\\0count records", () => {
    const dec = new NulDecoder("count");
    const rows = [...dec.push(Buffer.from("x-1-y.md\u000042\n", "utf8")), ...dec.flush()];
    expect(rows).toEqual([{ file: "x-1-y.md", line: 42, text: "" }]);
  });
});

describe("context materialization (-C/-A/-B)", () => {
  const ctxDir = () => join(fixtureRoot, "ctx");

  function shape(r: GrepResult): { line: number; kind: Match["kind"] }[] {
    return r.repos.flatMap((repo) => repo.matches.map((m) => ({ line: m.line, kind: m.kind })));
  }

  test("-C 1: disjoint windows, correct kinds, context excluded from totals", async () => {
    const r = await bothEngines("cmark", [join(ctxDir(), "main.txt")], { context: "1" });
    expect(shape(r)).toEqual([
      { line: 1, kind: "match" },
      { line: 2, kind: "context" },
      { line: 4, kind: "context" },
      { line: 5, kind: "match" },
      { line: 6, kind: "context" },
    ]);
    expect(r.total_matches).toBe(2);
    expect(r.total_files).toBe(1);
  });

  test("-C 2: overlapping windows merge into one contiguous block", async () => {
    const r = await bothEngines("cmark", [join(ctxDir(), "main.txt")], { context: "2" });
    expect(shape(r).map((s) => s.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(shape(r).filter((s) => s.kind === "match").map((s) => s.line)).toEqual([1, 5]);
    expect(r.total_matches).toBe(2);
  });

  test("-A/-B override -C per side, independent of order", async () => {
    const r = await bothEngines("cmark", [join(ctxDir(), "main.txt")], {
      context: "2",
      afterContext: "0",
    });
    // before=2 after=0: windows [1,1] (clamped) and [3,5].
    expect(shape(r)).toEqual([
      { line: 1, kind: "match" },
      { line: 3, kind: "context" },
      { line: 4, kind: "context" },
      { line: 5, kind: "match" },
    ]);
  });

  test("windows clamp at file start and end", async () => {
    const r = await bothEngines("cmark", [join(ctxDir(), "main.txt")], { context: "10" });
    expect(shape(r).map((s) => s.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("context text with colons and dashes stays intact", async () => {
    const r = await bothEngines("cmark", [join(ctxDir(), "tricky.txt")], { context: "1" });
    const rows = r.repos.flatMap((repo) => repo.matches);
    expect(rows.map((m) => m.text)).toEqual(["pre:fix-line", "a:b-c cmark d:e", "post-line:9"]);
    expect(rows.map((m) => m.kind)).toEqual(["context", "match", "context"]);
  });

  test("CRLF file: engines and materializer agree", async () => {
    const r = await bothEngines("crmark", [join(ctxDir(), "crlf.txt")], { context: "1" });
    const rows = r.repos.flatMap((repo) => repo.matches);
    expect(rows.map((m) => ({ line: m.line, kind: m.kind }))).toEqual([
      { line: 1, kind: "match" },
      { line: 2, kind: "context" },
    ]);
  });

  test("context rejected with -l, -c, and -q", async () => {
    for (const opts of [
      { context: "1", filesOnly: true },
      { context: "1", count: true },
      { context: "1", quiet: true },
      { afterContext: "1", filesOnly: true },
    ] satisfies GrepOpts[]) {
      expect(runWith("grep", "cmark", [ctxDir()], opts)).rejects.toThrow(/context/);
    }
  });
});

describe("truncation exactness", () => {
  test("exactly N results with --limit N is NOT truncated", async () => {
    const r = await bothEngines("xmark", [join(fixtureRoot, "ctx", "exact.txt")], { limit: "3" });
    expect(r.total_matches).toBe(3);
    expect(r.truncated).toBe(false);
  });

  test("N+1 results with --limit N IS truncated", async () => {
    const r = await bothEngines("xmark", [join(fixtureRoot, "ctx", "exact.txt")], { limit: "2" });
    expect(r.total_matches).toBe(2);
    expect(r.truncated).toBe(true);
  });

  test("--limit counts match rows only; selected rows keep full trailing context", async () => {
    const r = await bothEngines("cmark", [join(fixtureRoot, "ctx", "main.txt")], {
      context: "1",
      limit: "1",
    });
    expect(r.total_matches).toBe(1);
    expect(r.truncated).toBe(true);
    const rows = r.repos.flatMap((repo) => repo.matches);
    // Selected match is line 1 (sorted); its full window [1,2] survives.
    expect(rows.map((m) => ({ line: m.line, kind: m.kind }))).toEqual([
      { line: 1, kind: "match" },
      { line: 2, kind: "context" },
    ]);
  });
});

describe("boolean composition (--and / --without)", () => {
  const compDir = () => join(fixtureRoot, "comp");

  function fileNames(r: GrepResult): string[] {
    return [
      ...new Set(r.repos.flatMap((repo) => repo.matches.map((m) => m.file.split("/").at(-1)))),
    ].sort() as string[];
  }

  test("--and keeps only files containing every pattern; rows stay primary-pattern rows", async () => {
    const r = await bothEngines("zapple", [compDir()], { and: ["zbanana"] });
    expect(fileNames(r)).toEqual(["all3.md", "both.md"]);
    for (const m of r.repos.flatMap((repo) => repo.matches)) {
      expect(m.text).toContain("zapple");
    }
    expect(r.and_patterns).toEqual(["zbanana"]);
  });

  test("repeated --and intersects all patterns", async () => {
    const r = await bothEngines("zapple", [compDir()], { and: ["zbanana", "zcherry"] });
    expect(fileNames(r)).toEqual(["all3.md"]);
  });

  test("--without drops files containing any listed pattern", async () => {
    const r = await bothEngines("zapple", [compDir()], {
      and: ["zbanana"],
      without: ["zcherry"],
    });
    expect(fileNames(r)).toEqual(["both.md"]);
    expect(r.without_patterns).toEqual(["zcherry"]);
  });

  test("no qualifying files yields empty, not truncated", async () => {
    const r = await bothEngines("zapple", [compDir()], { and: ["zzz-not-present"] });
    expect(r.total_matches).toBe(0);
    expect(r.truncated).toBe(false);
  });

  test("REGRESSION: --limit cannot be consumed by non-qualifying files", async () => {
    // comp/a-first.md matches the primary pattern but NOT --and; with the old
    // filter-after-limit design, limit 1 could select it and then filter to 0.
    const r = await bothEngines("zapple", [compDir()], { and: ["zbanana"], limit: "1" });
    expect(r.total_matches).toBe(1);
    const rows = r.repos.flatMap((repo) => repo.matches);
    expect(["all3.md", "both.md"]).toContain(rows[0]?.file.split("/").at(-1) ?? "");
  });

  // Root reads through chmod 000, so the trigger can't fire under root/CI-as-root.
  test.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "partial membership scan REJECTS the command (incomplete set can't prove absence)",
    async () => {
      const strictDir = join(fixtureRoot, "strict");
      mkdirSync(strictDir, { recursive: true });
      writeFileSync(join(strictDir, "ok.md"), "zapple zbanana\n");
      writeFileSync(join(strictDir, "locked.md"), "zbanana\n");
      chmodSync(join(strictDir, "locked.md"), 0o000);
      try {
        // The --and membership scan hits the unreadable file (engine exit 2)
        // and must reject — NOT treat the partial set as authoritative.
        expect(runWith("grep", "zapple", [strictDir], { and: ["zbanana"] })).rejects.toThrow(
          /exited 2/,
        );
        if (hasRg) {
          expect(runWith("rg", "zapple", [strictDir], { and: ["zbanana"] })).rejects.toThrow(
            /exited 2/,
          );
        }
        // The PRIMARY scan stays lenient: same tree without --and still
        // surfaces the readable file's matches.
        const lenient = await bothEngines("zapple", [strictDir], {});
        expect(lenient.total_matches).toBe(1);
      } finally {
        chmodSync(join(strictDir, "locked.md"), 0o644);
      }
    },
  );

  test("--and works with -l and -c output modes", async () => {
    const l = await bothEngines("zapple", [compDir()], { and: ["zbanana"], filesOnly: true });
    expect(fileNames(l)).toEqual(["all3.md", "both.md"]);
    const c = await bothEngines("zapple", [compDir()], { and: ["zbanana"], count: true });
    expect(fileNames(c)).toEqual(["all3.md", "both.md"]);
    for (const m of c.repos.flatMap((repo) => repo.matches)) expect(m.line).toBe(1);
  });
});

describe("multi-value --lang", () => {
  test("comma-separated and repeated forms produce identical unions", async () => {
    const comma = await bothEngines("quarklang", [join(fixtureRoot, "lang")], {
      lang: ["ts,tsx"],
    });
    const repeated = await bothEngines("quarklang", [join(fixtureRoot, "lang")], {
      lang: ["ts", "tsx"],
    });
    expect(comparable(comma)).toEqual(comparable(repeated));
    const names = comma.repos.flatMap((repo) => repo.matches.map((m) => m.file.split("/").at(-1)));
    expect(names.sort()).toEqual(["x.ts", "y.tsx"]);
  });

  test("single --lang keeps its existing narrow meaning", async () => {
    const r = await bothEngines("quarklang", [join(fixtureRoot, "lang")], { lang: "ts" });
    const names = r.repos.flatMap((repo) => repo.matches.map((m) => m.file.split("/").at(-1)));
    expect(names).toEqual(["x.ts"]);
  });

  test("unknown lang in a comma list is rejected", async () => {
    expect(runWith("grep", "quarklang", [fixtureRoot], { lang: ["ts,bogus"] })).rejects.toThrow(
      /unknown --lang "bogus"/,
    );
  });
});

describe("numeric validation and flag compatibility", () => {
  test("invalid numeric values fail before any engine spawns", async () => {
    const bad: [GrepOpts, RegExp][] = [
      [{ limit: "nope" }, /--limit/],
      [{ limit: "0" }, /--limit/],
      [{ limit: "-1" }, /--limit/],
      [{ limit: "1.5" }, /--limit/],
      [{ limit: "2x" }, /--limit/],
      [{ maxCount: "0" }, /--max-count/],
      [{ context: "-1" }, /--context/],
      [{ afterContext: "junk" }, /--after-context/],
    ];
    for (const [opts, re] of bad) {
      expect(runWith("grep", "x", [fixtureRoot], opts)).rejects.toThrow(re);
    }
  });

  test("--quiet rejects --json, -l, -c, and --limit", async () => {
    for (const opts of [
      { quiet: true, json: true },
      { quiet: true, filesOnly: true },
      { quiet: true, count: true },
      { quiet: true, limit: "5" },
    ] satisfies GrepOpts[]) {
      expect(runWith("grep", "x", [fixtureRoot], opts)).rejects.toThrow(/--quiet/);
    }
  });
});

describe("quiet mode exit codes (spawned CLI)", () => {
  const harneryRoot = join(import.meta.dir, "..", "..");
  const harn = join(harneryRoot, "bin", "harn");

  test("exit 0 on hit, exit 1 on miss, no stdout either way", () => {
    const hit = spawnSync(harn, ["grep", "-q", "needle", "alpha.ts"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    expect(hit.status).toBe(0);
    expect(hit.stdout).toBe("");

    const miss = spawnSync(harn, ["grep", "-q", "zz-definitely-absent-zz", "alpha.ts"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    expect(miss.status).toBe(1);
    expect(miss.stdout).toBe("");
  });

  test("quiet respects --and qualification", () => {
    const miss = spawnSync(harn, ["grep", "-q", "zapple", "--and", "zz-absent", "comp"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    expect(miss.status).toBe(1);

    const hit = spawnSync(harn, ["grep", "-q", "zapple", "--and", "zbanana", "comp"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    expect(hit.status).toBe(0);
  });
});

describe("envelope contract", () => {
  test("top-level, repo, and row keys are pinned exactly", async () => {
    const r = await runWith("grep", "cmark", [join(fixtureRoot, "ctx", "main.txt")], {
      context: "1",
    });
    expect(Object.keys(r).sort()).toEqual([
      "and_patterns",
      "elapsed_ms",
      "engine",
      "mode",
      "pattern",
      "repos",
      "total_files",
      "total_matches",
      "truncated",
      "without_patterns",
    ]);
    const repo = r.repos[0];
    expect(Object.keys(repo ?? {}).sort()).toEqual(["cwd", "matches", "name", "truncated"]);
    const row = repo?.matches[0];
    expect(Object.keys(row ?? {}).sort()).toEqual(["file", "kind", "line", "repo", "text"]);
  });
});
