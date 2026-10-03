import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readlinkSync, realpathSync, rmSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export interface RemoveOptions {
  root: string;
  recursive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  /**
   * Protected paths (Git metadata, credentials, Harnery state, SSH or GnuPG
   * keys, a bare repository) the caller names for removal, one exact path
   * each. A protected path that is not named is still refused.
   */
  allowProtected?: string[];
  /** Directories whose own Git metadata and Harnery state may never be allowed (the live workspace). */
  liveRoots?: string[];
}

export interface RemovalLink {
  path: string;
  /** What the link points to. It is removed as a link and never followed. */
  target: string;
}

export interface RemovalReport {
  schema: "harnery.removal/v1";
  applied: boolean;
  root: string;
  targets: string[];
  entries: number;
  bytes: number;
  /** Protected paths removed because the caller named them with allowProtected. */
  protected: string[];
  /** Symbolic links inside recursive targets, removed as links. */
  links: RemovalLink[];
}

const protectedNames = new Set([".git", ".harnery", ".credentials", ".ssh", ".gnupg"]);
const MAX_ENTRIES = 10_000;

/** Permanent removal is deliberately limited to inspected, untracked local outputs. */
export function guardedRemove(
  paths: string[],
  options: RemoveOptions,
  checkClaims: (targets: string[]) => void = () => {},
): RemovalReport {
  const cwd = realpathSync(process.cwd());
  const root = checkedPath(options.root, new Set(), true);
  const allowed = allowedProtected(options.allowProtected ?? [], root, options.liveRoots ?? []);
  const rootStat = lstatSync(root);
  const rootFingerprint = fingerprint(rootStat);
  if (!rootStat.isDirectory()) throw new Error("--root must be a directory");
  if (root === parse(root).root || root === realpathSync(homedir()))
    throw new Error("--root cannot be a filesystem root or home directory");
  if (paths.length === 0 || paths.length > 100) throw new Error("Supply 1-100 explicit targets");
  const targets = paths.map((path) => checkedPath(path, allowed));
  const snapshots = new Map<string, string>();
  const removedProtected = new Set<string>();
  const links: RemovalLink[] = [];
  const gitDirs = new Set<string>();
  let bytes = 0;
  const devices = new Set<number>();

  for (const target of targets) {
    const home = realpathSync(homedir());
    if (target === home || strictlyInside(target, home))
      throw new Error(`Cannot remove the home directory or its ancestor: ${target}`);
    const systemRoots =
      process.platform === "win32"
        ? [
            process.env.SystemRoot,
            process.env.ProgramFiles,
            process.env["ProgramFiles(x86)"],
          ].filter((value): value is string => Boolean(value))
        : [
            "/etc",
            "/usr",
            "/boot",
            "/dev",
            "/proc",
            "/sys",
            "/bin",
            "/sbin",
            "/lib",
            "/lib64",
            "/run",
          ];
    if (
      systemRoots.some(
        (system) =>
          target === resolve(system) ||
          strictlyInside(resolve(system), target) ||
          strictlyInside(target, resolve(system)),
      )
    )
      throw new Error(`System files are protected: ${target}`);
    if (!strictlyInside(root, target))
      throw new Error(`Target must be strictly inside --root: ${target}`);
    if (target === cwd || strictlyInside(target, cwd))
      throw new Error(`Cannot remove the working directory or its ancestor: ${target}`);
    if (
      targets.some((other) => other !== target && strictlyInside(other, target)) ||
      targets.filter((other) => other === target).length > 1
    )
      throw new Error("Targets must not duplicate or contain one another");
    const stat = lstatSync(target);
    if (stat.dev !== rootStat.dev) throw new Error(`Target crosses a mount boundary: ${target}`);
    if (stat.isDirectory() && !options.recursive)
      throw new Error(`Directory removal requires --recursive: ${target}`);
    const device = stat.dev;
    devices.add(device);
    const pending = [target];
    while (pending.length) {
      const path = pending.pop()!;
      const info = lstatSync(path);
      if (basename(path) === ARTIFACT_RECORD && insideArtifactWorkspace(path, null))
        throw new Error(`An artifact's record is managed by the artifact commands: ${path}`);
      if (protectedNames.has(basename(path).toLowerCase())) {
        if (!allowed.has(path)) throw new Error(protectedMessage(path));
        removedProtected.add(path);
      }
      if (info.isSymbolicLink()) {
        // A link inside the tree is removed as a link; its target is never
        // read, followed, or counted. (The target itself and its ancestors
        // were already refused if they were links, in checkedPath.)
        if (path === target) throw new Error(`Path contains a symlink: ${path}`);
        if (snapshots.size >= MAX_ENTRIES)
          throw new Error(
            `Removal exceeds the ${MAX_ENTRIES}-entry limit; use the owning cleanup command`,
          );
        snapshots.set(path, fingerprint(info));
        links.push({ path, target: readlinkSync(path) });
        continue;
      }
      if (info.dev !== device || (!info.isDirectory() && !info.isFile()))
        throw new Error(`Mount boundary or special file cannot be removed: ${path}`);
      if (snapshots.size >= MAX_ENTRIES)
        throw new Error(
          `Removal exceeds the ${MAX_ENTRIES}-entry limit; use the owning cleanup command`,
        );
      snapshots.set(path, fingerprint(info));
      if (info.isFile()) bytes += info.size;
      else {
        const names = readdirSync(path);
        if (
          names.includes("HEAD") &&
          names.includes("objects") &&
          names.includes("config") &&
          !insideAllowed(path, allowed)
        )
          throw new Error(
            `Repository metadata cannot be removed: ${path}. To remove it on purpose, name it with --allow-protected ${path}`,
          );
        if (allowed.has(path)) removedProtected.add(path);
        if (isRepositoryMetadata(path)) gitDirs.add(path);
        for (const name of names) pending.push(resolve(path, name));
      }
    }
    assertUntracked(target);
  }
  if (devices.size > 1) throw new Error("Targets must be on one filesystem");
  for (const path of allowed)
    if (!removedProtected.has(path))
      throw new Error(`--allow-protected names a path no target removes: ${path}`);
  for (const dir of gitDirs) assertNoUnpushedHistory(dir);
  checkClaims(targets);
  const report: RemovalReport = {
    schema: "harnery.removal/v1",
    applied: false,
    root,
    targets,
    entries: snapshots.size,
    bytes,
    protected: [...removedProtected].sort(),
    links,
  };
  if (!options.yes || options.dryRun) return report;

  // Recheck the entire batch before its first mutation. Filesystem changes after
  // these checks remain possible; this is a guard, not a transactional filesystem.
  if (
    checkedPath(options.root, new Set(), true) !== root ||
    fingerprint(lstatSync(root)) !== rootFingerprint
  )
    throw new Error("Allowed root changed during inspection");
  for (const target of targets) {
    checkedPath(target, allowed);
    assertUntracked(target);
  }
  for (const dir of gitDirs) assertNoUnpushedHistory(dir);
  checkClaims(targets);
  for (const [path, previous] of snapshots) {
    if (fingerprint(lstatSync(path)) !== previous)
      throw new Error(`Target changed during inspection: ${path}`);
  }
  for (const target of targets)
    rmSync(target, { recursive: Boolean(options.recursive), force: false });
  return { ...report, applied: true };
}

