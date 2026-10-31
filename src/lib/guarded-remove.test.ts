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
import { guardedRemove, type RemoveOptions } from "./guarded-remove.ts";

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

test("resolves relative targets and --allow-protected under --root, not the cwd", () => {
  const { root, file } = fixture();
  const elsewhere = fixture();
  const cwd = process.cwd();
  mkdirSync(join(root, "copy", ".credentials"), { recursive: true });
  mkdirSync(join(elsewhere.root, "copy", ".credentials"), { recursive: true });
  try {
    // A decoy with the same relative name sits in the cwd; it must never be targeted.
    process.chdir(elsewhere.root);
    // (d) Preview resolves under root and deletes nothing.
    expect(guardedRemove(["output.mp4"], { root })).toMatchObject({
      applied: false,
      targets: [file],
    });
    expect(existsSync(file)).toBe(true);
    // (c) A relative path escaping root is refused.
    for (const escape of ["../x", `../${elsewhere.root.split("/").pop()}/output.mp4`])
      expect(() => guardedRemove([escape], { root, yes: true })).toThrow();
    // Relative --allow-protected resolves under root too.
    expect(
      guardedRemove(["copy"], {
        root,
        recursive: true,
        allowProtected: ["copy/.credentials"],
      }).protected,
    ).toEqual([join(root, "copy", ".credentials")]);
    // (a) Applying removes the root's file and leaves the cwd decoy alone.
    expect(guardedRemove(["output.mp4"], { root, yes: true })).toMatchObject({
      applied: true,
      targets: [file],
    });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(elsewhere.file)).toBe(true);
    expect(existsSync(join(elsewhere.root, "copy", ".credentials"))).toBe(true);
  } finally {
    process.chdir(cwd);
  }
  // (b) Absolute targets are unchanged, including one outside root.
  const absolute = fixture();
  expect(() => guardedRemove([elsewhere.file], { root: absolute.root, yes: true })).toThrow(
    "strictly inside --root",
  );
  expect(guardedRemove([absolute.file], { root: absolute.root, yes: true }).targets).toEqual([
    absolute.file,
  ]);
  expect(existsSync(elsewhere.file)).toBe(true);
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

function cleanCloneFixture() {
  const { root } = fixture();
  const artifact = join(root, ".harnery", "artifacts", "owned");
  mkdirSync(artifact, { recursive: true });
  const remote = join(root, "remote.git");
  git(["init", "-q", "--bare", remote]);
  const clone = join(artifact, "clone");
  git(["init", "-q", clone]);
  writeFileSync(join(clone, "a.txt"), "a");
  git(["-C", clone, "add", "a.txt"]);
  git(["-C", clone, "commit", "-qm", "pushed"]);
  git(["-C", clone, "remote", "add", "origin", remote]);
  git(["-C", clone, "push", "-q", "origin", "HEAD:refs/heads/main"]);
  git(["-C", clone, "fetch", "-q", "origin"]);
  const options: RemoveOptions = {
    root: artifact,
    recursive: true,
    cleanClone: true,
    liveRoots: [root],
    assertOwnedArtifact: (path) => {
      if (path !== artifact) throw new Error("not owned");
    },
  };
  return { root, artifact, remote, clone, options };
}

test("clean clone mode previews and prunes only the clone, retaining surrounding evidence and links", () => {
  const { artifact, remote, clone, options } = cleanCloneFixture();
  const record = join(artifact, ".harnery-artifact.json");
  const evidence = join(artifact, "final.json");
  writeFileSync(record, '{"holds":["review"]}');
  writeFileSync(evidence, "retained");
  // Tracked links are part of a clean checkout; their external targets are not removed.
  symlinkSync(remote, join(clone, "remote-link"));
  git(["-C", clone, "add", "remote-link"]);
  git(["-C", clone, "commit", "-qm", "link"]);
  git(["-C", clone, "push", "-q", "origin", "HEAD:refs/heads/main"]);
  const preview = guardedRemove([clone], options);
  expect(preview.applied).toBe(false);
  expect(preview.protected).toEqual([join(clone, ".git")]);
  expect(preview.links).toEqual([{ path: join(clone, "remote-link"), target: remote }]);
  expect(guardedRemove([clone], { ...options, yes: true, dryRun: true }).applied).toBe(false);
  expect(guardedRemove([clone], { ...options, yes: true }).applied).toBe(true);
  for (const retained of [artifact, record, evidence, remote])
    expect(existsSync(retained)).toBe(true);
  expect(existsSync(clone)).toBe(false);
});

for (const kind of [
  "modified",
  "staged",
  "untracked",
  "detached",
  "branch",
  "tag",
  "reflog",
  "stash",
  "worktree",
]) {
  test(`clean clone mode refuses ${kind} work before removing any target`, () => {
    const { root, clone, options } = cleanCloneFixture();
    if (["modified", "staged", "untracked"].includes(kind)) {
      writeFileSync(join(clone, kind === "untracked" ? "new.txt" : "a.txt"), "uncommitted");
      if (kind === "staged") git(["-C", clone, "add", "a.txt"]);
    } else if (kind === "stash") {
      writeFileSync(join(clone, "a.txt"), "stashed work");
      git(["-C", clone, "stash", "push", "-qm", "unique work"]);
    } else if (kind === "worktree") {
      git(["-C", clone, "worktree", "add", "-q", "-b", "linked", join(root, "linked")]);
    } else {
      const original = git(["-C", clone, "rev-parse", "HEAD"]).stdout.trim();
      git(["-C", clone, "checkout", "-q", "--detach"]);
      writeFileSync(join(clone, "a.txt"), "local only");
      git(["-C", clone, "add", "a.txt"]);
      git(["-C", clone, "commit", "-qm", "local only"]);
      if (kind === "branch") git(["-C", clone, "branch", "local-only"]);
      if (kind === "tag") git(["-C", clone, "tag", "local-only"]);
      if (kind !== "detached") git(["-C", clone, "checkout", "-q", "--detach", original]);
    }
    expect(() => guardedRemove([clone], { ...options, yes: true })).toThrow(
      ["modified", "staged", "untracked"].includes(kind)
        ? "uncommitted or untracked"
        : kind === "worktree"
          ? "registered or linked worktrees"
          : "not on any remote",
    );
    expect(existsSync(join(clone, ".git"))).toBe(true);
  });
}

test("clean clone mode rechecks ownership, clone state and peer claims before mutation", () => {
  for (const changed of ["owner", "file", "peer"]) {
    const { clone, options } = cleanCloneFixture();
    let checks = 0;
    const assertOwned = options.assertOwnedArtifact!;
    options.assertOwnedArtifact = (path) => {
      assertOwned(path);
      if (changed === "owner" && checks > 0) throw new Error("owner changed");
    };
    expect(() =>
      guardedRemove([clone], { ...options, yes: true }, () => {
        checks++;
        if (changed === "file") writeFileSync(join(clone, "a.txt"), "changed during inspection");
        if (changed === "peer" && checks === 2) throw new Error("peer claim");
      }),
    ).toThrow();
    expect(existsSync(clone)).toBe(true);
  }
});

test("clean clone mode needs its exact artifact authority and does not allow other protected state", () => {
  const { clone, options } = cleanCloneFixture();
  expect(() => guardedRemove([clone], { ...options, assertOwnedArtifact: undefined })).toThrow(
    "caller-owned",
  );
  expect(() => guardedRemove([clone], { ...options, recursive: false })).toThrow("--recursive");
  expect(() =>
    guardedRemove([clone], { ...options, allowProtected: [join(clone, ".git")] }),
  ).toThrow("cannot be combined");
  mkdirSync(join(clone, ".credentials"));
  writeFileSync(join(clone, ".credentials", "key"), "copy");
  git(["-C", clone, "add", ".credentials/key"]);
  git(["-C", clone, "commit", "-qm", "copied state"]);
  git(["-C", clone, "push", "-q", "origin", "HEAD:refs/heads/main"]);
  expect(() => guardedRemove([clone], { ...options, yes: true })).toThrow("Protected state");
  expect(existsSync(clone)).toBe(true);
});

test("clean clone mode accepts a published detached HEAD and validates every nested clone", () => {
  const { clone, options, remote } = cleanCloneFixture();
  git(["-C", clone, "checkout", "-q", "--detach"]);
  // A disposable build can contain an independently cloned ignored dependency.
  writeFileSync(join(clone, ".git", "info", "exclude"), "nested/\n");
  const nested = join(clone, "nested");
  git(["clone", "-q", "--branch", "main", remote, nested]);
  writeFileSync(join(nested, "a.txt"), "local nested change");
  expect(() => guardedRemove([clone], { ...options, yes: true })).toThrow(
    "uncommitted or untracked",
  );
  expect(existsSync(clone)).toBe(true);
  git(["-C", nested, "restore", "a.txt"]);
  expect(guardedRemove([clone], { ...options, yes: true }).protected).toEqual(
    [join(clone, ".git"), join(nested, ".git")].sort(),
  );
  expect(existsSync(clone)).toBe(false);
  expect(existsSync(remote)).toBe(true);
});

test("clean clone mode refuses a linked worktree target with a gitdir file", () => {
  const { clone, artifact, options } = cleanCloneFixture();
  const linked = join(artifact, "linked");
  git(["-C", clone, "worktree", "add", "-q", "-b", "linked", linked]);
  expect(() => guardedRemove([linked], { ...options, yes: true })).toThrow(
    "standalone .git directory",
  );
  expect(existsSync(linked)).toBe(true);
  expect(existsSync(clone)).toBe(true);
});

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

function artifactCopy() {
  const { root: live } = fixture();
  const workspace = join(live, ".harnery", "artifacts", "owned-copy");
  const copy = join(workspace, "snapshot", ".harnery");
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, "state.json"), "copied");
  const record = join(workspace, ".harnery-artifact.json");
  writeFileSync(record, "owner record");
  const options = {
    root: workspace,
    recursive: true,
    allowProtected: [copy],
    liveRoots: [live],
    assertOwnedArtifact: (root: string) => {
      expect(root).toBe(workspace);
    },
  };
  return { live, workspace, copy, record, options };
}

