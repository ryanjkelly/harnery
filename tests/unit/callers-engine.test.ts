import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Engine-parity for `callers`: the whole-word symbol search + kind
 * classification must match between GNU grep and ripgrep. Exercises the
 * command through its registered action so the real code path (engine
 * resolution, parallel repos, parse/classify) is covered.
 */

const hasRg = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;

let fixtureRoot: string;
let origCwd: string;

interface CallersResult {
  symbol: string;
  callers: { repo: string; file: string; line: number; kind: string; text: string }[];
  by_kind: Record<string, number>;
  total: number;
  truncated: boolean;
  elapsed_ms: number;
}

/** Invoke the registered `callers` command with a forced engine; capture emit.data(). */
async function runCallers(
  engine: "rg" | "grep",
  symbol: string,
  extraArgs: string[],
  context: { repoRoot: string; submodules: string[] } | undefined,
): Promise<CallersResult> {
  const prev = process.env.HARNERY_GREP_ENGINE;
  process.env.HARNERY_GREP_ENGINE = engine;
  const { Command } = await import("commander");
  const { registerCallersCommand } = await import("../../src/commands/callers.ts");
  try {
    let captured: CallersResult | undefined;
    const program = new Command();
    const emit = {
      data: (d: unknown) => {
        captured = d as CallersResult;
      },
      text: () => {},
      config: () => {},
      error: (e: { message: string }) => {
        throw new Error(e.message);
      },
      setExitCode: () => {},
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal emit stub for the command action
    registerCallersCommand(program, emit as any, context);
    await program.parseAsync(["callers", symbol, "--json", ...extraArgs], { from: "user" });
    if (!captured) throw new Error("no result captured");
    return captured;
  } finally {
    if (prev === undefined) delete process.env.HARNERY_GREP_ENGINE;
    else process.env.HARNERY_GREP_ENGINE = prev;
  }
}

/** Compare-and-return: run both engines, assert parity (modulo timing/order). */
async function bothEngines(
  symbol: string,
  extraArgs: string[],
  context?: { repoRoot: string; submodules: string[] },
): Promise<CallersResult> {
  const viaGrep = await runCallers("grep", symbol, extraArgs, context);
  if (hasRg) {
    const viaRg = await runCallers("rg", symbol, extraArgs, context);
    const key = (c: CallersResult) =>
      c.callers
        .map((x) => `${x.repo}:${x.file}:${x.line}:${x.kind}`)
        .sort()
        .join("|");
    expect(key(viaRg)).toBe(key(viaGrep));
    expect(viaRg.by_kind).toEqual(viaGrep.by_kind);
  }
  return viaGrep;
}

beforeAll(() => {
  origCwd = process.cwd();
  fixtureRoot = mkdtempSync(join(tmpdir(), "harnery-callers-"));
  const write = (rel: string, content: string) => {
    const abs = join(fixtureRoot, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  };
  write(
    "src/widget.ts",
    [
      "export function doThing(x: number) {", // decl
      "  return x + 1;",
      "}",
      "import { doThing } from './widget';", // import
      "const r = doThing(41);", // call
      "// doThing is great", // comment (filtered by default)
      "const notdoThing = 1;", // not a whole-word match
      "type T = doThing;", // type-ish ref
    ].join("\n"),
  );
  write("src/other.js", "doThing();\nconst doThingRef = doThing;\n");
  write("node_modules/dep/index.js", "doThing(); // must be excluded\n");
  write(".hidden/probe.ts", "doThing(); // hidden dir IS searched\n");
  write("sub/inner.ts", "doThing(); // submodule\n");
  // cwd-mode tests (no --repo/--all-repos) search process.cwd().
  process.chdir(fixtureRoot);
});

afterAll(() => {
  process.chdir(origCwd);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("callers engine parity", () => {
  test("finds callers, excludes node_modules, searches hidden dirs", async () => {
    const r = await bothEngines("doThing", []);
    const files = r.callers.map((c) => c.file);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.includes(".hidden"))).toBe(true);
    // Whole-word: notdoThing must not be reported (it's not a doThing token).
    expect(r.callers.some((c) => c.text.includes("notdoThing = 1"))).toBe(false);
    expect(r.total).toBeGreaterThan(0);
  });

  test("declarations filtered by default, opted back in with --include-decl", async () => {
    const base = await bothEngines("doThing", []);
    expect(base.by_kind.decl ?? 0).toBe(0);
    const withDecl = await bothEngines("doThing", ["--include-decl"]);
    expect(withDecl.by_kind.decl ?? 0).toBeGreaterThan(0);
  });

  test("comments filtered by default, opted back in with --include-comments", async () => {
    const base = await bothEngines("doThing", []);
    const withComments = await bothEngines("doThing", ["--include-comments"]);
    expect(withComments.total).toBeGreaterThanOrEqual(base.total);
  });

  test("kind classification agrees across engines (call/import)", async () => {
    const r = await bothEngines("doThing", []);
    expect(r.by_kind.call ?? 0).toBeGreaterThan(0);
    expect(r.by_kind.import ?? 0).toBeGreaterThan(0);
  });

  test("--lang filter", async () => {
    const r = await bothEngines("doThing", ["--lang", "ts"]);
    expect(r.callers.every((c) => c.file.endsWith(".ts") || c.file.endsWith(".tsx"))).toBe(true);
  });

  test("--all-repos attributes each match to one repo", async () => {
    const context = { repoRoot: fixtureRoot, submodules: ["sub"] };
    const r = await bothEngines("doThing", ["--all-repos"], context);
    const parent = r.callers.filter((c) => c.repo === "parent");
    const sub = r.callers.filter((c) => c.repo === "sub");
    expect(sub.some((c) => c.file === "inner.ts")).toBe(true);
    expect(parent.some((c) => c.file.startsWith("sub/"))).toBe(false);
  });
});
