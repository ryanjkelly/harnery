import { describe, expect, test } from "bun:test";
import { isExcludedDocsMetadataPath, isManagedDocsMetadataFile } from "./docs-metadata-managed.ts";

describe("isExcludedDocsMetadataPath", () => {
  test("excludes template skeletons under any documentation root", () => {
    expect(isExcludedDocsMetadataPath("docs/templates/plan.md")).toBe(true);
    expect(isExcludedDocsMetadataPath("meta-docs/templates/issue.md")).toBe(true);
    expect(isExcludedDocsMetadataPath("sub/docs/templates/handoff.md")).toBe(true);
    expect(isExcludedDocsMetadataPath("docs\\templates\\plan.md")).toBe(true);
  });

  test("keeps real lifecycle documents managed", () => {
    expect(isExcludedDocsMetadataPath("docs/plans/2026-09-05_thing.md")).toBe(false);
    expect(isExcludedDocsMetadataPath("meta-docs/plans/thing.md")).toBe(false);
    expect(isExcludedDocsMetadataPath("docs/issues/templates-for-email.md")).toBe(false);
  });

  test("a template with placeholder v2 frontmatter is not a managed file", () => {
    const data = { schema: "harnery-doc/v2", type: "plan", status: "proposed" };
    expect(isManagedDocsMetadataFile("meta-docs/templates/plan.md", data, true)).toBe(false);
    expect(isManagedDocsMetadataFile("meta-docs/plans/plan.md", data, true)).toBe(true);
  });
});
