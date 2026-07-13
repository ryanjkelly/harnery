import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateClaim } from "./claim-conflict.ts";

let root: string;
let activeDir: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `agent-coord-claim-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  activeDir = join(root, ".harnery", "active");
  mkdirSync(activeDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

function seedPeer(
  id: string,
  opts: {
    name?: string;
    session?: string;
    parent?: string;
    files?: string[];
    fresh?: boolean;
  },
): void {
  const now = new Date();
  const stale = new Date(now.getTime() - 30 * 60_000);
  const ts = ((opts.fresh ?? true) ? now : stale).toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(
    join(activeDir, `${id}.json`),
    JSON.stringify({
      schema_version: 1,
      instance_id: id,
      name: opts.name,
      session_id: opts.session ?? id,
      parent_instance_id: opts.parent,
      files_touched: opts.files ?? [],
      last_heartbeat: ts,
      started_at: ts,
    }),
    "utf8",
  );
}

describe("evaluateClaim", () => {
  test("no peers, fresh path → allow + claim acquired", () => {
    seedPeer("self", { name: "Maya" });
    const v = evaluateClaim(root, { rule: "claim", instance_id: "self", path: "docs/x.md" });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("claim.pass");
  });

  test("fresh peer holding same path → deny with peer name in reason", () => {
    seedPeer("peer", { name: "Adelaide", files: ["docs/shared.md"] });
    seedPeer("self", { name: "Maya" });
    const v = evaluateClaim(root, { rule: "claim", instance_id: "self", path: "docs/shared.md" });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("claim.conflict");
    expect(v.reason).toContain("agent-Adelaide");
  });

  test("stale peer holding same path → allow (stale claims don't block)", () => {
    seedPeer("peer", { name: "Adelaide", files: ["docs/shared.md"], fresh: false });
    seedPeer("self", { name: "Maya" });
    const v = evaluateClaim(root, { rule: "claim", instance_id: "self", path: "docs/shared.md" });
    expect(v.allow).toBe(true);
  });

  test("same group (parent + subagent) → no conflict", () => {
    // Subagent shape: instance_id != session_id; session_id is parent's id.
    seedPeer("parent", { name: "Maya", files: ["docs/shared.md"] });
    seedPeer("child", {
      name: "Maya-sub",
      session: "parent", // belongs to parent's group
      parent: "parent",
    });
    const v = evaluateClaim(root, {
      rule: "claim",
      instance_id: "child",
      session_id: "parent",
      path: "docs/shared.md",
    });
    expect(v.allow).toBe(true);
  });

  test("read mode does NOT acquire the claim", () => {
    seedPeer("self", { name: "Maya" });
    const v = evaluateClaim(root, {
      rule: "claim",
      instance_id: "self",
      path: "docs/x.md",
      mode: "read",
    });
    expect(v.allow).toBe(true);
    // Re-read heartbeat: files_touched should still be empty
    const path = join(activeDir, "self.json");
    const body = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
    expect(body.files_touched).toEqual([]);
  });

  test("write mode acquires the claim (idempotent)", () => {
    seedPeer("self", { name: "Maya" });
    evaluateClaim(root, { rule: "claim", instance_id: "self", path: "docs/x.md" });
    evaluateClaim(root, { rule: "claim", instance_id: "self", path: "docs/x.md" });
    const body = JSON.parse(require("node:fs").readFileSync(join(activeDir, "self.json"), "utf8"));
    expect(body.files_touched).toEqual(["docs/x.md"]);
  });
});

describe("evaluateClaim: ordering self-prune", () => {
  // A fresh OTHER peer that CONTENDS (shares a file with self's footprint) must
  // exist for the ordering rule to engage. The rule arms on genuine contention,
  // not on the mere presence of an active peer, so the seeded peer holds a path
  // that overlaps self's held-or-requested set (default: the higher path self
  // holds in these tests).
  function seedFreshOtherPeer(files: string[] = ["src/z-higher.ts"]): void {
    seedPeer("peer", { name: "Greta", files });
  }

  function gitInit(dir: string): void {
    spawnSync("git", ["-C", dir, "init", "-q"]);
    spawnSync("git", ["-C", dir, "config", "user.email", "t@t.dev"]);
    spawnSync("git", ["-C", dir, "config", "user.name", "Tester"]);
  }
  function gitCommitFile(dir: string, rel: string): void {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "x\n");
    spawnSync("git", ["-C", dir, "add", rel]);
    spawnSync("git", ["-C", dir, "commit", "-q", "-m", "add"]);
  }
  function selfFiles(): string[] {
    return JSON.parse(readFileSync(join(activeDir, "self.json"), "utf8")).files_touched;
  }

  test("ACTIVE (uncommitted) higher claim blocks a lower acquisition", () => {
    seedFreshOtherPeer();
    // non-git tmpdir → the higher claim reads as dirty/active → must block
    seedPeer("self", { name: "Maya", files: ["src/z-higher.ts"] });
    const v = evaluateClaim(root, { rule: "claim", instance_id: "self", path: "src/a-lower.ts" });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("claim.ordering_violation");
    expect(v.reason).toContain("src/z-higher.ts");
  });

  test("committed-clean higher claim is pruned, lower acquisition allowed", () => {
    gitInit(root);
    gitCommitFile(root, "src/z-higher.ts"); // now committed-clean (finished edit)
    seedFreshOtherPeer();
    seedPeer("self", { name: "Maya", files: ["src/z-higher.ts"] });
    const v = evaluateClaim(root, { rule: "claim", instance_id: "self", path: "src/a-lower.ts" });
    expect(v.allow).toBe(true);
    const files = selfFiles();
    expect(files).not.toContain("src/z-higher.ts"); // stale finished claim pruned
    expect(files).toContain("src/a-lower.ts"); // new claim acquired
  });

  test("mixed: committed-clean blocker pruned but dirty blocker still blocks", () => {
    gitInit(root);
    gitCommitFile(root, "src/m-clean.ts");
    // Peer contends on z-dirty (in self's footprint) so the ordering rule arms.
    seedFreshOtherPeer(["src/z-dirty.ts"]);
    // hold one committed-clean higher claim and one dirty (untracked) higher claim
    seedPeer("self", { name: "Maya", files: ["src/m-clean.ts", "src/z-dirty.ts"] });
    const v = evaluateClaim(root, { rule: "claim", instance_id: "self", path: "src/a-lower.ts" });
    expect(v.allow).toBe(false);
    expect(v.reason).toContain("src/z-dirty.ts");
    expect(v.reason).not.toContain("src/m-clean.ts");
  });

  test("no fresh peers → ordering rule is exempt even with a higher claim", () => {
    seedPeer("self", { name: "Maya", files: ["src/z-higher.ts"] });
    const v = evaluateClaim(root, { rule: "claim", instance_id: "self", path: "src/a-lower.ts" });
    expect(v.allow).toBe(true);
  });

  test("re-editing an already-held lower path is allowed despite a higher active claim", () => {
    seedFreshOtherPeer();
    // non-git tmpdir → src/z-higher.ts reads as active. Self already holds the
    // lower path, so re-acquiring it must NOT trip the ordering rule (no new
    // lock edge → no circular-wait risk).
    seedPeer("self", { name: "Maya", files: ["src/a-lower.ts", "src/z-higher.ts"] });
    const v = evaluateClaim(root, { rule: "claim", instance_id: "self", path: "src/a-lower.ts" });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("claim.pass");
  });

  test("a genuinely-new lower acquisition still blocks even when a higher path is held", () => {
    seedFreshOtherPeer();
    // self holds only the higher path; the lower path is NOT already held, so
    // the deadlock-prevention ordering rule still fires (regression guard for
    // the re-edit exemption above).
    seedPeer("self", { name: "Maya", files: ["src/z-higher.ts"] });
    const v = evaluateClaim(root, { rule: "claim", instance_id: "self", path: "src/a-lower.ts" });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("claim.ordering_violation");
  });

  test("a fresh peer editing UNRELATED files does NOT arm the ordering rule", () => {
    // The core false-positive: a peer active on files that don't overlap self's
    // footprint (held claims ∪ requested path) cannot be part of any wait-for
    // cycle through self, so sorted-order acquisition is unnecessary and the
    // backward edit must be allowed. Without contention-scoped arming, this
    // walled off every backward-order edit whenever any peer was merely active.
    seedFreshOtherPeer(["zzz/unrelated.md"]);
    seedPeer("self", { name: "Maya", files: ["src/z-higher.ts"] });
    const v = evaluateClaim(root, { rule: "claim", instance_id: "self", path: "src/a-lower.ts" });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("claim.pass");
  });

  test("contention on a DIFFERENT held path (not the requested one) still arms ordering", () => {
    // self holds two higher paths; peer contends on the one that isn't the
    // requested path. Footprint overlap exists → the rule arms and the genuine
    // backward acquisition is blocked (no self-heal: non-git tmpdir reads dirty).
    seedFreshOtherPeer(["src/y-other.ts"]);
    seedPeer("self", { name: "Maya", files: ["src/y-other.ts", "src/z-higher.ts"] });
    const v = evaluateClaim(root, { rule: "claim", instance_id: "self", path: "src/a-lower.ts" });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("claim.ordering_violation");
  });
});
