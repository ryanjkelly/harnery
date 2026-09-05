/**
 * Security + behavior matrix for the directory-listing layer (lib/file-tree.ts
 * `listDir`). The containment + deny model is shared with resolveFile
 * (files.test.ts); these tests assert the LISTING-specific properties: denied
 * entries are HIDDEN (not just blocked), contents-denied dirs (node_modules)
 * drop out, symlinks that escape the root are skipped, and traversal / outside-
 * root / not-a-dir inputs fail closed.
 */

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __fileTreeTestHooks,
  __resetFileTreeCaches,
  dirUsage,
  listDir,
  searchFiles,
} from "./file-tree.ts";

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

const names = (r: Awaited<ReturnType<typeof listDir>>): string[] =>
  r.ok ? r.entries.map((e) => e.name) : [];

test("listing yields to other requests while collecting a large directory", async () => {
  const root = makeRoot();
  for (let i = 0; i < 1000; i++) w(root, `files/${i}.txt`, "content");
  let yielded = false;
  const turn = setImmediate(() => {
    yielded = true;
  });
  try {
    const result = await listDir("files", { root });
    expect(result.ok && result.entries.length).toBe(1000);
    expect(yielded).toBe(true);
  } finally {
    clearImmediate(turn);
  }
});

test("a directory replacement during listing cannot publish names from another target", async () => {
  const root = makeRoot();
  const outside = makeRoot();
  w(root, "files/visible.txt", "visible");
  w(outside, "private.txt", "outside");
  __fileTreeTestHooks.afterListingRead = (directory) => {
    renameSync(directory, `${directory}.original`);
    symlinkSync(outside, directory);
  };
  try {
    const result = await listDir("files", { root });
    expect(result.ok).toBe(false);
  } finally {
    __fileTreeTestHooks.afterListingRead = undefined;
  }
});

test("a changed deny policy during listing cannot publish the earlier result", async () => {
  const root = makeRoot();
  w(root, "files/visible.txt", "visible");
  __fileTreeTestHooks.afterListingRead = () => {
    w(root, ".harnery/config.jsonc", JSON.stringify({ files: { deny_globs: ["**/visible.txt"] } }));
  };
  try {
    const result = await listDir("files", { root });
    expect(result).toMatchObject({ ok: false, code: "config_error" });
  } finally {
    __fileTreeTestHooks.afterListingRead = undefined;
  }
});

describe("listDir — root listing", async () => {
  const root = buildFixture();
  const res = await listDir("", { root });

  test("succeeds and reports dir as the repo root ('')", async () => {
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.dir).toBe("");
  });

  test("shows positive controls", async () => {
    expect(names(res)).toEqual(
      expect.arrayContaining(["README.md", "docs", "src", "app-web", "tools"]),
    );
  });

  test("hides directly-denied entries (.env, .credentials, .git, secret jsons)", async () => {
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

  test("hides contents-denied directories (node_modules)", async () => {
    expect(names(res)).not.toContain("node_modules");
  });

  test("readmits soft-denied entries rescued by an allow-override (.env.example)", async () => {
    expect(names(res)).toContain(".env.example");
  });

  test("orders directories before files", async () => {
    if (!res.ok) throw new Error("expected ok");
    const kinds = res.entries.map((e) => e.kind);
    const lastDir = kinds.lastIndexOf("dir");
    const firstFile = kinds.indexOf("file");
    if (lastDir !== -1 && firstFile !== -1) expect(lastDir).toBeLessThan(firstFile);
  });
});

describe("listDir — subdirectories", async () => {
  const root = buildFixture();

  test("lists a nested directory by relPath, with canonical dir echoed", async () => {
    const res = await listDir("docs", { root });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.dir).toBe("docs");
      expect(res.entries).toEqual([
        expect.objectContaining({ name: "plans", relPath: "docs/plans", kind: "dir" }),
      ]);
    }
  });

  test("hides a denied file inside an allowed directory (tools/my-service-account.json)", async () => {
    const res = await listDir("tools", { root });
    const n = names(res);
    expect(n).toContain("ok.txt");
    expect(n).not.toContain("my-service-account.json");
  });
});

