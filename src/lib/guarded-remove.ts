import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, rmSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export interface RemoveOptions {
  root: string;
  recursive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

export interface RemovalReport {
  schema: "harnery.removal/v1";
  applied: boolean;
  root: string;
  targets: string[];
  entries: number;
  bytes: number;
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
  const root = checkedPath(options.root);
  const rootStat = lstatSync(root);
  const rootFingerprint = fingerprint(rootStat);
  if (!rootStat.isDirectory()) throw new Error("--root must be a directory");
  if (root === parse(root).root || root === realpathSync(homedir()))
    throw new Error("--root cannot be a filesystem root or home directory");
  if (paths.length === 0 || paths.length > 100) throw new Error("Supply 1-100 explicit targets");
  const targets = paths.map(checkedPath);
  const snapshots = new Map<string, string>();
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
      if (protectedNames.has(basename(path).toLowerCase()))
        throw new Error(`Protected state cannot be removed: ${path}`);
      if (info.isSymbolicLink()) throw new Error(`Symlink removal is not supported: ${path}`);
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
        if (names.includes("HEAD") && names.includes("objects") && names.includes("config"))
          throw new Error(`Repository metadata cannot be removed: ${path}`);
        for (const name of names) pending.push(resolve(path, name));
      }
    }
    assertUntracked(target);
  }
  if (devices.size > 1) throw new Error("Targets must be on one filesystem");
  checkClaims(targets);
  const report: RemovalReport = {
    schema: "harnery.removal/v1",
    applied: false,
    root,
    targets,
    entries: snapshots.size,
    bytes,
  };
  if (!options.yes || options.dryRun) return report;

  // Recheck the entire batch before its first mutation. Filesystem changes after
  // these checks remain possible; this is a guard, not a transactional filesystem.
  if (checkedPath(options.root) !== root || fingerprint(lstatSync(root)) !== rootFingerprint)
    throw new Error("Allowed root changed during inspection");
  for (const target of targets) {
    checkedPath(target);
    assertUntracked(target);
  }
  checkClaims(targets);
  for (const [path, previous] of snapshots) {
    if (fingerprint(lstatSync(path)) !== previous)
      throw new Error(`Target changed during inspection: ${path}`);
  }
  for (const target of targets)
    rmSync(target, { recursive: Boolean(options.recursive), force: false });
  return { ...report, applied: true };
}

function strictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function checkedPath(input: string): string {
  if (!input?.trim() || /[\0\r\n*?[\]$]/.test(input))
    throw new Error("Use a nonempty explicit path without wildcards or unresolved variables");
  const path = resolve(input);
  let cursor = path;
  while (true) {
    if (protectedNames.has(basename(cursor).toLowerCase()))
      throw new Error(`Protected state cannot be removed: ${path}`);
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