test("an explicitly named copied state in an owned artifact previews and removes only the copy", () => {
  const { workspace, copy, record, options } = artifactCopy();
  const other = join(workspace, "keep.txt");
  writeFileSync(other, "keep");
  expect(guardedRemove([copy], options)).toMatchObject({ applied: false, protected: [copy] });
  expect(guardedRemove([copy], { ...options, yes: true, dryRun: true }).applied).toBe(false);
  expect(existsSync(copy)).toBe(true);
  expect(guardedRemove([copy], { ...options, yes: true }).applied).toBe(true);
  expect(existsSync(copy)).toBe(false);
  expect(existsSync(record)).toBe(true);
  expect(existsSync(other)).toBe(true);
});

test("copied live-state descendants require verified ownership and the exact artifact root", () => {
  const { live, workspace, copy, options } = artifactCopy();
  expect(() => guardedRemove([copy], { ...options, assertOwnedArtifact: undefined })).toThrow(
    "live workspace",
  );
  expect(() =>
    guardedRemove([copy], {
      ...options,
      assertOwnedArtifact: () => {
        throw new Error("unowned artifact");
      },
    }),
  ).toThrow("unowned artifact");
  for (const root of [live, join(workspace, "snapshot")])
    expect(() => guardedRemove([copy], { ...options, root })).toThrow("live workspace");
  expect(() => guardedRemove([copy], { ...options, allowProtected: [] })).toThrow("Protected");
  expect(existsSync(copy)).toBe(true);
});

