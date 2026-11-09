import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { canonicalClaimPath, stripCoordRoot } from "./claim-path.ts";

// Built with the platform's own path functions, so on Windows these are
// `C:\...` paths with backslashes.
const root = resolve("harnery-claim-root", "repo");

describe("stripCoordRoot", () => {
  test("an absolute path inside the root becomes forward-slash relative", () => {
    expect(stripCoordRoot(root, join(root, "src", "a.ts"))).toBe("src/a.ts");
  });

  test("the root itself, outside paths and relative paths are returned as given", () => {
    expect(stripCoordRoot(root, root)).toBe(root);
    const outside = join(dirname(root), "repo-other", "a.ts");
    expect(stripCoordRoot(root, outside)).toBe(outside);
    expect(stripCoordRoot(root, "src/a.ts")).toBe("src/a.ts");
  });

  test("agrees with canonicalClaimPath for paths inside the root", () => {
    const inside = join(root, "docs", "b.md");
    expect(stripCoordRoot(root, inside)).toBe(canonicalClaimPath(root, inside));
  });
});
