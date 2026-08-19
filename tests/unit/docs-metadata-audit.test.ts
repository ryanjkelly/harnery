import { describe, expect, test } from "bun:test";
import { auditDocsMetadataText } from "../../src/lib/docs-metadata-audit.ts";

describe("auditDocsMetadataText", () => {
  test("reports legacy lifecycle metadata as a transition warning", () => {
    const row = auditDocsMetadataText(
      "---\nstatus: proposed\ndate: 2026-08-19\nlast_updated: 2026-08-19\n---\n",
      "docs/plans/legacy.md",
    );
    expect(row).toEqual(
      expect.objectContaining({
        state: "legacy",
        profile: "lifecycle",
        issues: [expect.objectContaining({ severity: "warning", code: "legacy_schema" })],
      }),
    );
  });

  test("can turn legacy metadata into a cutover error", () => {
    const row = auditDocsMetadataText("---\nstatus: proposed\n---\n", "docs/plans/legacy.md", true);
    expect(row?.issues[0]?.severity).toBe("error");
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
});
