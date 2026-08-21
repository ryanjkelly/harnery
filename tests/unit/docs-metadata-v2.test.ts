import { describe, expect, test } from "bun:test";
import {
  DOCS_METADATA_SCHEMA_V2,
  isDocsMetadataV2,
  validateDocsMetadataV2,
} from "../../src/lib/docs-metadata-v2.ts";

const base = {
  schema: DOCS_METADATA_SCHEMA_V2,
  created_at: "2026-08-19T19:47:53Z",
  updated_at: "2026-08-19T19:47:53Z",
};

describe("validateDocsMetadataV2", () => {
  test("accepts a complete plan", () => {
    const result = validateDocsMetadataV2({
      ...base,
      type: "plan",
      status: "in-progress",
      status_changed_at: "2026-08-19T19:47:53Z",
      owner: "ryan-kelly",
      summary: "Replace the lifecycle metadata contract.",
      tags: ["documentation", "metadata"],
      relations: { depends_on: ["docs/plans/prior.md"] },
      access: { roles: ["engineering"], viewers: ["ryan@example.com"] },
    });
    expect(result).toEqual({ valid: true, profile: "lifecycle", issues: [] });
  });

  test("requires canonical UTC timestamps and orders them", () => {
    const result = validateDocsMetadataV2({
      ...base,
      type: "topic",
      summary: "A topic document.",
      created_at: "2026-08-19",
      updated_at: "2026-08-18T19:47:53Z",
    });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_timestamp", field: "created_at" }),
      ]),
    );
  });

  test("rejects impossible calendar timestamps", () => {
    const result = validateDocsMetadataV2({
      ...base,
      type: "topic",
      summary: "A topic document.",
      created_at: "2026-02-30T10:00:00Z",
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "invalid_timestamp", field: "created_at" }),
    );
  });

  test("rejects unknown fields except x_ extensions", () => {
    const result = validateDocsMetadataV2({
      ...base,
      type: "topic",
      summary: "A topic document.",
      mystery: true,
      x_experiment: "allowed",
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "unknown_field", field: "mystery" }),
    );
    expect(result.issues.some((issue) => issue.field === "x_experiment")).toBe(false);
  });

  test("requires issue fields and resolved_at only for resolved issues", () => {
    const result = validateDocsMetadataV2({
      ...base,
      type: "issue",
      status: "resolved",
      status_changed_at: base.updated_at,
      owner: "ryan-kelly",
      summary: "A resolved issue.",
      severity: "urgent",
      affected: "customers",
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_severity", field: "severity" }),
        expect.objectContaining({ code: "invalid_list", field: "affected" }),
        expect.objectContaining({ code: "invalid_timestamp", field: "resolved_at" }),
      ]),
    );
  });

  test("requires resolution metadata for terminal handoffs", () => {
    const result = validateDocsMetadataV2({
      ...base,
      type: "handoff",
      status: "resolved",
      status_changed_at: base.updated_at,
      owner: "ryan-kelly",
      summary: "The work shipped.",
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "missing_resolution", field: "resolution" }),
    );
  });

  test("rejects fields from another lifecycle profile", () => {
    const result = validateDocsMetadataV2({
      ...base,
      type: "plan",
      status: "proposed",
      status_changed_at: base.updated_at,
      owner: "ryan-kelly",
      summary: "A plan with issue-only metadata.",
      severity: "high",
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "unknown_field", field: "severity" }),
    );
  });

  test("validates runbook review timestamps", () => {
    const result = validateDocsMetadataV2({
      ...base,
      type: "runbook",
      reviewed_at: "2026-08-19T19:47:53Z",
      review_due_at: "2026-08-18T19:47:53Z",
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "timestamp_order", field: "review_due_at" }),
    );
  });

  test("validates wiki provenance", () => {
    const result = validateDocsMetadataV2({
      ...base,
      type: "entity",
      summary: "A reference page about cinnamon.",
      title: "Cinnamon",
      category: "supplement",
      aliases: ["cassia"],
      source_count: 1,
      provenance: { sources: ["books/cinnamon/book.md"] },
    });
    expect(result.valid).toBe(true);
    expect(result.profile).toBe("wiki");
  });

  test("keeps upstream timestamps separate on synced pages", () => {
    const result = validateDocsMetadataV2({
      ...base,
      type: "synced-page",
      summary: "A synchronized about page.",
      source: "shopify",
      source_updated_at: "2026-08-19T18:00:00Z",
      handle: "about-us",
      title: "About us",
      published: true,
    });
    expect(result.valid).toBe(true);
    expect(result.profile).toBe("synced");
  });

  test("validates optional shared and synced fields when present", () => {
    const result = validateDocsMetadataV2({
      ...base,
      type: "synced-page",
      source: "shopify",
      source_updated_at: "2026-08-19T18:00:00Z",
      owner: "Ryan Kelly",
      summary: 42,
      title: [],
      handle: false,
      published: "yes",
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(["owner", "summary", "title", "handle", "published"]),
    );
  });
});

describe("isDocsMetadataV2", () => {
  test("checks the schema marker only", () => {
    expect(isDocsMetadataV2(base)).toBe(true);
    expect(isDocsMetadataV2({ schema: "harnery-doc/v1" })).toBe(false);
  });
});