test("owned-copy exception cannot remove actual live state, aliases, other protected state or artifact records", () => {
  const { live, workspace, copy, record, options } = artifactCopy();
  const alias = join(fixture().root, "live-alias");
  symlinkSync(live, alias);
  const liveState = join(live, ".harnery");
  for (const liveRoots of [[live], [alias]])
    expect(() =>
      guardedRemove([liveState], {
        ...options,
        root: live,
        allowProtected: [liveState],
        liveRoots,
      }),
    ).toThrow("live workspace");
  const gitState = stateDir(live, ".harnery/artifacts/owned-copy/snapshot", ".git");
  const credentials = stateDir(live, ".harnery/artifacts/owned-copy/snapshot", ".credentials");
  for (const path of [gitState, credentials])
    expect(() => guardedRemove([path], { ...options, allowProtected: [path] })).toThrow(
      "live workspace",
    );
  expect(() =>
    guardedRemove([copy], {
      ...options,
      liveRoots: [live, join(workspace, "snapshot")],
    }),
  ).toThrow("live workspace");
  expect(() => guardedRemove([record], { ...options, allowProtected: [] })).toThrow("record");
  expect(() =>
    guardedRemove([workspace], {
      ...options,
      root: join(live, ".harnery", "artifacts"),
      allowProtected: [],
    }),
  ).toThrow("Protected");
  expect(existsSync(copy)).toBe(true);
  expect(existsSync(record)).toBe(true);
});

