import { describe, expect, test } from "bun:test";
import { auditDocsMetadataText } from "../../src/lib/docs-metadata-audit.ts";

describe("auditDocsMetadataText", () => {
  test("reports legacy lifecycle metadata as an error", () => {
    const row = auditDocsMetadataText(
      "---\nstatus: proposed\ndate: 2026-08-19\nlast_updated: 2026-08-19\n---\n",
      "docs/plans/legacy.md",
    );
    expect(row).toEqual(
      expect.objectContaining({
        state: "legacy",
        profile: "lifecycle",
        issues: [expect.objectContaining({ severity: "error", code: "legacy_schema" })],
      }),
    );
  });

  test("reports legacy lifecycle metadata inside a tracked repository", () => {
    const row = auditDocsMetadataText(
      "---\nstatus: open\ndate: 2026-08-19\n---\n",
      "acme-functions/docs/issues/legacy.md",
    );
    expect(row).toEqual(expect.objectContaining({ state: "legacy", profile: "lifecycle" }));
  });

  test("reports legacy Harnery development lifecycle metadata", () => {
    const row = auditDocsMetadataText(
      "---\nstatus: proposed\ndate: 2026-08-19\n---\n",
      "harnery-dev/plans/legacy.md",
    );
    expect(row).toEqual(expect.objectContaining({ state: "legacy", profile: "lifecycle" }));
  });

  test("validates any explicitly marked v2 document", () => {
    const row = auditDocsMetadataText(
      [
        "---",
        "schema: harnery-doc/v2",
        "type: topic",
        'created_at: "2026-08-19T19:47:53Z"',
        'updated_at: "2026-08-19T19:47:53Z"',
        "summary: A useful reference.",
        "---",
      ].join("\n"),
      "notes/reference.md",
    );
    expect(row).toEqual(expect.objectContaining({ state: "valid", profile: "general" }));
  });

  test("ignores unmarked ordinary markdown outside required paths", () => {
    expect(auditDocsMetadataText("# Readme\n", "README.md")).toBeNull();
  });

  test("ignores placeholder frontmatter in document templates", () => {
    expect(
      auditDocsMetadataText(
        "---\nschema: harnery-doc/v2\ntype: plan\ncreated_at: <timestamp>\n---\n",
        "docs/templates/plan.md",
      ),
    ).toBeNull();
  });
});
