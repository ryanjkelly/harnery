import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractStatus } from "../../src/lib/docs-index.ts";
import { hasStatusHeader, initDocsContext, runLint } from "../../src/lib/docs-lint.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function writeDoc(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "harn-doc-status-"));
  roots.push(root);
  const path = join(root, "doc.md");
  writeFileSync(path, content);
  return path;
}

function makeLintRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "harn-doc-status-lint-"));
  roots.push(root);
  writeFileSync(join(root, "README.md"), "# fixture\n");
  mkdirSync(join(root, "docs", "plans", "archive"), { recursive: true });
  mkdirSync(join(root, "docs", "issues"), { recursive: true });
  mkdirSync(join(root, "docs", "handoffs", "2026-07"), { recursive: true });
  writeFileSync(join(root, "docs", "plans", "yaml.md"), "---\nstatus: proposed\n---\n# YAML\n");
  writeFileSync(join(root, "docs", "plans", "legacy.md"), "# Legacy\n\n**Status:** proposed\n");
  writeFileSync(
    join(root, "docs", "plans", "archive", "archived.md"),
    "# Archived\n\n**Status:** shipped\n",
  );
  writeFileSync(
    join(root, "docs", "issues", "2026-07-13_legacy.md"),
    "# Issue\n\n**Status:** open\n",
  );
  writeFileSync(
    join(root, "docs", "handoffs", "2026-07", "2026-07-13_legacy.md"),
    "# Handoff\n\n**Status:** open\n",
  );

  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["add", "."]);
  git(["commit", "-qm", "fixture"]);
  return root;
}

describe("docs status consumers", () => {
  test("lint accepts a leading YAML status", () => {
    expect(hasStatusHeader(writeDoc("---\nstatus: proposed\n---\n# Plan\n"))).toBe(true);
  });

  test("lint rejects a legacy bold status", () => {
    expect(hasStatusHeader(writeDoc("# Plan\n\n**Status:** proposed\n"))).toBe(false);
  });

  test("issue index prefers and normalizes YAML status", () => {
    const content = "---\nstatus: done\n---\n# Issue\n\n**Status:** open\n";
    expect(extractStatus(content)).toBe("resolved");
  });

  test("issue index ignores legacy bold status", () => {
    expect(extractStatus("# Issue\n\n**Status:** resolved\n")).toBeUndefined();
  });

  test("full lint hard-fails bold-only lifecycle files including handoffs and archives", async () => {
    const root = makeLintRepo();
    initDocsContext({ repoRoot: root, submodules: [] });

    const violations = (await runLint({ fast: false, repo: "." })).filter(
      (violation) => violation.rule === "missing-status-header",
    );

    expect(violations.map((violation) => violation.path).sort()).toEqual(
      [
        "docs/handoffs/2026-07/2026-07-13_legacy.md",
        "docs/issues/2026-07-13_legacy.md",
        "docs/plans/archive/archived.md",
        "docs/plans/legacy.md",
      ].sort(),
    );
    expect(violations.every((violation) => violation.severity === "error")).toBe(true);
  });
});
