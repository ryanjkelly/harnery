import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPortability } from "../../scripts/check-portability.ts";

// harnery is published to npm and cloned by arbitrary hosts. Host-specific
// tokens (a consumer's bin name, business, submodule paths, data-warehouse
// tables, skills) must never land in committable source. This test is the CI
// backstop for the "Portability is the prime constraint" rule; the same scan
// runs standalone via `bun run scripts/check-portability.ts` and (host-side) in
// the embedding monorepo's pre-commit hook.
describe("portability", () => {
  test("no host-specific tokens in committable source", () => {
    const root = join(import.meta.dir, "..", "..");
    const violations = scanPortability(root);
    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file}:${v.line} [${v.label}] ${v.text}`).join("\n");
      throw new Error(`Found ${violations.length} host-specific token(s):\n${report}`);
    }
    expect(violations).toEqual([]);
  });

  test("index mode ignores peer worktree files but blocks the staged snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-portability-index-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "tracked.md"), "source-neutral\n");
      git("add", "docs/tracked.md");
      git("commit", "-qm", "base");

      writeFileSync(join(root, "docs", "peer-draft.md"), "merchant BARTN\n");
      expect(scanPortability(root, "worktree")).toHaveLength(1);
      expect(scanPortability(root, "index")).toEqual([]);

      git("add", "docs/peer-draft.md");
      expect(scanPortability(root, "index")).toEqual([
        expect.objectContaining({ file: "docs/peer-draft.md", line: 1 }),
      ]);

      git("reset", "-q", "HEAD", "docs/peer-draft.md");
      writeFileSync(join(root, "docs", "tracked.md"), "merchant BARTN\n");
      expect(scanPortability(root, "worktree")).toHaveLength(2);
      expect(scanPortability(root, "index")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
