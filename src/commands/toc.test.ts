import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSection } from "./toc.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function guide(text: string): string {
  dir = mkdtempSync(join(tmpdir(), "harn-section-"));
  const file = join(dir, "guide.md");
  writeFileSync(file, text);
  return file;
}

describe("section header matching", () => {
  const file = () =>
    guide(
      "# Guide\n\n## Media\n\nmedia body\n\n## Media recipes\n\nrecipe body\n\n## Local sound effects\n\nlocal\n",
    );

  test("an exact header wins over headers that only contain the query", async () => {
    const result = await runSection(file(), "media", {});
    expect(result.matched_header).toBe("Media");
    expect(result.content).toContain("media body");
    expect(result.content).not.toContain("recipe body");
  });

  test("a substring still selects a single matching header", async () => {
    expect((await runSection(file(), "recipes", {})).matched_header).toBe("Media recipes");
  });

  test("a substring shared by several headers with no exact match is still refused", async () => {
    await expect(runSection(file(), "Med", {})).rejects.toThrow(/multiple headers match/);
  });

  test("case-sensitive matching does not treat a different case as exact", async () => {
    await expect(runSection(file(), "media", { caseSensitive: true })).rejects.toThrow(
      /no header matching/,
    );
  });
});
