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

  test("reports a legacy audit document", () => {
    const row = auditDocsMetadataText(
      "---\nstatus: complete\ndate: 2026-08-19\nlast_updated: 2026-08-19\n---\n",
      "docs/audits/legacy.md",
    );
    expect(row).toEqual(expect.objectContaining({ state: "legacy", profile: "general" }));
  });

  test("reports an audit document with no metadata at all", () => {
    const row = auditDocsMetadataText("# Audit\n", "acme-service/docs/audits/bare.md");
    expect(row).toEqual(expect.objectContaining({ state: "missing", profile: "general" }));
  });

  test("reports legacy metadata in coordination issues", () => {
    const row = auditDocsMetadataText(
      "---\nstatus: resolved\ndate: 2026-08-19\n---\n",
      "docs/coordination/issues/legacy.md",
    );
    expect(row).toEqual(expect.objectContaining({ state: "legacy", profile: "lifecycle" }));
  });

  test("finds documents in a repository nested more than one level deep", () => {
    const row = auditDocsMetadataText(
      "---\nstatus: open\ndate: 2026-08-19\n---\n",
      "acme-company/acme-service/docs/issues/legacy.md",
    );
    expect(row).toEqual(expect.objectContaining({ state: "legacy", profile: "lifecycle" }));
  });

  test("reports a marked v2 document whose type is misspelled", () => {
    // A type the enum does not know used to drop the file out of the audit
    // entirely, so an invalid header reported as nothing rather than as an error.
    const row = auditDocsMetadataText(
      [
        "---",
        "schema: harnery-doc/v2",
        "type: audits",
        'created_at: "2026-08-19T19:47:53Z"',
        'updated_at: "2026-08-19T19:47:53Z"',
        "summary: A useful reference.",
        "---",
      ].join("\n"),
      "notes/reference.md",
    );
    expect(row).toEqual(
      expect.objectContaining({
        state: "invalid",
        issues: expect.arrayContaining([
          expect.objectContaining({ severity: "error", code: "invalid_type" }),
        ]),
      }),
    );
  });

  test("reports a marked v2 document with no type at all", () => {
    const row = auditDocsMetadataText(
      ["---", "schema: harnery-doc/v2", "summary: A useful reference.", "---"].join("\n"),
      "notes/reference.md",
    );
    expect(row).toEqual(expect.objectContaining({ state: "invalid" }));
  });

  test("ignores generated dashboard copies of other repositories' documents", () => {
    expect(
      auditDocsMetadataText(
        "---\nstatus: open\ndate: 2026-08-19\n---\n",
        "acme-site/web/content/dashboards/acme/docs/issues/legacy.md",
      ),
    ).toBeNull();
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
