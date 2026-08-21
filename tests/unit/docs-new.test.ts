import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocsFile } from "../../src/lib/docs-new.ts";
import { parseFrontmatter } from "../../src/lib/docs-frontmatter.ts";
import { validateDocsMetadataV2 } from "../../src/lib/docs-metadata-v2.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "harn-docs-new-"));
  roots.push(value);
  return value;
}

describe("createDocsFile", () => {
  test("creates a valid plan with canonical timestamps", () => {
    const repoRoot = root();
    const now = "2026-08-19T12:00:00Z";
    const file = createDocsFile(repoRoot, {
      type: "plan",
      path: "docs/plans/2026-08-19_example.md",
      summary: "Exercise the document scaffolder.",
      owner: "ryan-kelly",
      now,
    });
    const parsed = parseFrontmatter(readFileSync(file, "utf8"));

    expect(parsed.data).toEqual(
      expect.objectContaining({
        schema: "harnery-doc/v2",
        type: "plan",
        created_at: now,
        updated_at: now,
        status: "proposed",
        status_changed_at: now,
      }),
    );
    expect(validateDocsMetadataV2(parsed.data).valid).toBe(true);
  });

  test("refuses paths outside the repository and non-Markdown files", () => {
    const repoRoot = root();
    const common = {
      type: "topic" as const,
      summary: "Invalid target.",
      owner: "ryan-kelly",
    };

    expect(() => createDocsFile(repoRoot, { ...common, path: "../escape.md" })).toThrow(
      "inside the repository",
    );
    expect(() => createDocsFile(repoRoot, { ...common, path: "docs/topic.txt" })).toThrow(
      "must end in .md",
    );
  });
});
