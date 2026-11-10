import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import { readEventV3ActiveTailV3 } from "./reader.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

describe("readEventV3ActiveTailV3", () => {
  test("reports a missing active file", () => {
    expect(readEventV3ActiveTailV3(ledgerRoot(), 16)).toEqual({ status: "missing" });
  });

  test("reports a symlinked active file as unsafe", () => {
    const root = ledgerRoot();
    const target = join(root, "elsewhere.ndjson");
    writeFileSync(target, "abc\n");
    symlinkSync(target, activePath(root));
    expect(readEventV3ActiveTailV3(root, 16)).toEqual({ status: "unsafe" });
  });

  test("returns an empty read for an empty file", () => {
    const root = ledgerRoot();
    writeFileSync(activePath(root), "");
    const tail = readEventV3ActiveTailV3(root, 16);
    expect(tail).toEqual({ status: "read", start: 0, bytes: Buffer.alloc(0) });
  });

  test("returns the whole file when it fits and only the last bytes when it does not", () => {
    const root = ledgerRoot();
    writeFileSync(activePath(root), "first\nsecond\n");
    const whole = readEventV3ActiveTailV3(root, 64);
    expect(whole.status === "read" && whole.start).toBe(0);
    expect(whole.status === "read" && whole.bytes.toString("utf8")).toBe("first\nsecond\n");

    const bounded = readEventV3ActiveTailV3(root, 8);
    expect(bounded.status === "read" && bounded.start).toBe(5);
    expect(bounded.status === "read" && bounded.bytes.toString("utf8")).toBe("\nsecond\n");
  });
});

function ledgerRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harn-active-tail-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery/ledgers/v3"), { recursive: true });
  return root;
}

function activePath(root: string): string {
  return join(root, ".harnery/ledgers/v3/active.ndjson");
}
