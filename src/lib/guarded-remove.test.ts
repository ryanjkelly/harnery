import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedRemove } from "./guarded-remove.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnery-rm-")));
  roots.push(root);
  const file = join(root, "output.mp4");
  writeFileSync(file, "output");
  return { root, file };
}

test("previews by default and dry-run wins over yes", () => {
  const { root, file } = fixture();
  expect(guardedRemove([file], { root })).toMatchObject({ applied: false, entries: 1, bytes: 6 });
  expect(guardedRemove([file], { root, yes: true, dryRun: true }).applied).toBe(false);
  expect(existsSync(file)).toBe(true);
  expect(guardedRemove([file], { root, yes: true }).applied).toBe(true);
  expect(existsSync(file)).toBe(false);
});

test("refuses empty paths, unresolved variables, globs, missing paths and unsafe roots", () => {
  const { root, file } = fixture();
  for (const path of ["", " ", "$missing/output", join(root, "*.mp4"), join(root, "missing")])
    expect(() => guardedRemove([path], { root, yes: true })).toThrow();
  for (const boundary of ["", "/", file])
    expect(() => guardedRemove([file], { root: boundary, yes: true })).toThrow();
  expect(existsSync(file)).toBe(true);
});

test("refuses scope root, sibling prefix, traversal and overlapping batches", () => {
  const { root, file } = fixture();
  const outside = fixture();
  for (const paths of [
    [root],
    [outside.file],
    [join(root, "..", outside.root.split("/").pop()!, "output.mp4")],
    [file, file],
  ])
    expect(() => guardedRemove(paths, { root, recursive: true, yes: true })).toThrow();
  expect(existsSync(file)).toBe(true);
  expect(existsSync(outside.file)).toBe(true);
});

test("refuses working directory and ancestors", () => {
  const { root } = fixture();
  const cwd = process.cwd();
  const work = join(root, "work");
  mkdirSync(work);
  try {
    process.chdir(work);
    expect(() => guardedRemove([work], { root, recursive: true, yes: true })).toThrow(
      "working directory",
    );
  } finally {
    process.chdir(cwd);
  }
});

test("requires recursive and inspects complete directories", () => {
  const { root } = fixture();
  const dir = join(root, "render");
  mkdirSync(dir);
  writeFileSync(join(dir, "frame.png"), "frame");
  expect(() => guardedRemove([dir], { root, yes: true })).toThrow("--recursive");
  expect(guardedRemove([dir], { root, recursive: true, yes: true }).entries).toBe(2);
  expect(existsSync(dir)).toBe(false);
});

test("refuses symlinks at the target and its ancestors", () => {
  const { root } = fixture();
  const outside = fixture();
  const alias = join(root, "alias");
  symlinkSync(outside.root, alias);
  for (const target of [alias, join(alias, "output.mp4")])
    expect(() => guardedRemove([target], { root, recursive: true, yes: true })).toThrow("symlink");
  expect(existsSync(outside.file)).toBe(true);
});

test("removes links inside a recursive tree as links, never following them", () => {
  const { root, file } = fixture();
  const outside = fixture();
  const dir = join(root, "render");
  mkdirSync(dir);
  symlinkSync(file, join(dir, "file-link"));
  symlinkSync(outside.root, join(dir, "dir-link"));
  const preview = guardedRemove([dir], { root, recursive: true });
  expect(preview.links).toEqual(
    expect.arrayContaining([
      { path: join(dir, "file-link"), target: file },
      { path: join(dir, "dir-link"), target: outside.root },
    ]),
  );
  expect(preview.bytes).toBe(0);
  expect(guardedRemove([dir], { root, recursive: true, yes: true }).applied).toBe(true);
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(file)).toBe(true);
  expect(existsSync(outside.file)).toBe(true);
});

test("protects state and nested repository metadata", () => {
  const { root, file } = fixture();
  for (const name of [".git", ".harnery", ".credentials", ".ssh", ".gnupg"]) {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "data"), "important");
    expect(() => guardedRemove([join(dir, "data")], { root, yes: true })).toThrow("Protected");
  }
  const nested = join(root, "nested");
  mkdirSync(nested);
  writeFileSync(join(nested, ".git"), "gitdir: elsewhere");
  expect(() => guardedRemove([nested], { root, recursive: true, yes: true })).toThrow("Protected");
  expect(existsSync(file)).toBe(true);
});

test("protects bare repositories and case variants of metadata", () => {
  const { root } = fixture();
  const bare = join(root, "bare");
  expect(spawnSync("git", ["init", "--bare", "-q", bare]).status).toBe(0);
  expect(() => guardedRemove([bare], { root, recursive: true, yes: true })).toThrow(
    "Repository metadata",
  );
  const dir = join(root, "output");
  mkdirSync(dir);
  mkdirSync(join(dir, ".GIT"));
  expect(() => guardedRemove([dir], { root, recursive: true, yes: true })).toThrow("Protected");
});

