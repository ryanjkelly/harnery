import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { coordHelperOpts } from "../../src/commands/agents.ts";

/**
 * Regression: a shell cd'd into a nested directory that carries its own
 * `.harnery/` (e.g. an embedded harnery checkout) made agent-coord walk up
 * from cwd, resolve the NESTED root, and miss the session's heartbeat
 * ("set-task: no heartbeat at .harnery/active/<id>.json"). Every agent-coord
 * spawn now pins the caller-resolved root via coordHelperOpts; this test
 * exercises the real binary both ways.
 */

const AGENT_COORD = resolve(import.meta.dir, "..", "..", "bin", "agent-coord");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeNestedRoots(): { outer: string; nested: string; owner: string } {
  const outer = mkdtempSync(join(tmpdir(), "coord-pin-"));
  dirs.push(outer);
  const owner = "test-owner-1234";
  mkdirSync(join(outer, ".harnery", "active"), { recursive: true });
  writeFileSync(
    join(outer, ".harnery", "active", `${owner}.json`),
    JSON.stringify({
      instance_id: owner,
      session_id: owner,
      last_heartbeat: new Date().toISOString(),
    }),
  );
  const nested = join(outer, "embedded");
  mkdirSync(join(nested, ".harnery"), { recursive: true });
  return { outer, nested, owner };
}

// Strip the suite's own coord env so the child resolves like a fresh shell.
function bareEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (!extra.HARNERY_COORD_ROOT_OVERRIDE) delete env.HARNERY_COORD_ROOT_OVERRIDE;
  return env;
}

describe("agent-coord root pinning (coordHelperOpts)", () => {
  test("coordHelperOpts pins cwd + HARNERY_COORD_ROOT_OVERRIDE to the resolved root", () => {
    const opts = coordHelperOpts("/some/root");
    expect(opts.cwd).toBe("/some/root");
    expect(opts.env.HARNERY_COORD_ROOT_OVERRIDE).toBe("/some/root");
  });

  test("unpinned spawn from a nested coord root misses the heartbeat (the bug)", () => {
    const { nested, owner } = makeNestedRoots();
    const r = spawnSync(AGENT_COORD, ["set-task", owner, "x"], {
      cwd: nested,
      encoding: "utf8",
      env: bareEnv(),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no heartbeat at");
    expect(r.stderr).toContain(nested); // error names the wrongly-resolved root
  });

  test("pinned spawn from the same nested cwd finds the heartbeat (the fix)", () => {
    const { outer, nested, owner } = makeNestedRoots();
    const r = spawnSync(AGENT_COORD, ["set-task", owner, "pinned works"], {
      cwd: nested,
      encoding: "utf8",
      env: bareEnv({ HARNERY_COORD_ROOT_OVERRIDE: outer }),
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).task).toBe("pinned works");
  });
});

describe("resolveEmitRoot (canonical-emit root resolution)", () => {
  // The emitCanonical instance of the same bug: a cwd inside a nested
  // directory carrying its own `.harnery/` (e.g. the embedded harnery
  // checkout) made the old cwd-walk resolve the NESTED root, from which
  // `<root>/harnery/bin/agent-coord` doesn't exist — so `agents status` /
  // `set-task` canonical emits silently vanished and the Stop-hook's
  // rule 1/3 blocked turns that had done the ritual.

  test("override env wins unconditionally", async () => {
    const { resolveEmitRoot } = await import("../../src/core/agents/canonical-emit.ts");
    const prev = process.env.HARNERY_COORD_ROOT_OVERRIDE;
    process.env.HARNERY_COORD_ROOT_OVERRIDE = "/pinned/root";
    try {
      expect(resolveEmitRoot("/anywhere")).toBe("/pinned/root");
    } finally {
      if (prev === undefined) delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
      else process.env.HARNERY_COORD_ROOT_OVERRIDE = prev;
    }
  });

  test("resolves the git superproject root, not a nested .harnery on the cwd walk", async () => {
    const { resolveEmitRoot } = await import("../../src/core/agents/canonical-emit.ts");
    const prev = process.env.HARNERY_COORD_ROOT_OVERRIDE;
    delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
    try {
      // This test runs from inside the harnery checkout, which carries its
      // own .harnery/ — the buggy cwd-walk would resolve the harnery dir.
      // The git-aware path must resolve the SUPERPROJECT root instead
      // (standalone checkout: toplevel == this repo, which is also correct).
      const repo = resolve(import.meta.dir, "..", "..");
      const got = resolveEmitRoot(repo);
      const sup = spawnSync("git", ["rev-parse", "--show-superproject-working-tree"], {
        cwd: repo,
        encoding: "utf8",
      });
      const expected =
        sup.status === 0 && sup.stdout.trim() !== ""
          ? sup.stdout.trim()
          : spawnSync("git", ["rev-parse", "--show-toplevel"], {
              cwd: repo,
              encoding: "utf8",
            }).stdout.trim();
      expect(got).toBe(expected);
    } finally {
      if (prev !== undefined) process.env.HARNERY_COORD_ROOT_OVERRIDE = prev;
    }
  });
});