describe("listDir — fail-closed rejections", async () => {
  const root = buildFixture();

  test("`..` segment → invalid_path", async () => {
    const r = await listDir("../etc", { root });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_path");
  });

  test("absolute path outside root → unresolvable", async () => {
    const r = await listDir("/etc", { root });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unresolvable");
  });

  test("a directly-denied directory → denied (not an empty listing)", async () => {
    const r = await listDir(".credentials", { root });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("denied");
  });

  test("non-existent directory → not_found", async () => {
    const r = await listDir("does/not/exist", { root });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  test("a regular file (not a directory) → not_file", async () => {
    const r = await listDir("README.md", { root });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_file");
  });
});

describe("listDir — symlink containment", async () => {
  test("an allowed alias cannot reveal a denied canonical target", async () => {
    const root = buildFixture();
    symlinkSync(path.join(root, ".credentials"), path.join(root, "alias"), "dir");
    symlinkSync(path.join(root, ".env"), path.join(root, "alias.txt"), "file");
    expect(names(await listDir("", { root }))).not.toContain("alias");
    expect(names(await listDir("", { root }))).not.toContain("alias.txt");
    expect(await listDir("alias", { root })).toMatchObject({ ok: false, code: "denied" });
    expect(await searchFiles("key", { root, dir: "alias" })).toMatchObject({
      ok: false,
      code: "denied",
    });
    expect(await dirUsage("alias", { root })).toMatchObject({ ok: false, code: "denied" });
  });
  test("a symlink whose target escapes the root is skipped", async () => {
    const root = buildFixture();
    // points at the parent tmp dir, which is outside the repo root
    symlinkSync(os.tmpdir(), path.join(root, "escape-link"), "dir");
    expect(names(await listDir("", { root }))).not.toContain("escape-link");
  });

  test("an in-root symlink to a real file is shown as a file", async () => {
    const root = buildFixture();
    symlinkSync(path.join(root, "README.md"), path.join(root, "readme-link.md"), "file");
    const res = await listDir("", { root });
    const entry = res.ok ? res.entries.find((e) => e.name === "readme-link.md") : undefined;
    expect(entry?.kind).toBe("file");
  });
});

describe("listDir — file sizes", async () => {
  const root = buildFixture();
  const res = await listDir("", { root });

  test("file entries carry byte size; directories carry none", async () => {
    if (!res.ok) throw new Error("expected ok");
    const readme = res.entries.find((e) => e.name === "README.md");
    const docs = res.entries.find((e) => e.name === "docs");
    expect(readme?.size).toBe("# readme\n".length);
    expect(docs?.size).toBeUndefined();
  });
});

describe("dirUsage — recursive totals + counts (deny-aware)", async () => {
  test("a changed deny policy cannot reuse cached folder names or totals", async () => {
    const root = buildFixture();
    const before = await dirUsage("", { root });
    expect(before.ok && before.children.docs).toBeDefined();
    w(root, ".harnery/config.jsonc", JSON.stringify({ files: { deny_globs: ["**/docs/**"] } }));
    const after = await dirUsage("", { root });
    expect(after.ok && after.children.docs).toBeUndefined();
  });
  const root = buildFixture();
  __resetFileTreeCaches();
  const result = dirUsage("", { root });

  // Non-denied files under the fixture: README.md(9) + .env.example(17) +
  // docs/plans/plan.md(7) + src/index.ts(11) + app-web/src/data.json(8) +
  // tools/ok.txt(5) = 57 bytes across 6 files + 6 dirs. node_modules/.git/
  // .credentials and the secret jsons are excluded.
  test("self totals exclude hidden/denied paths", async () => {
    const res = await result;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.self).toEqual({ fileCount: 6, dirCount: 6, totalBytes: 57 });
      expect(res.partial).toBe(false);
    }
  });

  test("per-immediate-child breakdown is present for visible dirs only", async () => {
    const res = await result;
    if (!res.ok) throw new Error("expected ok");
    expect(res.children.docs).toEqual({ fileCount: 1, dirCount: 1, totalBytes: 7 });
    expect(res.children.tools).toEqual({ fileCount: 1, dirCount: 0, totalBytes: 5 });
    expect(res.children.node_modules).toBeUndefined();
    expect(res.children[".git"]).toBeUndefined();
    expect(res.children[".credentials"]).toBeUndefined();
  });

  test("rejections mirror listDir (denied / traversal / not-a-dir)", async () => {
    const denied = await dirUsage(".credentials", { root });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("denied");
    const trav = await dirUsage("../etc", { root });
    expect(trav.ok).toBe(false);
    if (!trav.ok) expect(trav.code).toBe("invalid_path");
    const notDir = await dirUsage("README.md", { root });
    expect(notDir.ok).toBe(false);
    if (!notDir.ok) expect(notDir.code).toBe("not_file");
  });
});

