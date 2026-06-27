/**
 * Security + behavior matrix for the directory-listing layer (lib/file-tree.ts
 * `listDir`). The containment + deny model is shared with resolveFile
 * (files.test.ts); these tests assert the LISTING-specific properties: denied
 * entries are HIDDEN (not just blocked), contents-denied dirs (node_modules)
 * drop out, symlinks that escape the root are skipped, and traversal / outside-
 * root / not-a-dir inputs fail closed.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetFileTreeCaches, dirUsage, listDir, searchFiles } from "./file-tree.ts";

function makeRoot(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "harn-tree-")));
}

function w(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Standard repo-shaped fixture: positive controls + every deny family. */
function buildFixture(): string {
  const root = makeRoot();
  // positive controls
  w(root, "README.md", "# readme\n");
  w(root, "docs/plans/plan.md", "# plan\n");
  w(root, "src/index.ts", "export {};\n");
  w(root, "app-web/src/data.json", '{"a":1}\n');
  w(root, "tools/ok.txt", "fine\n");
  // deny families — must be hidden from listings
  w(root, ".env", "ROOT_SECRET=1\n");
  w(root, ".env.example", "ROOT_SECRET=fill\n"); // override → must be SHOWN
  w(root, ".credentials/gcp-sa-key.json", '{"k":1}\n');
  w(root, ".git/config", "[core]\n");
  w(root, ".git-credentials", "creds\n");
  w(root, "tools/my-service-account.json", '{"k":1}\n');
  w(root, "config-secret.json", '{"k":1}\n');
  w(root, "node_modules/pkg/index.js", "module.exports={}\n");
  return root;
}

const names = (r: ReturnType<typeof listDir>): string[] =>
  r.ok ? r.entries.map((e) => e.name) : [];

describe("listDir — root listing", () => {
  const root = buildFixture();
  const res = listDir("", { root });

  test("succeeds and reports dir as the repo root ('')", () => {
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.dir).toBe("");
  });

  test("shows positive controls", () => {
    expect(names(res)).toEqual(
      expect.arrayContaining(["README.md", "docs", "src", "app-web", "tools"]),
    );
  });

  test("hides directly-denied entries (.env, .credentials, .git, secret jsons)", () => {
    const n = names(res);
    for (const hidden of [
      ".env",
      ".credentials",
      ".git",
      ".git-credentials",
      "config-secret.json",
    ]) {
      expect(n).not.toContain(hidden);
    }
  });

  test("hides contents-denied directories (node_modules)", () => {
    expect(names(res)).not.toContain("node_modules");
  });

  test("readmits soft-denied entries rescued by an allow-override (.env.example)", () => {
    expect(names(res)).toContain(".env.example");
  });

  test("orders directories before files", () => {
    if (!res.ok) throw new Error("expected ok");
    const kinds = res.entries.map((e) => e.kind);
    const lastDir = kinds.lastIndexOf("dir");
    const firstFile = kinds.indexOf("file");
    if (lastDir !== -1 && firstFile !== -1) expect(lastDir).toBeLessThan(firstFile);
  });
});

describe("listDir — subdirectories", () => {
  const root = buildFixture();

  test("lists a nested directory by relPath, with canonical dir echoed", () => {
    const res = listDir("docs", { root });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.dir).toBe("docs");
      expect(res.entries).toEqual([{ name: "plans", relPath: "docs/plans", kind: "dir" }]);
    }
  });

  test("hides a denied file inside an allowed directory (tools/my-service-account.json)", () => {
    const res = listDir("tools", { root });
    const n = names(res);
    expect(n).toContain("ok.txt");
    expect(n).not.toContain("my-service-account.json");
  });
});

