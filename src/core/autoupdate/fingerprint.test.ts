import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandWatchPath, fingerprint, fingerprintLines } from "./fingerprint.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnery-autoupdate-fp-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("missing paths fingerprint as missing", () => {
  expect(fingerprintLines(["nope"], root)).toEqual(["nope\tmissing"]);
  expect(fingerprintLines(["$HARNERY_TEST_UNSET_VAR/x"], root, {})).toEqual([
    "$HARNERY_TEST_UNSET_VAR/x\tmissing",
  ]);
});

test("expands ~ and $VAR / braced VAR", () => {
  const env = { HOME: root, TOOLS: "tools" };
  expect(expandWatchPath("~/a", "/elsewhere", env)).toBe(join(root, "a"));
  expect(expandWatchPath("$TOOLS/x", root, env)).toBe(join(root, "tools", "x"));
  expect(expandWatchPath(["$", "{TOOLS}/x"].join(""), root, env)).toBe(join(root, "tools", "x"));
});

test("changes when a watched file or a watched directory's child changes", () => {
  writeFileSync(join(root, "tool"), "v1");
  mkdirSync(join(root, "dir"));
  const watch = ["tool", "dir"];
  const a = fingerprint(watch, root);
  expect(fingerprint(watch, root)).toBe(a);
  utimesSync(join(root, "tool"), 1_000, 1_000);
  const b = fingerprint(watch, root);
  expect(b).not.toBe(a);
  writeFileSync(join(root, "dir", "child"), "x");
  expect(fingerprint(watch, root)).not.toBe(b);
});
