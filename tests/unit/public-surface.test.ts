import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanPublicHistory,
  scanPublicIndex,
  scanPublicSurface,
  scanPublicText,
} from "../../scripts/check-public-surface.ts";

describe("public-surface provenance guard", () => {
  test(
    "the committable Harnery tree carries no restricted provenance",
    () => {
      expect(scanPublicSurface(join(import.meta.dir, "..", ".."))).toEqual([]);
    },
    { timeout: 15_000 },
  );

  test("opaque fingerprints block a restricted identifier without publishing its inventory", () => {
    expect(scanPublicText("private fixture sentinel", "fixture.md")).toEqual([
      { scope: "fixture.md", line: 1, kind: "restricted_identifier" },
    ]);
  });

  test("source-attribution language is blocked in public artifacts and commit messages", () => {
    expect(scanPublicText("This was adapted from an internal prototype.", "message")).toEqual([
      { scope: "message", line: 1, kind: "provenance_language" },
    ]);
  });

  test("a restricted path is blocked without echoing its identifier", () => {
    const violations = scanPublicText(
      "private fixture sentinel/file.md",
      "path private fixture sentinel/file.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("restricted_identifier");
    expect(violations[0]?.scope).toMatch(/^restricted-scope-[0-9a-f]{12}$/);
  });

  test("a reasoned waiver only applies to generic language, never restricted identifiers", () => {
    expect(
      scanPublicText(
        "This parser was adapted from the standard grammar. public-surface-allow: public standard",
        "parser.ts",
      ),
    ).toEqual([]);
    expect(
      scanPublicText("private fixture sentinel public-surface-allow: test", "fixture.md"),
    ).toEqual([{ scope: "fixture.md", line: 1, kind: "restricted_identifier" }]);
  });

  test("supported adapter names and source-neutral rationale remain valid", () => {
    expect(
      scanPublicText(
        "Claude Code, Codex, and Cursor expose different verified lifecycle capabilities.",
        "adr.mdx",
      ),
    ).toEqual([]);
  });

  test("scans the OpenClaw plugin public package", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-public-openclaw-plugin-"));
    try {
      const sourceRoot = join(root, "openclaw-plugin", "src");
      mkdirSync(sourceRoot, { recursive: true });
      writeFileSync(join(sourceRoot, "adapter.ts"), "source-neutral adapter\n");
      expect(scanPublicSurface(root)).toEqual([]);

      writeFileSync(
        join(sourceRoot, "adapter.ts"),
        "This adapter was copied from an internal prototype.\n",
      );
      expect(scanPublicSurface(root)).toEqual([
        {
          scope: "openclaw-plugin/src/adapter.ts",
          line: 1,
          kind: "provenance_language",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("index mode ignores peer worktree files but blocks the staged snapshot", () => {
    const repo = mkdtempSync(join(tmpdir(), "harnery-public-index-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      mkdirSync(join(repo, "docs"));
      writeFileSync(join(repo, "docs", "tracked.md"), "source-neutral\n");
      git("add", "docs/tracked.md");
      git("commit", "-qm", "base");

      writeFileSync(
        join(repo, "docs", "peer-draft.md"),
        "This was adapted from an internal prototype.\n",
      );
      expect(scanPublicSurface(repo)).toHaveLength(1);
      expect(scanPublicIndex(repo)).toEqual([]);

      git("add", "docs/peer-draft.md");
      expect(scanPublicIndex(repo)).toEqual([
        { scope: "docs/peer-draft.md", line: 1, kind: "provenance_language" },
      ]);

      git("reset", "-q", "HEAD", "docs/peer-draft.md");
      writeFileSync(
        join(repo, "docs", "tracked.md"),
        "This was adapted from an internal prototype.\n",
      );
      expect(scanPublicSurface(repo)).toHaveLength(2);
      expect(scanPublicIndex(repo)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("outgoing history catches a restricted reference removed by a later commit", () => {
    const repo = mkdtempSync(join(tmpdir(), "harnery-public-history-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      writeFileSync(join(repo, "README.md"), "source-neutral\n");
      git("add", "README.md");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");

      writeFileSync(join(repo, "README.md"), "private fixture sentinel\n");
      git("commit", "-qam", "temporary detail");
      writeFileSync(join(repo, "README.md"), "source-neutral again\n");
      git("commit", "-qam", "clean final tree");

      expect(scanPublicHistory(repo, `${base}..HEAD`)).toEqual([
        {
          scope: expect.stringMatching(/^commit [0-9a-f]{8} README\.md$/),
          line: 1,
          kind: "restricted_identifier",
        },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
