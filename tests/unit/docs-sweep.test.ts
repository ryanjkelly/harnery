import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDocsContext, parseDocsAgeLog, runSweep } from "../../src/lib/docs-sweep.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeOldPlanRepo(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "harn-docs-sweep-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# fixture\n");
  writeFileSync(join(root, "docs", "plans", "old-plan.md"), content);

  const git = (args: string[], env?: NodeJS.ProcessEnv) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["add", "."]);
  git(["commit", "-qm", "fixture"], {
    GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
  });
  return root;
}

describe("parseDocsAgeLog", () => {
  // Fixed "now" so ages are deterministic: 2026-07-08T12:00:00Z
  const now = Date.parse("2026-07-08T12:00:00Z");

  test("newest commit wins; skips non-md; ignores blank lines", () => {
    const log = [
      "COMMIT 2026-07-01T12:00:00Z",
      "docs/plans/fresh.md",
      "docs/plans/shared.md",
      "",
      "COMMIT 2026-01-01T12:00:00Z",
      "docs/plans/shared.md", // older — must not overwrite
      "docs/plans/old.md",
      "docs/plans/diagram.png", // non-md — skip
      "COMMIT not-a-date",
      "docs/plans/bogus.md", // currentAge null — skip
    ].join("\n");

    const ages = parseDocsAgeLog(log, now);
    expect(ages.get("docs/plans/fresh.md")).toBe(7);
    expect(ages.get("docs/plans/shared.md")).toBe(7); // newest wins
    expect(ages.get("docs/plans/old.md")).toBe(188);
    expect(ages.has("docs/plans/diagram.png")).toBe(false);
    expect(ages.has("docs/plans/bogus.md")).toBe(false);
  });

  test("empty / whitespace-only input → empty map", () => {
    expect(parseDocsAgeLog("", now).size).toBe(0);
    expect(parseDocsAgeLog("   \n\n", now).size).toBe(0);
  });
});

describe("runSweep status dual-read", () => {
  test("recognizes an in-progress plan from YAML frontmatter", async () => {
    const root = makeOldPlanRepo("---\nstatus: in_progress\n---\n# Old plan\n");
    initDocsContext({ repoRoot: root, submodules: [] });

    const items = await runSweep({ repo: "." });

    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "stalled-plan",
        path: "docs/plans/old-plan.md",
      }),
    );
  });
});
