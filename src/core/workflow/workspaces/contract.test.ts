import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "../../../../tests/workspace-test-helpers.ts";
import {
  canonicalJson,
  readJsonRecord,
  stableDigest,
  writeImmutableJson,
} from "../durable-record.ts";
import {
  assertContainedExisting,
  candidateUnderRoot,
  createContainedDirectories,
  validateConfiguredRoot,
} from "./paths.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace record contracts", () => {
  test("canonical digests are key-order neutral and immutable records fail on drift", () => {
    expect(stableDigest({ b: 2, a: 1 })).toBe(stableDigest({ a: 1, b: 2 }));
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    const root = tracked("workspace-record");
    const path = join(root, "record.json");
    expect(writeImmutableJson(path, { value: 1 })).toBe(true);
    expect(writeImmutableJson(path, { value: 1 })).toBe(false);
    expect(() => writeImmutableJson(path, { value: 2 })).toThrow(/immutable record/);
    writeFileSync(path, "{bad", "utf8");
    expect(() => readJsonRecord(path, "record")).toThrow(/cannot parse/);
  });

  test("an immutable record is complete after its writer exits immediately", () => {
    const root = tracked("workspace-record-process-exit");
    const path = join(root, "record.json");
    const moduleUrl = new URL("../durable-record.ts", import.meta.url).href;
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `const { writeImmutableJson } = await import(${JSON.stringify(moduleUrl)});
         writeImmutableJson(${JSON.stringify(path)}, { durable: true });
         process.exit(0);`,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(readJsonRecord<{ durable: boolean }>(path, "record")).toEqual({ durable: true });
    expect(writeImmutableJson(path, { durable: true })).toBe(false);
  });
});

describe("workspace path authority", () => {
  test("rejects sibling prefixes, symlinks, missing roots, and unsafe segments", () => {
    const base = tracked("workspace-path");
    const allowed = join(base, "allowed");
    const sibling = join(base, "allowed-sibling");
    const outside = join(base, "outside");
    mkdirSync(allowed);
    mkdirSync(sibling);
    mkdirSync(outside);
    const root = validateConfiguredRoot(allowed);
    expect(() => assertContainedExisting(root, sibling, "sibling")).toThrow(/escapes/);
    symlinkSync(outside, join(allowed, "link"));
    expect(() => assertContainedExisting(root, join(allowed, "link"), "link")).toThrow(/symlink/);
    expect(() => validateConfiguredRoot(join(base, "missing"))).toThrow(/does not exist/);
    expect(() => candidateUnderRoot(root, [".."])).toThrow(/safe relative segment/);
    expect(() => candidateUnderRoot(root, ["bad\u0000name"])).toThrow(/control/);
    expect(() => candidateUnderRoot(root, ["e\u0301"])).toThrow(/Unicode/);
  });

  test("rejects configured roots with symlinked ancestors or explicit parent traversal", () => {
    const base = tracked("workspace-configured-root");
    const realParent = join(base, "real-parent");
    const realRoot = join(realParent, "allowed");
    mkdirSync(realParent);
    mkdirSync(realRoot);
    symlinkSync(realParent, join(base, "linked-parent"));
    expect(() => validateConfiguredRoot(join(base, "linked-parent", "allowed"))).toThrow(
      /symlink components/,
    );
    expect(() => validateConfiguredRoot(`${realParent}/../real-parent/allowed`)).toThrow(
      /parent traversal|normalization/,
    );
  });

  test("creates only validated one-segment components and detects root replacement", () => {
    const base = tracked("workspace-components");
    const allowed = join(base, "allowed");
    mkdirSync(allowed);
    const root = validateConfiguredRoot(allowed);
    expect(createContainedDirectories(root, ["one", "two"])).toBe(join(allowed, "one", "two"));
    renameSync(allowed, join(base, "old-allowed"));
    mkdirSync(allowed);
    expect(() => createContainedDirectories(root, ["three"])).toThrow(/identity changed/);
  });

  test("detects a replaced contained parent before a leaf can be materialized", () => {
    const base = tracked("workspace-parent-replacement");
    const allowed = join(base, "allowed");
    const outside = join(base, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    const root = validateConfiguredRoot(allowed);
    createContainedDirectories(root, ["harnery-workspaces"]);
    renameSync(join(allowed, "harnery-workspaces"), join(allowed, "prior-parent"));
    symlinkSync(outside, join(allowed, "harnery-workspaces"));
    expect(() => createContainedDirectories(root, ["harnery-workspaces"])).toThrow(
      /not an owned directory/,
    );
  });
});

function tracked(label: string): string {
  const root = tempRoot(label);
  roots.push(root);
  return root;
}
