import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { markNoTaskRefusal, noTaskRefusedEarlier } from "./remediation-cap.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

describe("no-task refusal marker", () => {
  test("refuses through the first cycle, then never again", () => {
    const root = mkdtempSync(join(tmpdir(), "harn-no-task-"));
    roots.push(root);
    expect(noTaskRefusedEarlier(root, "s1", "tid_a")).toBe(false);
    markNoTaskRefusal(root, "s1", "tid_a");
    expect(noTaskRefusedEarlier(root, "s1", "tid_a")).toBe(false);
    expect(noTaskRefusedEarlier(root, "s1", "tid_b")).toBe(true);
    markNoTaskRefusal(root, "s1", "tid_b");
    expect(noTaskRefusedEarlier(root, "s1", "tid_a")).toBe(false);
    expect(noTaskRefusedEarlier(root, "s2", "tid_b")).toBe(false);
  });
});
