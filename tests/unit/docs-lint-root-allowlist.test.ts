import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDocsContext, runLint } from "../../src/lib/docs-lint.ts";

// Build a throwaway repo-root with a docs/ tree. Not a git repo, so the
// markdown-discovery pass (git ls-files) returns nothing — isolating the
// docs-root-file rule, which reads docs/ via readdirSync directly.
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harn-docs-root-"));
  writeFileSync(join(root, "README.md"), "# fixture\n");
  const docs = join(root, "docs");
  mkdirSync(docs);
  writeFileSync(join(docs, "runbook.md"), "# runbook\n"); // allowlisted
  writeFileSync(join(docs, "stray-topic.md"), "# stray\n"); // NOT allowlisted
  writeFileSync(join(docs, "policy.json"), "{}\n"); // NOT allowlisted (.json counts)
  mkdirSync(join(docs, "guides")); // subdir — topic home, ignored
  writeFileSync(join(docs, "guides", "a-guide.md"), "# guide\n");
  return root;
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("docs-root-file rule", () => {
  test("flags loose non-allowlisted files at docs/ root, spares allowlisted + subdirs", async () => {
    const root = makeFixture();
    roots.push(root);
    initDocsContext({ repoRoot: root, submodules: [], docsRootAllowlist: ["runbook.md"] });
    const rootFile = (await runLint({ fast: true })).filter((v) => v.rule === "docs-root-file");
    const flagged = rootFile.map((v) => v.path).sort();
    expect(flagged).toEqual(["docs/policy.json", "docs/stray-topic.md"]);
  });

  test("no-op when no allowlist is configured (generic hosts unaffected)", async () => {
    const root = makeFixture();
    roots.push(root);
    initDocsContext({ repoRoot: root, submodules: [] }); // no docsRootAllowlist
    const rootFile = (await runLint({ fast: true })).filter((v) => v.rule === "docs-root-file");
    expect(rootFile).toEqual([]);
  });
});
