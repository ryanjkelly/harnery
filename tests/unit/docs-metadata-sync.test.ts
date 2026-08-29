import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../../src/lib/docs-frontmatter.ts";
import {
  initDocsMetadataSyncContext,
  runDocsMetadataSync,
} from "../../src/lib/docs-metadata-sync.ts";

const roots: string[] = [];
const OLD = "2026-08-18T12:00:00Z";
const NOW = "2026-08-19T12:00:00Z";

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repo(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "harn-metadata-sync-"));
  roots.push(root);
  const file = join(root, "plan.md");
  writeFileSync(
    file,
    `---\nschema: harnery-doc/v2\ntype: plan\ncreated_at: ${OLD}\nupdated_at: ${OLD}\nowner: test-owner\nsummary: Test plan.\nstatus: proposed\nstatus_changed_at: ${OLD}\n---\n# Plan\n\nOriginal.\n`,
  );
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["add", "."]);
  git(["commit", "-qm", "fixture"]);
  initDocsMetadataSyncContext({ repoRoot: root, submodules: [] });
  return { root, file };
}

describe("runDocsMetadataSync", () => {
  test("repairs an unstaged worktree edit before git add", async () => {
    const { root, file } = repo();
    writeFileSync(file, readFileSync(file, "utf8").replace("Original.", "Changed."));

    const stagedOnly = await runDocsMetadataSync({ check: true, now: NOW });
    expect(stagedOnly).toEqual([]);

    const applied = await runDocsMetadataSync({ now: NOW });
    expect(applied[0]).toEqual(expect.objectContaining({ status: "updated" }));
    expect(parseFrontmatter(readFileSync(file, "utf8")).data.updated_at).toBe(NOW);

    spawnSync("git", ["add", "plan.md"], { cwd: root });
    const clean = await runDocsMetadataSync({ check: true, now: "2026-08-20T12:00:00Z" });
    expect(clean[0]).toEqual(expect.objectContaining({ status: "unchanged", fields: [] }));
  });

  test("detects and repairs semantic timestamp drift", async () => {
    const { root, file } = repo();
    writeFileSync(file, readFileSync(file, "utf8").replace("Original.", "Changed."));
    spawnSync("git", ["add", "plan.md"], { cwd: root });

    const check = await runDocsMetadataSync({ check: true, now: NOW });
    expect(check[0]).toEqual(expect.objectContaining({ status: "drift", fields: ["updated_at"] }));

    const applied = await runDocsMetadataSync({ now: NOW });
    expect(applied[0]).toEqual(expect.objectContaining({ status: "updated" }));
    expect(parseFrontmatter(readFileSync(file, "utf8")).data.updated_at).toBe(NOW);
    spawnSync("git", ["add", "plan.md"], { cwd: root });
    const clean = await runDocsMetadataSync({ check: true, now: "2026-08-20T12:00:00Z" });
    expect(clean[0]).toEqual(expect.objectContaining({ status: "unchanged", fields: [] }));
  });

  test("moves status_changed_at only when status changes", async () => {
    const { root, file } = repo();
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("status: proposed", "status: in-progress"),
    );
    spawnSync("git", ["add", "plan.md"], { cwd: root });

    await runDocsMetadataSync({ now: NOW });
    const data = parseFrontmatter(readFileSync(file, "utf8")).data;
    expect(data.updated_at).toBe(NOW);
    expect(data.status_changed_at).toBe(NOW);
    expect(data.created_at).toBe(OLD);
  });

  test("does not bump timestamps for frontmatter formatting only", async () => {
    const { root, file } = repo();
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("owner: test-owner", 'owner: "test-owner"'),
    );
    spawnSync("git", ["add", "plan.md"], { cwd: root });

    const rows = await runDocsMetadataSync({ now: NOW });
    expect(rows[0]).toEqual(expect.objectContaining({ status: "unchanged", fields: [] }));
    expect(parseFrontmatter(readFileSync(file, "utf8")).data.updated_at).toBe(OLD);
  });

  test("cached check reads staged bytes instead of a later worktree edit", async () => {
    const { root, file } = repo();
    const staged = readFileSync(file, "utf8")
      .replace(`updated_at: ${OLD}`, `updated_at: ${NOW}`)
      .replace("Original.", "Staged change.");
    writeFileSync(file, staged);
    spawnSync("git", ["add", "plan.md"], { cwd: root });
    writeFileSync(file, "# Broken worktree copy\n");

    const cached = await runDocsMetadataSync({
      check: true,
      cached: true,
      now: "2026-08-20T12:00:00Z",
    });
    expect(cached[0]).toEqual(expect.objectContaining({ status: "unchanged", fields: [] }));

    const worktree = await runDocsMetadataSync({ check: true, now: "2026-08-20T12:00:00Z" });
    expect(worktree).toEqual([]);
  });

  test("cached mode refuses writes", async () => {
    repo();
    await expect(runDocsMetadataSync({ cached: true })).rejects.toThrow(
      "--cached requires --check",
    );
  });
});
