import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAndStamp,
  checkWebBuildFreshness,
  computeWebSourceFingerprint,
  ensureFreshWebBuild,
  parsePorcelainZ,
  readWebBuildStamp,
  WEB_BUILD_STAMP_FILE,
  webDistDir,
  writeWebBuildStamp,
} from "./web-build-stamp.ts";

/** A package root shaped like harnery: web/ beside src/. */
function scaffold(root: string): string {
  const web = join(root, "web");
  for (const dir of ["web/app", "web/components", "web/lib", "web/tests", "src/core"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(web, "package.json"), '{ "name": "web" }\n');
  writeFileSync(join(web, "next.config.ts"), "export default {};\n");
  writeFileSync(join(web, "server-preload.mjs"), "// preload\n");
  writeFileSync(join(web, "app", "page.tsx"), "export default function Page() {}\n");
  writeFileSync(join(web, "tests", "page.test.ts"), "// test\n");
  writeFileSync(join(root, "src", "core", "reader.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "README.md"), "# readme\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.next/\n");
  return web;
}

/** A fake `next build` that leaves a build directory behind. */
function fakeBuild(web: string, status = 0): { run: () => number; calls: () => number } {
  let calls = 0;
  return {
    run: () => {
      calls++;
      if (status === 0) mkdirSync(join(web, ".next"), { recursive: true });
      return status;
    },
    calls: () => calls,
  };
}

let savedDistDir: string | undefined;
let root: string;

beforeEach(() => {
  savedDistDir = process.env.HARNERY_WEB_DIST_DIR;
  delete process.env.HARNERY_WEB_DIST_DIR;
  root = mkdtempSync(join(tmpdir(), "harnery-web-stamp-"));
});

afterEach(() => {
  if (savedDistDir === undefined) delete process.env.HARNERY_WEB_DIST_DIR;
  else process.env.HARNERY_WEB_DIST_DIR = savedDistDir;
  rmSync(root, { recursive: true, force: true });
});

describe("git fingerprint", () => {
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.autocrlf=false",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  let web: string;

  beforeEach(() => {
    web = scaffold(root);
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  });

  test("is stable on a clean tree and ignores the build output and other paths", () => {
    const first = computeWebSourceFingerprint(web);
    expect(first.kind).toBe("git");
    writeWebBuildStamp(webDistDir(web), first);
    mkdirSync(join(web, "node_modules", "next"), { recursive: true });
    writeFileSync(join(web, "node_modules", "next", "index.js"), "x\n");
    writeFileSync(join(root, "README.md"), "# changed outside the dashboard\n");
    expect(computeWebSourceFingerprint(web)).toEqual(first);
    expect(checkWebBuildFreshness(webDistDir(web), first)).toEqual({ stale: false });
  });

  test("changes on uncommitted edits, their content, untracked files and commits", () => {
    const clean = computeWebSourceFingerprint(web);

    writeFileSync(join(root, "src", "core", "reader.ts"), "export const a = 2;\n");
    const edited = computeWebSourceFingerprint(web);
    expect(edited.value).not.toBe(clean.value);

    writeFileSync(join(root, "src", "core", "reader.ts"), "export const a = 3;\n");
    const editedAgain = computeWebSourceFingerprint(web);
    expect(editedAgain.value).not.toBe(edited.value);

    git("checkout", "--", "src/core/reader.ts");
    expect(computeWebSourceFingerprint(web)).toEqual(clean);

    mkdirSync(join(web, "app", "new-page"));
    writeFileSync(join(web, "app", "new-page", "page.tsx"), "export default 1;\n");
    const untracked = computeWebSourceFingerprint(web);
    expect(untracked.value).not.toBe(clean.value);

    git("add", "-A");
    git("commit", "-q", "-m", "add a page");
    const committed = computeWebSourceFingerprint(web);
    expect(committed.value).not.toBe(clean.value);
    expect(committed.value).not.toBe(untracked.value);
  });

  test("a build stamped before a pull is stale after it", () => {
    const build = fakeBuild(web);
    expect(ensureFreshWebBuild(web, build.run, () => {})).toEqual({ ok: true, rebuilt: true });
    expect(ensureFreshWebBuild(web, build.run, () => {})).toEqual({ ok: true, rebuilt: false });
    expect(build.calls()).toBe(1);

    writeFileSync(join(web, "app", "page.tsx"), "export default function Page() { return 1; }\n");
    git("commit", "-q", "-am", "update the page");
    const lines: string[] = [];
    expect(ensureFreshWebBuild(web, build.run, (line) => lines.push(line))).toEqual({
      ok: true,
      rebuilt: true,
    });
    expect(lines).toEqual([
      "rebuilding the dashboard: dashboard sources changed since the last build",
    ]);
    expect(build.calls()).toBe(2);
  });

  test("handles a deleted tracked file", () => {
    const clean = computeWebSourceFingerprint(web);
    rmSync(join(web, "tests", "page.test.ts"));
    expect(computeWebSourceFingerprint(web).value).not.toBe(clean.value);
  });

  test("handles a renamed file", () => {
    const clean = computeWebSourceFingerprint(web);
    git("mv", "src/core/reader.ts", "src/core/renamed.ts");
    const renamed = computeWebSourceFingerprint(web);
    expect(renamed.value).not.toBe(clean.value);
    renameSync(join(root, "src", "core", "renamed.ts"), join(root, "src", "core", "other.ts"));
    expect(computeWebSourceFingerprint(web).value).not.toBe(renamed.value);
  });
});

describe("modification-time fingerprint outside Git", () => {
  const noGit = () => ({ status: 128, stdout: "" });
  let web: string;

  beforeEach(() => {
    web = scaffold(root);
  });

  const setAll = (seconds: number) => {
    for (const file of [
      "web/package.json",
      "web/next.config.ts",
      "web/server-preload.mjs",
      "web/app/page.tsx",
      "web/tests/page.test.ts",
      "src/core/reader.ts",
    ]) {
      utimesSync(join(root, file), seconds, seconds);
    }
    for (const dir of ["web/app", "web/components", "web/lib", "web/tests", "src", "src/core"]) {
      utimesSync(join(root, dir), seconds, seconds);
    }
  };

  test("falls back when Git is unavailable and tracks the dashboard inputs", () => {
    setAll(1_700_000_000);
    const base = computeWebSourceFingerprint(web, { git: noGit });
    expect(base).toEqual({ kind: "mtime", value: "1700000000000:5" });

    // web/tests is not a production input.
    utimesSync(join(root, "web/tests/page.test.ts"), 1_800_000_000, 1_800_000_000);
    expect(computeWebSourceFingerprint(web, { git: noGit })).toEqual(base);

    utimesSync(join(root, "src/core/reader.ts"), 1_800_000_000, 1_800_000_000);
    expect(computeWebSourceFingerprint(web, { git: noGit }).value).toBe("1800000000000:5");

    setAll(1_700_000_000);
    utimesSync(join(web, "server-preload.mjs"), 1_750_000_000, 1_750_000_000);
    expect(computeWebSourceFingerprint(web, { git: noGit }).value).toBe("1750000000000:5");
  });

  test("a deleted input changes the fingerprint even when mtimes do not advance", () => {
    setAll(1_700_000_000);
    const base = computeWebSourceFingerprint(web, { git: noGit });
    rmSync(join(web, "app", "page.tsx"));
    utimesSync(join(web, "app"), 1_700_000_000, 1_700_000_000);
    expect(computeWebSourceFingerprint(web, { git: noGit }).value).not.toBe(base.value);
  });

  test("a stamp from a Git fingerprint does not match a modification-time one", () => {
    mkdirSync(webDistDir(web), { recursive: true });
    writeWebBuildStamp(webDistDir(web), { kind: "git", value: "abc" });
    const current = computeWebSourceFingerprint(web, { git: noGit });
    expect(checkWebBuildFreshness(webDistDir(web), current)).toMatchObject({
      stale: true,
      reason: "changed",
    });
  });
});

describe("freshness decision", () => {
  const noGit = () => ({ status: 128, stdout: "" });
  let web: string;

  beforeEach(() => {
    web = scaffold(root);
  });

  test("a missing build is built and stamped", () => {
    const build = fakeBuild(web);
    const lines: string[] = [];
    const result = ensureFreshWebBuild(web, build.run, (line) => lines.push(line), { git: noGit });
    expect(result).toEqual({ ok: true, rebuilt: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("rebuilding the dashboard: no production build at ");
    expect(readWebBuildStamp(join(web, ".next"))?.fingerprint).toEqual(
      computeWebSourceFingerprint(web, { git: noGit }),
    );
  });

  test("an existing build without a stamp counts as stale", () => {
    mkdirSync(join(web, ".next"));
    const build = fakeBuild(web);
    const lines: string[] = [];
    expect(ensureFreshWebBuild(web, build.run, (line) => lines.push(line), { git: noGit })).toEqual(
      { ok: true, rebuilt: true },
    );
    expect(lines).toEqual(["rebuilding the dashboard: the existing build has no source stamp"]);
  });

  test("a failed build reports failure and writes no stamp", () => {
    mkdirSync(join(web, ".next"));
    const build = fakeBuild(web, 2);
    expect(ensureFreshWebBuild(web, build.run, () => {}, { git: noGit })).toEqual({
      ok: false,
      status: 2,
      reason: "the existing build has no source stamp",
    });
    expect(existsSync(join(web, ".next", WEB_BUILD_STAMP_FILE))).toBe(false);
  });

  test("buildAndStamp stamps the fingerprint taken before the build ran", () => {
    const before = computeWebSourceFingerprint(web, { git: noGit });
    const status = buildAndStamp(
      web,
      () => {
        mkdirSync(join(web, ".next"), { recursive: true });
        // An edit landing mid-build must not be claimed by the stamp.
        writeFileSync(join(root, "src", "core", "late.ts"), "export {};\n");
        return 0;
      },
      { git: noGit },
    );
    expect(status).toBe(0);
    expect(readWebBuildStamp(join(web, ".next"))?.fingerprint).toEqual(before);
    const after = computeWebSourceFingerprint(web, { git: noGit });
    expect(checkWebBuildFreshness(join(web, ".next"), after).stale).toBe(true);
  });

  test("honors the dashboard's distDir override", () => {
    process.env.HARNERY_WEB_DIST_DIR = ".next-staging";
    expect(webDistDir(web)).toBe(join(web, ".next-staging"));
    const status = buildAndStamp(
      web,
      () => {
        mkdirSync(join(web, ".next-staging"), { recursive: true });
        return 0;
      },
      { git: noGit },
    );
    expect(status).toBe(0);
    expect(existsSync(join(web, ".next-staging", WEB_BUILD_STAMP_FILE))).toBe(true);
  });

  test("an unreadable or foreign stamp is treated as missing", () => {
    mkdirSync(join(web, ".next"));
    writeFileSync(join(web, ".next", WEB_BUILD_STAMP_FILE), "not json");
    expect(readWebBuildStamp(join(web, ".next"))).toBeNull();
    writeFileSync(join(web, ".next", WEB_BUILD_STAMP_FILE), '{ "version": 99 }');
    expect(readWebBuildStamp(join(web, ".next"))).toBeNull();
  });
});

describe("parsePorcelainZ", () => {
  test("reads plain, untracked and renamed records", () => {
    expect(parsePorcelainZ(" M web/app/page.tsx\0?? src/new.ts\0R  src/b.ts\0src/a.ts\0")).toEqual([
      { status: " M", path: "web/app/page.tsx" },
      { status: "??", path: "src/new.ts" },
      { status: "R ", path: "src/b.ts" },
    ]);
  });
});