test("owned copied state remains subject to symlink, tracked-file and peer-claim controls", () => {
  const { live, workspace, copy, options } = artifactCopy();
  const alias = join(workspace, "alias");
  symlinkSync(join(workspace, "snapshot"), alias);
  expect(() =>
    guardedRemove([copy], {
      ...options,
      allowProtected: [join(alias, ".harnery")],
    }),
  ).toThrow("symlink");
  expect(() =>
    guardedRemove([copy], options, () => {
      throw new Error("peer claim");
    }),
  ).toThrow("peer claim");
  git(["init", "-q", live]);
  git(["-C", live, "add", "--", join(copy, "state.json")]);
  expect(() => guardedRemove([copy], options)).toThrow("Tracked files");
  expect(existsSync(copy)).toBe(true);
});

test("artifact ownership is checked again before applying an inspected copy removal", () => {
  const { copy, options } = artifactCopy();
  let owned = true;
  expect(() =>
    guardedRemove(
      [copy],
      {
        ...options,
        yes: true,
        assertOwnedArtifact: () => {
          if (!owned) throw new Error("ownership released");
        },
      },
      () => {
        owned = false;
      },
    ),
  ).toThrow("ownership released");
  expect(existsSync(copy)).toBe(true);
});

test("owned copied state cannot bypass the 10000-entry inspection limit", () => {
  const { copy, options } = artifactCopy();
  for (let i = 0; i < 10_000; i++) writeFileSync(join(copy, `entry-${i}`), "x");
  expect(() => guardedRemove([copy], { ...options, yes: true })).toThrow("10000-entry limit");
  expect(existsSync(copy)).toBe(true);
});

test("entry limits allow a finite larger batch only after verifying artifact ownership", () => {
  const { workspace, record, options } = artifactCopy();
  const large = join(workspace, "large-output");
  mkdirSync(large);
  for (let i = 0; i < 10_000; i++) writeFileSync(join(large, `entry-${i}`), "x");
  const bounded = { ...options, allowProtected: [], entryLimit: 10_001 };
  expect(() => guardedRemove([large], { ...bounded, entryLimit: undefined })).toThrow(
    "10000-entry limit",
  );
  expect(guardedRemove([large], bounded)).toMatchObject({
    applied: false,
    entries: 10_001,
    entry_limit: 10_001,
  });
  expect(existsSync(large)).toBe(true);
  expect(guardedRemove([large], { ...bounded, yes: true }).applied).toBe(true);
  expect(existsSync(large)).toBe(false);
  expect(existsSync(record)).toBe(true);
});

test("entry limits reject invalid bounds and require ownership even for small targets", () => {
  const { root, file } = fixture();
  for (const entryLimit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 100_001])
    expect(() => guardedRemove([file], { root, entryLimit })).toThrow("entry limit");
  expect(() => guardedRemove([file], { root, entryLimit: 10_001 })).toThrow(
    "owned managed artifact",
  );
  expect(() =>
    guardedRemove([file], {
      root,
      entryLimit: 10_001,
      assertOwnedArtifact: () => {
        throw new Error("not current owner");
      },
    }),
  ).toThrow("not current owner");
  expect(existsSync(file)).toBe(true);
});

test("entry limits recheck ownership and retain every other removal protection", () => {
  const { workspace, record, options } = artifactCopy();
  const file = join(workspace, "output.txt");
  writeFileSync(file, "keep until verified");
  let owned = true;
  const bounded = {
    ...options,
    allowProtected: [],
    entryLimit: 100_000,
    yes: true,
    assertOwnedArtifact: () => {
      if (!owned) throw new Error("ownership released");
    },
  };
  expect(() =>
    guardedRemove([file], bounded, () => {
      owned = false;
    }),
  ).toThrow("ownership released");
  owned = true;
  expect(() =>
    guardedRemove([file], bounded, () => {
      throw new Error("peer claim");
    }),
  ).toThrow("peer claim");
  expect(() => guardedRemove([record], bounded)).toThrow("record");
  expect(existsSync(file)).toBe(true);
  expect(existsSync(record)).toBe(true);
});
