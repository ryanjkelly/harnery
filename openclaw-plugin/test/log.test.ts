import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import { appendJsonLine } from "../src/log.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

describe("OpenClaw debug log writer", () => {
  test("a failed write reports no part of the log path", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery openclaw log "));
    roots.push(root);
    // A plain file where the log directory should be makes every write fail.
    const blocker = join(root, "private customer");
    writeFileSync(blocker, "");
    const lines: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      appendJsonLine(join(blocker, "logs", "debug.jsonl"), { event: "x" });
    } finally {
      spy.mockRestore();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[harnery\] log write failed \([A-Z]+\)\n$/);
    expect(lines.join("")).not.toContain("customer");
    expect(lines.join("")).not.toContain(root);
  });
});
