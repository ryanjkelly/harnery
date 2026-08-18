import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectIndexTargets, initDocsContext, runIndex } from "./docs-index.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function markedReadme(kind: "issues" | "audits"): string {
  const header =
    kind === "issues"
      ? "| Date | File | Status | Description |\n|------|------|--------|-------------|\n"
      : "| Date | File | Description |\n|------|------|-------------|\n";
  return `# ${kind}\n\n<!-- BEGIN INDEX -->\n${header}<!-- END INDEX -->\n`;
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "harn-docs-index-"));
  roots.push(root);

  mkdirSync(join(root, "docs", "issues"), { recursive: true });
  writeFileSync(join(root, "docs", "issues", "README.md"), markedReadme("issues"));
  writeFileSync(join(root, "docs", "issues", "2026-08-01_root-issue.md"), "---\nstatus: open\n---\n# Root issue\n");

  mkdirSync(join(root, "in-tree", "docs", "issues"), { recursive: true });
  writeFileSync(join(root, "in-tree", "docs", "issues", "README.md"), markedReadme("issues"));
  writeFileSync(
    join(root, "in-tree", "docs", "issues", "2026-08-18_nested-issue.md"),
    "---\nstatus: resolved\n---\n# Nested issue\n",
  );

  mkdirSync(join(root, "submod", "docs", "issues"), { recursive: true });
  mkdirSync(join(root, "submod", ".git"));
  writeFileSync(join(root, "submod", "docs", "issues", "README.md"), markedReadme("issues"));
  writeFileSync(
    join(root, "submod", "docs", "issues", "2026-08-02_sub-issue.md"),
    "---\nstatus: open\n---\n# Sub issue\n",
  );

  return root;
}

describe("docs index in-tree packages", () => {
  test("collects first-level in-tree packages that are not git submodules", () => {
    const root = makeRepo();
    initDocsContext({ repoRoot: root, submodules: ["submod"] });
    const names = collectIndexTargets()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["(root)", "in-tree", "submod"]);
  });

  test("regenerates a nested in-tree issues README", async () => {
    const root = makeRepo();
    initDocsContext({ repoRoot: root, submodules: ["submod"] });
    const results = await runIndex({ dryRun: true, repo: "in-tree" });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("updated");
    expect(results[0]?.path).toBe(join("in-tree", "docs", "issues", "README.md"));
    expect(results[0]?.after).toContain("2026-08-18_nested-issue.md");
    expect(results[0]?.after).toContain("| resolved | Nested issue |");
    expect(results[0]?.after).not.toContain("root-issue");
  });
});
