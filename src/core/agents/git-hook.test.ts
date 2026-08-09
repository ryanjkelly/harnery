import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectCheckoutRemoved,
  collectCommitted,
  collectStaged,
  discoverCoordRoot,
  parseNameStatus,
  submodulePrefix,
} from "./git-hook.ts";

let repo: string;

function sh(args: string[], cwd: string): string {
  const r = spawnSync(args[0]!, args.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
  return r.stdout ?? "";
}

beforeEach(() => {
  repo = join(
    tmpdir(),
    `git-hook-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(repo, { recursive: true });
  sh(["git", "init", "--quiet", "-b", "main"], repo);
  sh(["git", "config", "user.email", "test@example.invalid"], repo);
  sh(["git", "config", "user.name", "Test"], repo);
  sh(["git", "config", "core.hooksPath", "/dev/null"], repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("parseNameStatus", () => {
  test("plain statuses emit one path, renames emit both sides", () => {
    const out = "M\tsrc/a.ts\nA\tsrc/b.ts\nR100\told/name.ts\tnew/name.ts\nD\tgone.ts\n";
    expect(parseNameStatus(out)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "old/name.ts",
      "new/name.ts",
      "gone.ts",
    ]);
  });

  test("empty and whitespace-only input yields nothing", () => {
    expect(parseNameStatus("")).toEqual([]);
    expect(parseNameStatus("\n\n")).toEqual([]);
  });
});

describe("discoverCoordRoot / submodulePrefix", () => {
  test("plain repo: root is the toplevel, prefix empty", () => {
    expect(discoverCoordRoot(repo)).toBe(sh(["git", "rev-parse", "--show-toplevel"], repo).trim());
    expect(submodulePrefix(repo)).toBe("");
  });

  test("non-repo directory resolves to null", () => {
    const dir = join(tmpdir(), `not-a-repo-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      expect(discoverCoordRoot(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectStaged", () => {
  test("staged file lands canonical; nothing staged yields empty", () => {
    expect(collectStaged(repo).staged).toEqual([]);
    writeFileSync(join(repo, "x.ts"), "export {}\n");
    sh(["git", "add", "x.ts"], repo);
    const { staged, gitlinks } = collectStaged(repo);
    expect(staged).toEqual(["x.ts"]);
    expect(gitlinks).toEqual([]);
  });

  test("a staged rename emits both sides", () => {
    writeFileSync(join(repo, "old.ts"), "export const v = 1;\n");
    sh(["git", "add", "-A"], repo);
    sh(["git", "commit", "--quiet", "--no-verify", "-m", "seed"], repo);
    sh(["git", "mv", "old.ts", "new.ts"], repo);
    const { staged } = collectStaged(repo);
    expect(staged.sort()).toEqual(["new.ts", "old.ts"]);
  });
});

describe("collectCommitted", () => {
  test("committed clean path is pruneable; dirty residue keeps its claim", () => {
    writeFileSync(join(repo, "a.ts"), "export {}\n");
    writeFileSync(join(repo, "b.ts"), "export {}\n");
    sh(["git", "add", "-A"], repo);
    sh(["git", "commit", "--quiet", "--no-verify", "-m", "both"], repo);
    // dirty residue on b.ts after the commit
    writeFileSync(join(repo, "b.ts"), "export const later = true;\n");
    const committed = collectCommitted(repo);
    expect(committed).toContain("a.ts");
    expect(committed).not.toContain("b.ts");
  });
});

describe("collectCheckoutRemoved", () => {
  test("paths rewritten by a ref move are released; unchanged ones are not", () => {
    writeFileSync(join(repo, "stays.ts"), "export {}\n");
    writeFileSync(join(repo, "moves.ts"), "export const v = 1;\n");
    sh(["git", "add", "-A"], repo);
    sh(["git", "commit", "--quiet", "--no-verify", "-m", "one"], repo);
    const oldRef = sh(["git", "rev-parse", "HEAD"], repo).trim();
    writeFileSync(join(repo, "moves.ts"), "export const v = 2;\n");
    sh(["git", "add", "-A"], repo);
    sh(["git", "commit", "--quiet", "--no-verify", "-m", "two"], repo);
    const newRef = sh(["git", "rev-parse", "HEAD"], repo).trim();

    const removed = collectCheckoutRemoved(repo, oldRef, newRef);
    expect(removed).toEqual(["moves.ts"]);
  });
});
