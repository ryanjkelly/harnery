import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractStatus } from "../../src/lib/docs-index.ts";
import { hasStatusHeader } from "../../src/lib/docs-lint.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function writeDoc(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "harn-doc-status-"));
  roots.push(root);
  const path = join(root, "doc.md");
  writeFileSync(path, content);
  return path;
}

describe("docs status consumers", () => {
  test("lint accepts YAML status during the transition", () => {
    expect(hasStatusHeader(writeDoc("---\nstatus: proposed\n---\n# Plan\n"))).toBe(true);
  });

  test("lint still accepts a legacy bold status", () => {
    expect(hasStatusHeader(writeDoc("# Plan\n\n**Status:** proposed\n"))).toBe(true);
  });

  test("issue index prefers and normalizes YAML status", () => {
    const content = "---\nstatus: done\n---\n# Issue\n\n**Status:** open\n";
    expect(extractStatus(content)).toBe("resolved");
  });
});
