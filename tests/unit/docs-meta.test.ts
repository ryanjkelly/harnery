import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDocsMetadata, readDocsMetadataKey } from "../../src/lib/docs-meta.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(name: string, content: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "harn-docs-meta-"));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, content);
  return { root, path };
}

describe("readDocsMetadata", () => {
  test("reads scalars and lists from a repo-relative path", () => {
    const { root } = fixture(
      "plan.md",
      "---\nstatus: in-progress\ndate: 2026-07-13\ntags: [docs, tooling]\n---\n# Plan\n",
    );

    const result = readDocsMetadata(root, "plan.md");

    expect(result.data).toEqual({
      status: "in-progress",
      date: "2026-07-13",
      tags: ["docs", "tooling"],
    });
  });

  test("accepts an absolute path", () => {
    const { root, path } = fixture("issue.md", "---\nstatus: open\n---\n# Issue\n");
    expect(readDocsMetadata(root, path).data.status).toBe("open");
  });

  test("fails when frontmatter is missing", () => {
    const { root } = fixture("plain.md", "# Plain markdown\n");
    expect(() => readDocsMetadata(root, "plain.md")).toThrow("no leading YAML frontmatter");
  });

  test("fails when frontmatter is malformed", () => {
    const { root } = fixture("bad.md", "---\nstatus: : bad\n---\n# Bad\n");
    expect(() => readDocsMetadata(root, "bad.md")).toThrow("empty or malformed");
  });
});

describe("readDocsMetadataKey", () => {
  test("returns a present top-level key", () => {
    expect(readDocsMetadataKey({ status: "shipped" }, "status", "plan.md")).toBe("shipped");
  });

  test("distinguishes a missing key from a falsey value", () => {
    expect(readDocsMetadataKey({ enabled: false }, "enabled", "plan.md")).toBe(false);
    expect(() => readDocsMetadataKey({}, "status", "plan.md")).toThrow("key 'status' not found");
  });
});
