import { describe, expect, test } from "bun:test";
import { isPathAllowed, normalizeAllowPath, parseAllowPathsEnv } from "./path-scope";

/** Pathname exactly as the gate sees it: WHATWG-parsed from the request URL. */
function parsed(path: string): string {
  return new URL(path, "http://gate.invalid").pathname;
}

describe("normalizeAllowPath", () => {
  test("canonicalizes a prefix and keeps / as the whole upstream", () => {
    expect(normalizeAllowPath("/decisions/")).toBe("/decisions");
    expect(normalizeAllowPath(" /a/b ")).toBe("/a/b");
    expect(normalizeAllowPath("/")).toBe("/");
  });

  test("rejects prefixes the gate could not match unambiguously", () => {
    for (const bad of [
      "decisions",
      "",
      "/a/../b",
      "/a//b",
      "/a/./b",
      "/a?x=1",
      "/a#b",
      "/a%2Fb",
      "/a\\b",
    ]) {
      expect(() => normalizeAllowPath(bad)).toThrow();
    }
  });

  test("parses the gate env value and drops duplicates", () => {
    expect(parseAllowPathsEnv("/a, /b/,/a")).toEqual(["/a", "/b"]);
    expect(parseAllowPathsEnv(undefined)).toEqual([]);
  });
});

describe("isPathAllowed", () => {
  const scope = ["/decisions", "/_next"];

  test("allows a prefix and everything below it on a segment boundary", () => {
    expect(isPathAllowed(parsed("/decisions"), scope)).toBe(true);
    expect(isPathAllowed(parsed("/decisions/abc?x=1"), scope)).toBe(true);
    expect(isPathAllowed(parsed("/_next/static/chunk.js"), scope)).toBe(true);
  });

  test("refuses sibling names and paths outside the scope", () => {
    expect(isPathAllowed(parsed("/decisionsX"), scope)).toBe(false);
    expect(isPathAllowed(parsed("/files"), scope)).toBe(false);
    expect(isPathAllowed(parsed("/"), scope)).toBe(false);
  });

  test("refuses traversal out of an allowed prefix", () => {
    expect(isPathAllowed(parsed("/decisions/../files"), scope)).toBe(false);
    expect(isPathAllowed(parsed("/decisions/%2e%2e/files"), scope)).toBe(false);
    expect(isPathAllowed(parsed("/decisions%2F..%2Ffiles"), scope)).toBe(false);
    expect(isPathAllowed(parsed("/decisions/%252e%252e/files"), scope)).toBe(false);
    expect(isPathAllowed("/decisions/..\\files", scope)).toBe(false);
  });

  test("an empty scope refuses everything and / allows everything", () => {
    expect(isPathAllowed(parsed("/decisions"), [])).toBe(false);
    expect(isPathAllowed(parsed("/files"), ["/"])).toBe(true);
  });
});
