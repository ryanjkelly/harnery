import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import {
  type CodeIdentityRecord,
  clearReplacementRequest,
  codeChangeMessage,
  codeIdentityReplacementNeeded,
  createCodeIdentityReader,
  currentCodeIdentity,
  readCodeIdentity,
  replacementRequestedFor,
  shortCodeIdentity,
  watchCodeIdentity,
  writeReplacementRequest,
} from "./code-identity.ts";

const roots: string[] = [];
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

function packageRoot(version = "1.2.3"): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-code-identity-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version }));
  return root;
}

function write(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

/** Git replaces refs through a lock file and a rename; do the same. */
function replace(path: string, body: string): void {
  writeFileSync(`${path}.lock`, body);
  renameSync(`${path}.lock`, path);
}

describe("readCodeIdentity", () => {
  test("is the package version alone outside a Git checkout", () => {
    expect(readCodeIdentity(packageRoot("0.9.1"))).toBe("0.9.1");
  });

  test("is null without a readable package version", () => {
    const root = packageRoot();
    writeFileSync(join(root, "package.json"), "{ not json");
    expect(readCodeIdentity(root)).toBeNull();
    rmSync(join(root, "package.json"));
    expect(readCodeIdentity(root)).toBeNull();
  });

  test("adds the HEAD commit through a loose branch ref", () => {
    const root = packageRoot();
    write(join(root, ".git", "HEAD"), "ref: refs/heads/next\n");
    write(join(root, ".git", "refs", "heads", "next"), `${A}\n`);
    expect(readCodeIdentity(root)).toBe(`1.2.3@${A}`);
  });

  test("falls back to packed-refs when the branch has no loose ref", () => {
    const root = packageRoot();
    write(join(root, ".git", "HEAD"), "ref: refs/heads/next\n");
    write(
      join(root, ".git", "packed-refs"),
      `# pack-refs with: peeled fully-peeled sorted\n${B} refs/heads/main\n${C} refs/heads/next\n^${A}\n`,
    );
    expect(readCodeIdentity(root)).toBe(`1.2.3@${C}`);
  });

  test("reads a detached HEAD directly", () => {
    const root = packageRoot();
    write(join(root, ".git", "HEAD"), `${B}\n`);
    expect(readCodeIdentity(root)).toBe(`1.2.3@${B}`);
  });

  test("follows a submodule .git file to its gitdir", () => {
    const parent = mkdtempSync(join(tmpdir(), "harnery-code-identity-parent-"));
    roots.push(parent);
    const root = join(parent, "pkg");
    write(join(root, "package.json"), JSON.stringify({ version: "2.0.0" }));
    write(join(root, ".git"), "gitdir: ../.git/modules/pkg\n");
    write(join(parent, ".git", "modules", "pkg", "HEAD"), `${A}\n`);
    expect(readCodeIdentity(root)).toBe(`2.0.0@${A}`);
  });

  test("reads refs from a linked worktree's common directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "harnery-code-identity-worktree-"));
    roots.push(parent);
    const root = join(parent, "wt");
    write(join(root, "package.json"), JSON.stringify({ version: "3.0.0" }));
    const worktreeGit = join(parent, "main", ".git", "worktrees", "wt");
    write(join(root, ".git"), `gitdir: ${worktreeGit}\n`);
    write(join(worktreeGit, "HEAD"), "ref: refs/heads/topic\n");
    write(join(worktreeGit, "commondir"), "../..\n");
    write(join(parent, "main", ".git", "refs", "heads", "topic"), `${C}\n`);
    expect(readCodeIdentity(root)).toBe(`3.0.0@${C}`);
  });

  test("is null for a checkout whose HEAD cannot be resolved", () => {
    const root = packageRoot();
    write(join(root, ".git", "HEAD"), "ref: refs/heads/missing\n");
    expect(readCodeIdentity(root)).toBeNull();
    write(join(root, ".git", "HEAD"), "ref: refs/../../escape\n");
    expect(readCodeIdentity(root)).toBeNull();
  });

  test("identifies the running package", () => {
    const current = currentCodeIdentity();
    expect(typeof current.root).toBe("string");
    expect(current.id === null || /^[0-9A-Za-z._+-]+(@[0-9a-f]{40,64})?$/.test(current.id)).toBe(
      true,
    );
  });
});

describe("createCodeIdentityReader", () => {
  test("recomputes only after a consulted file changes", () => {
    const root = packageRoot();
    const file = join(root, "marker");
    writeFileSync(file, "one");
    let computes = 0;
    const read = createCodeIdentityReader(root, {
      compute: () => {
        computes += 1;
        return { id: `id-${Bun.file(file).size}`, paths: [file] };
      },
    });
    expect(read()).toBe("id-3");
    const afterMiss = computes;
    expect(read()).toBe("id-3");
    expect(read()).toBe("id-3");
    expect(computes).toBe(afterMiss);
    writeFileSync(file, "three");
    expect(read()).toBe("id-5");
    expect(computes).toBeGreaterThan(afterMiss);
  });

  test("notices a moved branch ref and a newly packed ref", () => {
    const root = packageRoot();
    write(join(root, ".git", "HEAD"), "ref: refs/heads/next\n");
    write(join(root, ".git", "refs", "heads", "next"), `${A}\n`);
    const read = createCodeIdentityReader(root);
    expect(read()).toBe(`1.2.3@${A}`);
    replace(join(root, ".git", "refs", "heads", "next"), `${B}\n`);
    expect(read()).toBe(`1.2.3@${B}`);
    rmSync(join(root, ".git", "refs", "heads", "next"));
    write(join(root, ".git", "packed-refs"), `${C} refs/heads/next\n`);
    expect(read()).toBe(`1.2.3@${C}`);
  });
});