describe("listDir — fail-closed rejections", () => {
  const root = buildFixture();

  test("`..` segment → invalid_path", () => {
    const r = listDir("../etc", { root });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_path");
  });

  test("absolute path outside root → unresolvable", () => {
    const r = listDir("/etc", { root });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unresolvable");
  });

  test("a directly-denied directory → denied (not an empty listing)", () => {
    const r = listDir(".credentials", { root });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("denied");
  });

  test("non-existent directory → not_found", () => {
    const r = listDir("does/not/exist", { root });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  test("a regular file (not a directory) → not_file", () => {
    const r = listDir("README.md", { root });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_file");
  });
});

describe("listDir — symlink containment", () => {
  test("a symlink whose target escapes the root is skipped", () => {
    const root = buildFixture();
    // points at the parent tmp dir, which is outside the repo root
    symlinkSync(os.tmpdir(), path.join(root, "escape-link"), "dir");
    expect(names(listDir("", { root }))).not.toContain("escape-link");
  });

  test("an in-root symlink to a real file is shown as a file", () => {
    const root = buildFixture();
    symlinkSync(path.join(root, "README.md"), path.join(root, "readme-link.md"), "file");
    const res = listDir("", { root });
    const entry = res.ok ? res.entries.find((e) => e.name === "readme-link.md") : undefined;
    expect(entry?.kind).toBe("file");
  });
});

describe("listDir — file sizes", () => {
  const root = buildFixture();
  const res = listDir("", { root });

  test("file entries carry byte size; directories carry none", () => {
    if (!res.ok) throw new Error("expected ok");
    const readme = res.entries.find((e) => e.name === "README.md");
    const docs = res.entries.find((e) => e.name === "docs");
    expect(readme?.size).toBe("# readme\n".length);
    expect(docs?.size).toBeUndefined();
  });
});

describe("dirUsage — recursive totals + counts (deny-aware)", () => {
  const root = buildFixture();
  __resetFileTreeCaches();
  const res = dirUsage("", { root });

  // Non-denied files under the fixture: README.md(9) + .env.example(17) +
  // docs/plans/plan.md(7) + src/index.ts(11) + app-web/src/data.json(8) +
  // tools/ok.txt(5) = 57 bytes across 6 files + 6 dirs. node_modules/.git/
  // .credentials and the secret jsons are excluded.
  test("self totals exclude hidden/denied paths", () => {
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.self).toEqual({ fileCount: 6, dirCount: 6, totalBytes: 57 });
      expect(res.partial).toBe(false);
    }
  });

  test("per-immediate-child breakdown is present for visible dirs only", () => {
    if (!res.ok) throw new Error("expected ok");
    expect(res.children.docs).toEqual({ fileCount: 1, dirCount: 1, totalBytes: 7 });
    expect(res.children.tools).toEqual({ fileCount: 1, dirCount: 0, totalBytes: 5 });
    expect(res.children.node_modules).toBeUndefined();
    expect(res.children[".git"]).toBeUndefined();
    expect(res.children[".credentials"]).toBeUndefined();
  });

  test("rejections mirror listDir (denied / traversal / not-a-dir)", () => {
    const denied = dirUsage(".credentials", { root });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("denied");
    const trav = dirUsage("../etc", { root });
    expect(trav.ok).toBe(false);
    if (!trav.ok) expect(trav.code).toBe("invalid_path");
    const notDir = dirUsage("README.md", { root });
    expect(notDir.ok).toBe(false);
    if (!notDir.ok) expect(notDir.code).toBe("not_file");
  });
});

describe("searchFiles — fuzzy index (deny + build-artifact aware)", () => {
  function searchFixture(): string {
    const root = buildFixture();
    w(root, ".next/static/chunk-abc.js", "console.log(1)\n"); // build artifact → not indexed
    w(root, "node_modules/pkg/lib.js", "module.exports={}\n"); // denied → not indexed
    return root;
  }
  const root = searchFixture();
  __resetFileTreeCaches();
  const paths = (q: string) => {
    const r = searchFiles(q, { root });
    return r.ok ? r.matches.map((m) => m.relPath) : [];
  };

  test("matches by basename substring", () => {
    expect(paths("plan")).toContain("docs/plans/plan.md");
  });

  test("ranks an exact/prefix basename match first", () => {
    const first = paths("index")[0];
    expect(first).toBe("src/index.ts");
  });

  test("excludes denied files and build-artifact dirs from the index", () => {
    const chunk = paths("chunk"); // lives under .next → skipped
    expect(chunk).toHaveLength(0);
    const lib = paths("lib.js"); // lives under node_modules → denied
    expect(lib).toHaveLength(0);
    const env = paths(".env"); // .env is denied; .env.example is rescued
    expect(env).not.toContain(".env");
    expect(env).toContain(".env.example");
  });

  test("empty query returns no matches", () => {
    const r = searchFiles("   ", { root });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matches).toHaveLength(0);
  });

  test("honors the limit + reports truncation", () => {
    const r = searchFiles("s", { root, limit: 1 }); // 's' is a broad subsequence hit
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matches.length).toBeLessThanOrEqual(1);
      if (r.total > 1) expect(r.truncated).toBe(true);
    }
  });
});