/** The metadata file the artifact commands keep in each artifact workspace. */
const ARTIFACT_RECORD = ".harnery-artifact.json";

/**
 * True when `path` lies strictly inside one artifact workspace,
 * <dir>/.harnery/artifacts/<id>/..., under the `.harnery` component `state`
 * (any `.harnery` when null). Artifact workspaces hold local outputs, so their
 * contents may be removed; the workspace itself, its record file, and the rest
 * of Harnery state stay protected and follow the artifact commands. `orSelf`
 * accepts the workspace directory itself (used for --root, which is never removed).
 */
function insideArtifactWorkspace(path: string, state: string | null, orSelf = false): boolean {
  const parts = path.split(sep);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]!.toLowerCase() !== ".harnery") continue;
    if (state !== null && parts.slice(0, i + 1).join(sep) !== state) continue;
    // .harnery / artifacts / <id> / <something>
    return (
      parts[i + 1] === "artifacts" && Boolean(parts[i + 2]) && parts.length >= i + (orSelf ? 3 : 4)
    );
  }
  return false;
}

function protectedMessage(path: string): string {
  return `Protected state cannot be removed: ${path}. To remove it on purpose, name it with --allow-protected ${path}`;
}

function insideAllowed(path: string, allowed: ReadonlySet<string>): boolean {
  for (const entry of allowed) if (path === entry || strictlyInside(entry, path)) return true;
  return false;
}

