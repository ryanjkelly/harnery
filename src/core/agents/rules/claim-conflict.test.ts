import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
