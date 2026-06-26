/**
 * Locks releaseClaim's path-form robustness: files_touched can hold either
 * absolute-under-coordRoot or canonical monorepo-relative entries, and a
 * release by either form must match (the old exact-string filter silently
 * no-op'd on a form mismatch — the bug behind the "release-claim does nothing"
 * coord-layer friction).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseClaim } from "./heartbeat-writer.ts";

let root: string;
let activeDir: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `agent-coord-release-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

function seedSelf(files: string[]): void {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(
    join(activeDir, "self.json"),
    JSON.stringify({
      schema_version: 1,
      instance_id: "self",
      session_id: "self",
      files_touched: files,
      last_heartbeat: ts,
      started_at: ts,
    }),
    "utf8",
  );
}
function selfFiles(): string[] {
  return JSON.parse(readFileSync(join(activeDir, "self.json"), "utf8")).files_touched;
}

describe("releaseClaim path-form robustness", () => {
  test("relative arg releases a relative entry", () => {
    seedSelf(["docs/a.md", "docs/b.md"]);
    releaseClaim(root, "self", "docs/a.md");
    expect(selfFiles()).toEqual(["docs/b.md"]);
  });

  test("relative arg releases an absolute-under-coordRoot entry", () => {
    seedSelf([join(root, "docs/a.md"), "docs/b.md"]);
    releaseClaim(root, "self", "docs/a.md");
    expect(selfFiles()).toEqual(["docs/b.md"]);
  });

  test("absolute arg releases a relative entry", () => {
    seedSelf(["docs/a.md", "docs/b.md"]);
    releaseClaim(root, "self", join(root, "docs/a.md"));
    expect(selfFiles()).toEqual(["docs/b.md"]);
  });

  test("no match → unchanged", () => {
    seedSelf(["docs/a.md"]);
    releaseClaim(root, "self", "docs/nope.md");
    expect(selfFiles()).toEqual(["docs/a.md"]);
  });
});
