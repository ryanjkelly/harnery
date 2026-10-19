import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fsyncParentDirectory, stableDigest } from "../workflow/durable-record.ts";
import {
  assertSafeRelativeSegment,
  containsPath,
  descriptorPath,
  filesystemIdentity,
  sameFilesystemIdentity,
} from "../workflow/workspaces/paths.ts";
import type { WorkspaceBinding } from "../workflow/workspaces/types.ts";

export const SNAPSHOT_LIMIT = 8 * 1024 * 1024;
export interface BlobEntry {
  oid: string;
  mode: "100644" | "100755";
}
export interface ContentEntry {
  path: string;
  index: BlobEntry | null;
  worktree: BlobEntry | null;
  untracked: boolean;
}
export interface ContentSnapshot {
  head: string;
  index_tree: string;
  worktree_tree: string;
  entries: ContentEntry[];
  total_bytes: number;
  sha256: string;
}
interface ObservedContent {
  entries: ContentEntry[];
  blobs: Map<string, Buffer>;
  total: number;
  head: string;
}

export function git(
  root: string,
  args: string[],
  options: { input?: Buffer | string; index?: string; bare?: boolean } = {},
): Buffer {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_LITERAL_PATHSPECS: "1",
  });
  if (args[0] === "check-ignore") delete env.GIT_LITERAL_PATHSPECS;
  if (options.index) env.GIT_INDEX_FILE = options.index;
  return execFileSync(
    "git",
    [options.bare ? `--git-dir=${root}` : "-C", ...(options.bare ? [] : [root]), ...args],
    {
      env,
      input: options.input,
      maxBuffer: SNAPSHOT_LIMIT + 1024 * 1024,
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}
export function textGit(root: string, args: string[], options?: Parameters<typeof git>[2]): string {
  return git(root, args, options).toString("utf8").trim();
}

export function safePaths(binding: WorkspaceBinding, paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100)
    throw new Error("path count limit is 1 to 100");
  const normalized = paths
    .map((path) => {
      if (typeof path !== "string" || path.length > 2000) throw new Error("invalid content path");
      for (const part of path.split("/")) {
        assertSafeRelativeSegment(part, "content path");
        if ([".git", ".harnery"].includes(part.toLowerCase()))
          throw new Error("administrative content path is forbidden");
      }
      if (
        relative(binding.workspace_root, resolve(binding.workspace_root, path)).replaceAll(
          "\\",
          "/",
        ) !== path
      )
        throw new Error("content path escapes workspace");
      return path;
    })
    .sort();
  if (new Set(normalized).size !== normalized.length) throw new Error("duplicate content paths");
  for (const path of normalized) {
    const opened = openParent(binding, path);
    opened.close();
  }
  return normalized;
}