describe("codeIdentityReplacementNeeded", () => {
  const current: CodeIdentityRecord = { id: `1.0.0@${B}`, root: "/pkg" };

  test("replaces a different identity from the same installation", () => {
    expect(codeIdentityReplacementNeeded({ id: `1.0.0@${A}`, root: "/pkg" }, current)).toBe(true);
  });

  test("never replaces a live daemon that predates identity recording", () => {
    expect(codeIdentityReplacementNeeded(undefined, current)).toBe(false);
  });

  test("never replaces on an unknown identity or another installation", () => {
    expect(
      codeIdentityReplacementNeeded({ id: `1.0.0@${A}`, root: "/pkg" }, { ...current, id: null }),
    ).toBe(false);
    expect(codeIdentityReplacementNeeded(undefined, { ...current, id: null })).toBe(false);
    expect(codeIdentityReplacementNeeded({ id: null, root: "/pkg" }, current)).toBe(false);
    expect(codeIdentityReplacementNeeded({ id: `1.0.0@${A}`, root: "/other" }, current)).toBe(
      false,
    );
    expect(codeIdentityReplacementNeeded(null, current)).toBe(false);
    expect(codeIdentityReplacementNeeded("garbage", current)).toBe(false);
    expect(codeIdentityReplacementNeeded(current, current)).toBe(false);
  });
});

describe("watchCodeIdentity", () => {
  function sequence(ids: Array<string | null>) {
    let index = 0;
    let reads = 0;
    return {
      read: (): CodeIdentityRecord => {
        reads += 1;
        const id = ids[Math.min(index, ids.length - 1)] ?? null;
        index += 1;
        return { id, root: "/pkg" };
      },
      reads: () => reads,
    };
  }

  test("reads at most once per interval", () => {
    const source = sequence(["v1", "v1", "v2", "v2"]);
    let nowMs = 0;
    const watch = watchCodeIdentity({ read: source.read, intervalMs: 30_000, now: () => nowMs });
    expect(watch.initial.id).toBe("v1");
    nowMs = 10_000;
    expect(watch.poll()).toBeNull();
    expect(source.reads()).toBe(1);
    nowMs = 30_000;
    expect(watch.poll()).toBeNull();
    expect(source.reads()).toBe(2);
  });

  test("confirms a change on two consecutive reads and stays confirmed", () => {
    const source = sequence(["v1", "v2", "v2", "v1"]);
    const watch = watchCodeIdentity({ read: source.read, intervalMs: 0 });
    expect(watch.poll()).toBeNull();
    expect(watch.poll()).toEqual({ from: "v1", to: "v2" });
    expect(watch.poll()).toEqual({ from: "v1", to: "v2" });
    expect(codeChangeMessage({ from: "v1", to: "v2" })).toBe(
      "code changed (v1 -> v2); exiting for restart",
    );
  });

  test("a flapping or unreadable identity never confirms", () => {
    const flapping = watchCodeIdentity({
      read: sequence(["v1", "v2", "v1", "v3", null, "v3", null]).read,
      intervalMs: 0,
    });
    for (let i = 0; i < 6; i += 1) expect(flapping.poll()).toBeNull();

    const unknownStart = watchCodeIdentity({
      read: sequence([null, "v2", "v2", "v2"]).read,
      intervalMs: 0,
    });
    for (let i = 0; i < 3; i += 1) expect(unknownStart.poll()).toBeNull();
    expect(unknownStart.checkNow()).toBeNull();
  });

  test("checkNow reports an unconfirmed difference immediately", () => {
    const watch = watchCodeIdentity({ read: sequence(["v1", "v1", "v2"]).read, intervalMs: 0 });
    expect(watch.checkNow()).toBeNull();
    expect(watch.checkNow()).toEqual({ from: "v1", to: "v2" });
  });
});

describe("shortCodeIdentity", () => {
  test("shortens the commit and keeps a bare version", () => {
    expect(shortCodeIdentity(`1.2.3@${A}`)).toBe("1.2.3@aaaaaaaaaaaa");
    expect(shortCodeIdentity("1.2.3")).toBe("1.2.3");
    expect(shortCodeIdentity(null)).toBe("unknown");
  });
});

describe("replacement requests", () => {
  test("address one daemon generation and are cleared on demand", () => {
    const path = join(packageRoot(), "replace.json");
    writeReplacementRequest(path, "gen-a");
    expect(replacementRequestedFor(path, "gen-a")).toBe(true);
    expect(replacementRequestedFor(path, "gen-b")).toBe(false);
    clearReplacementRequest(path, "gen-a");
    expect(existsSync(path)).toBe(true);
    clearReplacementRequest(path);
    expect(existsSync(path)).toBe(false);
  });
});
