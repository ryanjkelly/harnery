import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initDocsContext, runLint } from "../../src/lib/docs-lint.ts";

const roots: string[] = [];
const CREATED = "2026-08-29T08:00:00Z";

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function plan(title: string, body = "Original."): string {
  return [
    "---",
    "schema: harnery-doc/v2",
    "type: plan",
    `created_at: ${CREATED}`,
    `updated_at: ${CREATED}`,
    "owner: test-owner",
    `summary: ${title}.`,
    "status: proposed",
    `status_changed_at: ${CREATED}`,
    "---",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "harn-doc-view-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  writeFileSync(join(root, "docs", "plans", "peer.md"), plan("Peer plan"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  initDocsContext({ repoRoot: root, submodules: [] });
  return root;
}

describe("docs repository views", () => {
  test("index lint ignores a foreign worktree deletion while worktree lint reports it", async () => {
    const root = repo();
    rmSync(join(root, "docs", "plans", "peer.md"));
    writeFileSync(join(root, "docs", "plans", "ours.md"), plan("Our plan"));
    git(root, ["add", "docs/plans/ours.md"]);

    const indexViolations = await runLint({ fast: true, repo: ".", source: "index" });
    expect(indexViolations.filter((finding) => finding.severity === "error")).toEqual([]);

    const worktreeViolations = await runLint({ fast: true, repo: ".", source: "worktree" });
    expect(worktreeViolations).toContainEqual(
      expect.objectContaining({
        path: "docs/plans/peer.md",
        rule: "metadata-v2:file_unreadable",
      }),
    );
  });

  test("index lint reads staged bytes instead of a later worktree edit", async () => {
    const root = repo();
    const path = join(root, "docs", "plans", "peer.md");
    writeFileSync(path, plan("Peer plan", "Staged change."));
    git(root, ["add", "docs/plans/peer.md"]);
    writeFileSync(path, "# Broken worktree copy\n");

    const indexViolations = await runLint({ fast: true, repo: ".", source: "index" });
    expect(indexViolations.filter((finding) => finding.severity === "error")).toEqual([]);

    const worktreeViolations = await runLint({ fast: true, repo: ".", source: "worktree" });
    expect(worktreeViolations).toContainEqual(
      expect.objectContaining({ path: "docs/plans/peer.md", rule: "metadata-v2:missing_metadata" }),
    );
  });

  test("index lint preserves repository-wide invariants inside the proposed commit", async () => {
    const root = repo();
    git(root, ["rm", "-q", "README.md"]);

    const violations = await runLint({ fast: true, repo: ".", source: "index" });
    expect(violations).toContainEqual(
      expect.objectContaining({ path: "README.md", rule: "entry-tier" }),
    );
  });

  test("index lint ignores an untracked loose doc that is absent from the proposed commit", async () => {
    const root = repo();
    writeFileSync(join(root, "docs", "stray-topic.md"), "# Foreign draft\n");
    initDocsContext({
      repoRoot: root,
      submodules: [],
      docsRootAllowlist: ["documentation-guide.md"],
    });

    const indexViolations = await runLint({ fast: true, repo: ".", source: "index" });
    expect(indexViolations.map((finding) => finding.path)).not.toContain("docs/stray-topic.md");

    const worktreeViolations = await runLint({ fast: true, repo: ".", source: "worktree" });
    expect(worktreeViolations).toContainEqual(
      expect.objectContaining({ path: "docs/stray-topic.md", rule: "docs-root-file" }),
    );
  });

  test("a path-scoped commit validates Git's proposed index and leaves foreign staging intact", () => {
    const root = repo();
    const harneryRoot = resolve(import.meta.dir, "../..");
    const probe = join(root, "pre-commit-probe.ts");
    writeFileSync(
      probe,
      [
        `import { initDocsContext, runLint } from ${JSON.stringify(join(harneryRoot, "src/lib/docs-lint.ts"))};`,
        `initDocsContext({ repoRoot: ${JSON.stringify(root)}, submodules: [] });`,
        'const errors = (await runLint({ fast: true, repo: ".", source: "index" })).filter((finding) => finding.severity === "error");',
        "if (errors.length > 0) { console.error(JSON.stringify(errors)); process.exit(1); }",
        "",
      ].join("\n"),
    );
    const hook = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(
      hook,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}\n`,
      {
        mode: 0o755,
      },
    );

    git(root, ["rm", "-q", "docs/plans/peer.md"]);
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    writeFileSync(join(root, "docs", "plans", "ours.md"), plan("Our plan"));
    git(root, ["add", "docs/plans/ours.md"]);
    git(root, ["commit", "-qm", "ours", "--only", "--", "docs/plans/ours.md"]);

    expect(
      execFileSync("git", ["diff", "--cached", "--name-status"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    ).toBe("D\tdocs/plans/peer.md");
  });
});