describe("searchFiles — fuzzy index (deny + build-artifact aware)", async () => {
  test("async walks refuse a queued directory replaced by an external symlink", async () => {
    for (const mode of ["search", "usage"]) {
      const root = buildFixture();
      const outside = makeRoot();
      w(outside, "must-not-appear.txt", "outside bytes");
      const target = path.join(root, "docs");
      __fileTreeTestHooks.beforeDirectoryOpen = (absolutePath) => {
        if (absolutePath !== target) return;
        renameSync(target, path.join(root, "moved-docs"));
        symlinkSync(outside, target, "dir");
      };
      try {
        if (mode === "search") {
          const result = await searchFiles("must-not-appear", { root, waitForIndex: true });
          expect(result).toMatchObject({ ok: true, matches: [], truncated: true });
        } else {
          const result = await dirUsage("", { root });
          expect(result.ok && result.children.docs).toMatchObject({
            fileCount: 0,
            totalBytes: 0,
            partial: true,
          });
        }
      } finally {
        __fileTreeTestHooks.beforeDirectoryOpen = undefined;
      }
    }
  });
  test("limits search to the selected folder and includes folder matches", async () => {
    const root = buildFixture();
    const result = await searchFiles("plan", { root, dir: "docs", waitForIndex: true });
    expect(result.ok && result.matches).toEqual([
      { relPath: "docs/plans", kind: "dir" },
      { relPath: "docs/plans/plan.md", kind: "file" },
    ]);
    const outside = await searchFiles("index", { root, dir: "docs", waitForIndex: true });
    expect(outside.ok && outside.matches).toEqual([]);
  });

  test("explicitly reports an incomplete index when the safety cap is hit", async () => {
    const root = buildFixture();
    const result = await searchFiles("s", { root, maxEntries: 2, waitForIndex: true });
    expect(result).toMatchObject({ ok: true, truncated: true, indexing: false });
  });

  test("refreshes expired snapshots and removes deleted entries", async () => {
    const root = buildFixture();
    w(root, "old-report.txt", "old");
    await searchFiles("report", { root, waitForIndex: true, refreshMs: 0 });
    unlinkSync(path.join(root, "old-report.txt"));
    w(root, "new-report.txt", "fresh");
    const result = await searchFiles("report", { root, waitForIndex: true });
    expect(result.ok && result.matches).toContainEqual({ relPath: "new-report.txt", kind: "file" });
    expect(result.ok && result.matches).not.toContainEqual({
      relPath: "old-report.txt",
      kind: "file",
    });
  });
  function searchFixture(): string {
    const root = buildFixture();
    w(root, ".next/static/chunk-abc.js", "console.log(1)\n"); // build artifact → not indexed
    w(root, "node_modules/pkg/lib.js", "module.exports={}\n"); // denied → not indexed
    return root;
  }
  const root = searchFixture();
  __resetFileTreeCaches();
  const paths = async (q: string) => {
    const r = await searchFiles(q, { root, waitForIndex: true });
    return r.ok ? r.matches.map((m) => m.relPath) : [];
  };

  test("matches by basename substring", async () => {
    expect(await paths("plan")).toContain("docs/plans/plan.md");
  });

  test("ranks an exact/prefix basename match first", async () => {
    const first = (await paths("index"))[0];
    expect(first).toBe("src/index.ts");
  });

  test("excludes denied files and build-artifact dirs from the index", async () => {
    const chunk = await paths("chunk"); // lives under .next → skipped
    expect(chunk).toHaveLength(0);
    const lib = await paths("lib.js"); // lives under node_modules → denied
    expect(lib).toHaveLength(0);
    const env = await paths(".env"); // .env is denied; .env.example is rescued
    expect(env).not.toContain(".env");
    expect(env).toContain(".env.example");
  });

  test("empty query returns no matches", async () => {
    const r = await searchFiles("   ", { root });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matches).toHaveLength(0);
  });

  test("honors the limit + reports truncation", async () => {
    const r = await searchFiles("s", { root, limit: 1 }); // 's' is a broad subsequence hit
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matches.length).toBeLessThanOrEqual(1);
      if (r.total > 1) expect(r.truncated).toBe(true);
    }
  });
});