test("protects tracked files and directories that contain them, including deleted staged paths", () => {
  const { root, file } = fixture();
  expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "add", "--", file]).status).toBe(0);
  const dir = join(root, "source");
  mkdirSync(dir);
  writeFileSync(join(dir, "index.ts"), "source");
  expect(spawnSync("git", ["-C", root, "add", "source"]).status).toBe(0);
  for (const path of [file, dir])
    expect(() => guardedRemove([path], { root, recursive: true, yes: true })).toThrow(
      "Tracked files",
    );
  const output = join(root, "render.tmp");
  writeFileSync(output, "generated");
  expect(guardedRemove([output], { root, yes: true }).applied).toBe(true);
});

test("preflights all targets before mutation", () => {
  const { root, file } = fixture();
  expect(() => guardedRemove([file, join(root, "missing")], { root, yes: true })).toThrow();
  expect(existsSync(file)).toBe(true);
});

test("rechecks file changes and peer claims before applying", () => {
  const { root, file } = fixture();
  expect(() =>
    guardedRemove([file], { root, yes: true }, () => writeFileSync(file, "changed")),
  ).toThrow("changed");
  let calls = 0;
  expect(() =>
    guardedRemove([file], { root, yes: true }, () => {
      if (++calls === 2) throw new Error("peer claimed it");
    }),
  ).toThrow("peer claimed");
  expect(existsSync(file)).toBe(true);
});

test("refuses entries added after inspection", () => {
  const { root } = fixture();
  const dir = join(root, "render");
  mkdirSync(dir);
  expect(() =>
    guardedRemove([dir], { root, recursive: true, yes: true }, () =>
      writeFileSync(join(dir, "late"), "retain"),
    ),
  ).toThrow("changed");
  expect(existsSync(join(dir, "late"))).toBe(true);
});

function stateDir(root: string, parent: string, name: string) {
  const dir = join(root, parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "data"), "secret");
  return dir;
}

test("a protected path inside a target needs its own --allow-protected", () => {
  const { root } = fixture();
  const creds = stateDir(root, "copy", ".credentials");
  const copy = join(root, "copy");
  expect(() => guardedRemove([copy], { root, recursive: true, yes: true })).toThrow(
    `--allow-protected ${creds}`,
  );
  const preview = guardedRemove([copy], { root, recursive: true, allowProtected: [creds] });
  expect(preview.protected).toEqual([creds]);
  expect(existsSync(creds)).toBe(true);
  expect(
    guardedRemove([copy], { root, recursive: true, yes: true, allowProtected: [creds] }).applied,
  ).toBe(true);
  expect(existsSync(copy)).toBe(false);
});

test("naming one protected path does not allow another", () => {
  const { root } = fixture();
  const creds = stateDir(root, "copy", ".credentials");
  stateDir(root, "copy", ".ssh");
  stateDir(root, "copy/.credentials", ".gnupg");
  expect(() =>
    guardedRemove([join(root, "copy")], {
      root,
      recursive: true,
      yes: true,
      allowProtected: [creds],
    }),
  ).toThrow("Protected state");
  expect(existsSync(creds)).toBe(true);
});

test("a protected path can be the target itself", () => {
  const { root } = fixture();
  const creds = stateDir(root, "copy", ".credentials");
  expect(
    guardedRemove([creds], { root, recursive: true, yes: true, allowProtected: [creds] }).protected,
  ).toEqual([creds]);
  expect(existsSync(creds)).toBe(false);
});

test("--allow-protected must name a protected path that a target removes, inside the root", () => {
  const { root, file } = fixture();
  const outside = fixture();
  const creds = stateDir(root, "copy", ".credentials");
  const outsideCreds = stateDir(outside.root, "x", ".credentials");
  const other = stateDir(root, "other", ".credentials");
  const copy = join(root, "copy");
  const opts = (allowProtected: string[]) => ({ root, recursive: true, yes: true, allowProtected });
  expect(() => guardedRemove([copy], opts([creds, join(creds, "data")]))).toThrow(
    "must name a protected path",
  );
  expect(() => guardedRemove([copy], opts([creds, other]))).toThrow("no target removes");
  expect(() => guardedRemove([copy], opts([creds, outsideCreds]))).toThrow(
    "strictly inside --root",
  );
  expect(() => guardedRemove([copy], opts([join(root, "copy", "*")]))).toThrow("wildcards");
  expect(() => guardedRemove([copy], opts([join(root, "missing", ".git")]))).toThrow();
  expect(existsSync(creds)).toBe(true);
  expect(existsSync(file)).toBe(true);
});

test("--allow-protected refuses a path reached through a symlink", () => {
  const { root } = fixture();
  stateDir(root, "real", ".credentials");
  symlinkSync(join(root, "real"), join(root, "alias"));
  expect(() =>
    guardedRemove([join(root, "real")], {
      root,
      recursive: true,
      yes: true,
      allowProtected: [join(root, "alias", ".credentials")],
    }),
  ).toThrow("symlink");
});