/**
 * Resolves the caller's --allow-protected paths. Each must be one exact
 * protected path strictly inside the root, reached without symlinks, and
 * never the Git metadata or Harnery state of a live workspace root.
 */
function allowedProtected(paths: string[], root: string, liveRoots: string[]): Set<string> {
  const allowed = new Set<string>();
  const live = liveRoots.map((dir) => resolve(dir));
  for (const input of paths) {
    if (!input?.trim() || /[\0\r\n*?[\]$]/.test(input))
      throw new Error("Use a nonempty explicit --allow-protected path without wildcards");
    const path = resolve(input);
    let cursor = dirname(path);
    while (true) {
      if (lstatSync(cursor).isSymbolicLink())
        throw new Error(`--allow-protected path contains a symlink: ${cursor}`);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`--allow-protected path is a symlink: ${path}`);
    if (!strictlyInside(root, path))
      throw new Error(`--allow-protected path must be strictly inside --root: ${path}`);
    const named = protectedNames.has(basename(path).toLowerCase());
    if (!named && !(info.isDirectory() && isRepositoryMetadata(path)))
      throw new Error(`--allow-protected must name a protected path itself: ${path}`);
    for (const dir of live) {
      const own = [".git", ".harnery"].map((name) => resolve(dir, name));
      if (
        path === dir ||
        strictlyInside(path, dir) ||
        own.some((state) => path === state || strictlyInside(state, path))
      )
        throw new Error(`The live workspace's own state cannot be allowed: ${path}`);
    }
    allowed.add(realpathSync(path));
  }
  return allowed;
}

function isRepositoryMetadata(dir: string): boolean {
  const names = readdirSync(dir);
  return names.includes("HEAD") && names.includes("objects") && names.includes("config");
}

/**
 * Removing a repository's metadata loses any commit that exists nowhere
 * else. An allowed Git directory must have no branch or tag commit missing
 * from its remotes; anything that cannot be checked is refused.
 */
function assertNoUnpushedHistory(gitDir: string): void {
  const result = spawnSync(
    "git",
    [
      "--git-dir",
      gitDir,
      "rev-list",
      "--max-count=1",
      "--branches",
      "--tags",
      "--not",
      "--remotes",
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, LC_ALL: "C", GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(`Cannot confirm ${gitDir} holds no unpushed history`);
  if (result.stdout.trim()) throw new Error(`Repository has commits not on any remote: ${gitDir}`);
}

function strictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function checkedPath(
  input: string,
  allowed: ReadonlySet<string> = new Set(),
  isRoot = false,
): string {
  if (!input?.trim() || /[\0\r\n*?[\]$]/.test(input))
    throw new Error("Use a nonempty explicit path without wildcards or unresolved variables");
  const path = resolve(input);
  let cursor = path;
  while (true) {
    if (
      protectedNames.has(basename(cursor).toLowerCase()) &&
      !allowed.has(cursor) &&
      !insideArtifactWorkspace(path, cursor, isRoot)
    )
      throw new Error(
        cursor === path ? protectedMessage(path) : `Protected state contains this path: ${cursor}`,
      );
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) throw new Error(`Path contains a symlink: ${cursor}`);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return realpathSync(path);
}

function fingerprint(stat: Stats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function assertUntracked(target: string): void {
  const git = (args: string[]) =>
    spawnSync("git", ["-C", dirname(target), ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_LITERAL_PATHSPECS: "1",
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_INDEX_FILE: undefined,
      },
    });
  const detected = git(["rev-parse", "--show-toplevel"]);
  if (detected.error) throw new Error(`Cannot check Git ownership: ${detected.error.message}`);
  if (detected.status !== 0) {
    if (detected.status === 128 && detected.stderr.startsWith("fatal: not a git repository"))
      return;
    throw new Error(`Cannot check Git ownership: ${detected.stderr.trim()}`);
  }
  const repo = detected.stdout.trim();
  const tracked = git(["ls-files", "--cached", "-z", "--full-name", "--", target]);
  if (tracked.error || tracked.status !== 0) throw new Error(`Cannot inspect Git index in ${repo}`);
  if (tracked.stdout.length)
    throw new Error(
      `Tracked files are protected; use git rm for intentional source removal: ${target}`,
    );
}