export function openParent(
  binding: WorkspaceBinding,
  path: string,
): { path: string; close(): void } {
  const fds: number[] = [];
  try {
    const root = binding.workspace_root;
    let fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fds.push(fd);
    if (
      !sameFilesystemIdentity(
        filesystemIdentity(descriptorPath(fd)),
        binding.workspace_root_identity,
      )
    )
      throw new Error("workspace root identity changed");
    for (const segment of path.split("/").slice(0, -1)) {
      fd = openSync(
        join(descriptorPath(fd), segment),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      fds.push(fd);
      if (existsSync(join(descriptorPath(fd), ".git")))
        throw new Error("nested repository boundary is forbidden");
    }
    const parent = descriptorPath(fd);
    const real = realpathSync(parent);
    if (!containsPath(root, real)) throw new Error("content parent escaped workspace");
    for (const reserved of [
      binding.repository?.gitdir.realpath,
      binding.repository?.common_dir.realpath,
    ]) {
      if (reserved && containsPath(reserved, real))
        throw new Error("Git administrative content is forbidden");
    }
    return {
      path: join(parent, path.split("/").at(-1)!),
      close: () => {
        for (const handle of fds.reverse()) closeSync(handle);
      },
    };
  } catch (error) {
    for (const fd of fds.reverse()) closeSync(fd);
    throw error;
  }
}

function bytesAt(
  binding: WorkspaceBinding,
  path: string,
): { bytes: Buffer; mode: BlobEntry["mode"] } | null {
  const parent = openParent(binding, path);
  try {
    let stat: import("node:fs").Stats;
    try {
      stat = lstatSync(parent.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("content must be an unlinked regular file");
    if (stat.size > SNAPSHOT_LIMIT) throw new Error("snapshot byte limit exceeded");
    const fd = openSync(parent.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = fstatSync(fd);
      if (
        !current.isFile() ||
        current.nlink !== 1 ||
        current.ino !== stat.ino ||
        current.dev !== stat.dev
      )
        throw new Error("content identity changed");
      const bytes = readFileSync(fd);
      const after = fstatSync(fd);
      if (
        after.size !== current.size ||
        after.mtimeMs !== current.mtimeMs ||
        after.ctimeMs !== current.ctimeMs
      )
        throw new Error("content changed during capture");
      return { bytes, mode: current.mode & 0o111 ? "100755" : "100644" };
    } finally {
      closeSync(fd);
    }
  } finally {
    parent.close();
  }
}

function indexEntries(
  binding: WorkspaceBinding,
  paths: string[],
): Map<string, { mode: BlobEntry["mode"]; source: string }> {
  const root = binding.workspace_root;
  if (textGit(root, ["rev-parse", "--shared-index-path"]))
    throw new Error("split index is unsupported");
  try {
    if (textGit(root, ["config", "--bool", "index.sparse"]) === "true")
      throw new Error("sparse index is unsupported");
  } catch (error) {
    if (!(error && typeof error === "object" && "status" in error && error.status === 1))
      throw error;
  }
  const flags = git(root, ["ls-files", "-v", "-z", "--", ...paths])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (flags.some((flag) => !flag.startsWith("H ")))
    throw new Error("selected index flags are unsupported");
  const entries = new Map<string, { mode: BlobEntry["mode"]; source: string }>();
  const debugFlags = git(root, ["ls-files", "--debug", "-z", "--", ...paths]).toString("utf8");
  for (const match of debugFlags.matchAll(/flags: ([a-f0-9]+)\n/g)) {
    if ((Number.parseInt(match[1]!, 16) & 0x20000000) !== 0)
      throw new Error("intent-to-add index entries are unsupported");
  }
  for (const line of git(root, ["ls-files", "--stage", "-z", "--", ...paths])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)) {
    const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t(.+)$/.exec(line);
    if (!match || /^0+$/.test(match[2]!) || !paths.includes(match[3]!))
      throw new Error("unsupported index entry");
    entries.set(match[3]!, { mode: match[1] as BlobEntry["mode"], source: match[2]! });
  }
  return entries;
}

export function observe(
  binding: WorkspaceBinding,
  store: string,
  paths: string[],
): ObservedContent {
  const staged = indexEntries(binding, paths);
  const blobs = new Map<string, Buffer>();
  let total = 0;
  const blob = (bytes: Buffer, mode: BlobEntry["mode"]): BlobEntry => {
    total += bytes.length;
    if (total > SNAPSHOT_LIMIT) throw new Error("snapshot byte limit exceeded");
    const oid = textGit(store, ["hash-object", "--stdin"], { bare: true, input: bytes });
    blobs.set(oid, bytes);
    return { oid, mode };
  };
  const entries = paths.map((path): ContentEntry => {
    const index = staged.get(path);
    const worktree = bytesAt(binding, path);
    // check-ignore without --no-index only reports untracked ignored paths.
    if (!index) {
      try {
        git(binding.workspace_root, ["check-ignore", "-q", "--", path]);
        throw new Error("ignored content path is forbidden");
      } catch (error) {
        if (!(error && typeof error === "object" && "status" in error && error.status === 1))
          throw error;
      }
    }
    return {
      path,
      index: index
        ? blob(git(binding.workspace_root, ["cat-file", "blob", index.source]), index.mode)
        : null,
      worktree: worktree ? blob(worktree.bytes, worktree.mode) : null,
      untracked: !index && worktree !== null,
    };
  });
  return { entries, blobs, total, head: textGit(binding.workspace_root, ["rev-parse", "HEAD"]) };
}

function tree(store: string, entries: ContentEntry[], side: "index" | "worktree"): string {
  const temporary = join(dirname(store), `tree-${randomUUID()}.index`);
  try {
    git(store, ["read-tree", "--empty"], { bare: true, index: temporary });
    for (const entry of entries) {
      const blob = entry[side];
      if (blob)
        git(
          store,
          ["update-index", "--add", "--cacheinfo", `${blob.mode},${blob.oid},${entry.path}`],
          { bare: true, index: temporary },
        );
    }
    return textGit(store, ["write-tree"], { bare: true, index: temporary });
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function persistSnapshot(
  store: string,
  observed: ObservedContent,
  ref: string,
): ContentSnapshot {
  for (const bytes of observed.blobs.values())
    git(store, ["hash-object", "-w", "--stdin"], { bare: true, input: bytes });
  const basis = {
    head: observed.head,
    entries: observed.entries,
    total_bytes: observed.total,
    index_tree: tree(store, observed.entries, "index"),
    worktree_tree: tree(store, observed.entries, "worktree"),
  };
  for (const side of ["index", "worktree"] as const)
    git(store, ["update-ref", `refs/turns/${ref}/${side}`, basis[`${side}_tree`]], { bare: true });
  return { ...basis, sha256: stableDigest(basis) };
}

export function verifySnapshot(store: string, snapshot: ContentSnapshot): void {
  const { sha256, ...basis } = snapshot;
  if (
    sha256 !== stableDigest(basis) ||
    !Number.isSafeInteger(snapshot.total_bytes) ||
    snapshot.total_bytes < 0 ||
    snapshot.total_bytes > SNAPSHOT_LIMIT
  )
    throw new Error("snapshot digest or byte limit changed");
  let total = 0;
  for (const side of ["index", "worktree"] as const) {
    const actual = git(store, ["ls-tree", "-r", "-z", snapshot[`${side}_tree`]], { bare: true })
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    const expected = snapshot.entries
      .filter((entry) => entry[side])
      .map((entry) => `${entry[side]!.mode} blob ${entry[side]!.oid}\t${entry.path}`)
      .sort();
    if (stableDigest(actual) !== stableDigest(expected)) throw new Error("snapshot tree changed");
    for (const entry of snapshot.entries) {
      const blob = entry[side];
      if (blob) {
        const bytes = git(store, ["cat-file", "blob", blob.oid], { bare: true });
        if (textGit(store, ["hash-object", "--stdin"], { bare: true, input: bytes }) !== blob.oid)
          throw new Error("snapshot blob digest changed");
        total += bytes.length;
      }
    }
  }
  if (total !== snapshot.total_bytes) throw new Error("snapshot byte count changed");
}

export function currentMatches(
  binding: WorkspaceBinding,
  store: string,
  snapshot: ContentSnapshot,
): boolean {
  const current = observe(
    binding,
    store,
    snapshot.entries.map((entry) => entry.path),
  );
  return (
    current.head === snapshot.head &&
    stableDigest(current.entries) === stableDigest(snapshot.entries)
  );
}

export interface IndexLock {
  path: string;
  privatePath: string;
  publish(): void;
  close(): void;
}
export function lockIndex(binding: WorkspaceBinding, state: string): IndexLock {
  const path = join(binding.repository!.gitdir.realpath, "index");
  const lock = `${path}.lock`;
  const fd = openSync(lock, "wx", 0o600);
  const identity = fstatSync(fd, { bigint: true });
  const privatePath = join(state, `live-${randomUUID()}.index`);
  let published = false;
  const exact = () => {
    const current = lstatSync(lock, { bigint: true });
    if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino)
      throw new Error("Git index lock changed");
  };
  try {
    writeFileSync(privatePath, readFileSync(path), { flag: "wx", mode: 0o600 });
  } catch (error) {
    closeSync(fd);
    exact();
    unlinkSync(lock);
    throw error;
  }
  return {
    path,
    privatePath,
    publish() {
      exact();
      writeFileSync(fd, readFileSync(privatePath));
      fsyncSync(fd);
      exact();
      renameSync(lock, path);
      published = true;
      const dir = openSync(dirname(path), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    },
    close() {
      closeSync(fd);
      if (!published) {
        exact();
        unlinkSync(lock);
      }
      if (existsSync(privatePath)) unlinkSync(privatePath);
    },
  };
}

export function stageBefore(
  binding: WorkspaceBinding,
  store: string,
  before: ContentSnapshot,
  index: IndexLock,
): void {
  for (const entry of before.entries) {
    if (entry.index) {
      const bytes = git(store, ["cat-file", "blob", entry.index.oid], { bare: true });
      const sourceOid = textGit(binding.workspace_root, ["hash-object", "-w", "--stdin"], {
        input: bytes,
      });
      git(
        binding.workspace_root,
        ["update-index", "--add", "--cacheinfo", `${entry.index.mode},${sourceOid},${entry.path}`],
        { index: index.privatePath },
      );
    } else
      git(binding.workspace_root, ["update-index", "--force-remove", "--", entry.path], {
        index: index.privatePath,
      });
  }
}

export function restoreFile(binding: WorkspaceBinding, store: string, entry: ContentEntry): void {
  const parent = openParent(binding, entry.path);
  const temporary = `${parent.path}.restore-${randomUUID()}`;
  try {
    if (!entry.worktree) {
      if (existsSync(parent.path)) unlinkSync(parent.path);
    } else {
      const fd = openSync(temporary, "wx", entry.worktree.mode === "100755" ? 0o755 : 0o644);
      try {
        fchmodSync(fd, entry.worktree.mode === "100755" ? 0o755 : 0o644);
        writeFileSync(fd, git(store, ["cat-file", "blob", entry.worktree.oid], { bare: true }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, parent.path);
    }
    const fd = openSync(dirname(parent.path), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    parent.close();
  }
}

export function ensureDirectory(path: string): void {
  if (!existsSync(path)) {
    ensureDirectory(dirname(path));
    mkdirSync(path, { mode: 0o700 });
    fsyncParentDirectory(path);
  }
  if (
    !lstatSync(path).isDirectory() ||
    lstatSync(path).isSymbolicLink() ||
    realpathSync(path) !== resolve(path)
  )
    throw new Error("rollback state path is unsafe");
}