function git(args: string[]) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  expect(result.status).toBe(0);
  return result;
}

test("an allowed .git is refused while it holds commits found on no remote", () => {
  const { root } = fixture();
  const clone = join(root, "clone");
  git(["init", "-q", clone]);
  writeFileSync(join(clone, "a.txt"), "a");
  git(["-C", clone, "add", "a.txt"]);
  git(["-C", clone, "commit", "-qm", "local only"]);
  const gitDir = join(clone, ".git");
  expect(() => guardedRemove([clone], { root, recursive: true, allowProtected: [gitDir] })).toThrow(
    "not on any remote",
  );
  expect(existsSync(gitDir)).toBe(true);
});

test("an allowed .git whose commits are all on a remote can be removed", () => {
  const { root } = fixture();
  const remote = join(root, "remote.git");
  git(["init", "-q", "--bare", remote]);
  const clone = join(root, "clone");
  git(["init", "-q", clone]);
  writeFileSync(join(clone, "a.txt"), "a");
  git(["-C", clone, "add", "a.txt"]);
  git(["-C", clone, "commit", "-qm", "pushed"]);
  git(["-C", clone, "remote", "add", "origin", remote]);
  git(["-C", clone, "push", "-q", "origin", "HEAD:refs/heads/main"]);
  git(["-C", clone, "fetch", "-q", "origin"]);
  const gitDir = join(clone, ".git");
  const report = guardedRemove([clone], {
    root,
    recursive: true,
    yes: true,
    allowProtected: [gitDir],
  });
  expect(report.protected).toEqual([gitDir]);
  expect(existsSync(clone)).toBe(false);
  expect(existsSync(remote)).toBe(true);
});

test("a bare repository can be named, and is checked for unpushed history", () => {
  const { root } = fixture();
  const bare = join(root, "bare");
  git(["init", "-q", "--bare", bare]);
  expect(
    guardedRemove([bare], { root, recursive: true, yes: true, allowProtected: [bare] }).protected,
  ).toEqual([bare]);
  expect(existsSync(bare)).toBe(false);
});

test("a live workspace's own Git metadata and Harnery state can never be allowed", () => {
  const { root } = fixture();
  const live = join(root, "live");
  const gitDir = stateDir(root, "live", ".git");
  const harnery = stateDir(root, "live", ".harnery");
  const nested = stateDir(root, "live/.git", "modules");
  for (const path of [gitDir, harnery])
    expect(() =>
      guardedRemove([path], {
        root,
        recursive: true,
        yes: true,
        allowProtected: [path],
        liveRoots: [live],
      }),
    ).toThrow("live workspace");
  expect(() =>
    guardedRemove([nested], {
      root,
      recursive: true,
      yes: true,
      allowProtected: [nested],
      liveRoots: [live],
    }),
  ).toThrow();
  expect(existsSync(gitDir)).toBe(true);
  expect(existsSync(harnery)).toBe(true);
});

test("files inside an artifact workspace can be removed; the workspace record and other state cannot", () => {
  const { root } = fixture();
  const workspace = join(root, ".harnery", "artifacts", "2026-10-03_check_abc123");
  mkdirSync(join(workspace, "profile"), { recursive: true });
  writeFileSync(join(workspace, "profile", "cookies"), "jar");
  writeFileSync(join(workspace, "pw.txt"), "secret");
  writeFileSync(join(workspace, "shot.png"), "png");
  writeFileSync(join(workspace, ".harnery-artifact.json"), "{}");
  writeFileSync(join(root, ".harnery", "state.json"), "{}");
  const report = guardedRemove([join(workspace, "profile"), join(workspace, "pw.txt")], {
    root: workspace,
    recursive: true,
    yes: true,
  });
  expect(report.applied).toBe(true);
  expect(existsSync(join(workspace, "profile"))).toBe(false);
  expect(existsSync(join(workspace, "pw.txt"))).toBe(false);
  expect(existsSync(join(workspace, "shot.png"))).toBe(true);
  expect(() =>
    guardedRemove([join(workspace, ".harnery-artifact.json")], { root: workspace, yes: true }),
  ).toThrow("record");
  expect(() =>
    guardedRemove([workspace], {
      root: join(root, ".harnery", "artifacts"),
      recursive: true,
      yes: true,
    }),
  ).toThrow("Protected state contains this path");
  expect(() => guardedRemove([join(root, ".harnery", "state.json")], { root, yes: true })).toThrow(
    "Protected state",
  );
  expect(existsSync(join(root, ".harnery", "state.json"))).toBe(true);
});

test("an ancestor's protected state is named as the container, without a misleading override hint", () => {
  const { root } = fixture();
  const dir = join(root, ".credentials", "sub");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "key"), "k");
  let message = "";
  try {
    guardedRemove([join(dir, "key")], { root, yes: true });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain(`Protected state contains this path: ${join(root, ".credentials")}`);
  expect(message).not.toContain("--allow-protected");
});
