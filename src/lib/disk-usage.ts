import { spawnSync } from "node:child_process";
import { type Dirent, lstatSync, readdirSync, type Stats } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export const DISK_GIT_STATES = [
  "tracked",
  "untracked",
  "ignored",
  "git-metadata",
  "non-repository",
  "unknown",
] as const;
export type DiskGitState = (typeof DISK_GIT_STATES)[number];
export type DiskGroup = "directory" | "repository" | "extension" | "git" | "files";

export interface DiskOptions {
  git?: string;
  type?: string;
  exclude?: string[];
  group?: DiskGroup;
  depth?: number;
  top?: number;
  minSize?: number;
  apparent?: boolean;
}

export interface DiskTotals {
  files: number;
  apparent_bytes: number;
  allocated_bytes: number | null;
}
export interface DiskRow extends DiskTotals {
  path: string;
}
export interface DiskReport {
  schema: "harnery.disk-usage/v1";
  root: string;
  measurement: "allocated" | "apparent" | "apparent-fallback";
  complete: boolean;
  filters: DiskOptions;
  totals: DiskTotals;
  git: Record<DiskGitState, DiskTotals>;
  groups: DiskRow[];
  group_count: number;
  largest_files: (DiskRow & { git: DiskGitState; repository: string | null })[];
  repositories: string[];
  skipped: { symlinks: number; special_files: number; excluded: number };
  issues: { path: string; message: string }[];
}

const TYPES: Record<string, Set<string>> = {
  video: new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v", "mxf"]),
  audio: new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "aiff"]),
  image: new Set([
    "png",
    "jpg",
    "jpeg",
    "webp",
    "gif",
    "tif",
    "tiff",
    "svg",
    "avif",
    "heic",
    "bmp",
    "psd",
  ]),
  archive: new Set(["zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "rar"]),
};
TYPES.media = new Set([...TYPES.video!, ...TYPES.audio!, ...TYPES.image!]);

interface Repository {
  root: string;
  tracked: Set<string>;
  untracked: Set<string>;
  valid: boolean;
}
const portable = (path: string): string => path.split(sep).join("/");
const empty = (allocated: boolean): DiskTotals => ({
  files: 0,
  apparent_bytes: 0,
  allocated_bytes: allocated ? 0 : null,
});

export function parseDiskSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)?$/i.exec(value);
  if (!match) throw new Error("--min-size requires bytes or a size such as 10MB or 1GiB");
  const units: Record<string, number> = {
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  const bytes = Number(match[1]) * units[(match[2] ?? "b").toLowerCase()]!;
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error("--min-size must resolve to a non-negative whole byte count");
  return bytes;
}

/** Inspect regular files only. No bodies are read and no symlinks are followed. */
export function diskUsage(input = ".", options: DiskOptions = {}): DiskReport {
  const root = resolve(input);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || (!rootStat.isDirectory() && !rootStat.isFile())) {
    throw new Error("disk requires a regular file or directory, not a symlink or special file");
  }
  const group = options.group ?? "directory";
  if (!["directory", "repository", "extension", "git", "files"].includes(group))
    throw new Error("invalid --group; use directory, repository, extension, git, or files");
  const depth = options.depth ?? 1;
  const top = options.top ?? 20;
  if (!Number.isSafeInteger(depth) || depth < 1)
    throw new Error("--depth must be a positive integer");
  if (!Number.isSafeInteger(top) || top < 1) throw new Error("--top must be a positive integer");
  if (
    options.minSize !== undefined &&
    (!Number.isSafeInteger(options.minSize) || options.minSize < 0)
  )
    throw new Error("invalid --min-size");
  const states = options.git ? new Set(options.git.split(",")) : null;
  if (states && [...states].some((s) => !DISK_GIT_STATES.includes(s as DiskGitState)))
    throw new Error(`invalid --git; use ${DISK_GIT_STATES.join(", ")}`);
  const extensions = options.type
    ? new Set(
        options.type
          .toLowerCase()
          .split(",")
          .flatMap((type) => [...(TYPES[type] ?? new Set([type.replace(/^\./, "")]))]),
      )
    : null;
  const excludes = (options.exclude ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""));
  if (excludes.some((value) => !value || isAbsolute(value) || value.split("/").includes("..")))
    throw new Error("--exclude requires directory names or paths relative to the scan root");
  let allocatedAvailable = process.platform !== "win32" && Number.isFinite(rootStat.blocks);
  const report: DiskReport = {
    schema: "harnery.disk-usage/v1",
    root,
    measurement: options.apparent
      ? "apparent"
      : allocatedAvailable
        ? "allocated"
        : "apparent-fallback",
    complete: true,
    filters: { ...options, group, depth, top },
    totals: empty(allocatedAvailable),
    git: Object.fromEntries(
      DISK_GIT_STATES.map((state) => [state, empty(allocatedAvailable)]),
    ) as Record<DiskGitState, DiskTotals>,
    groups: [],
    group_count: 0,
    largest_files: [],
    repositories: [],
    skipped: { symlinks: 0, special_files: 0, excluded: 0 },
    issues: [],
  };
  const groups = new Map<string, DiskRow>();
  const repositories = new Map<string, Repository>();
  const seen = new Set<string>();
  const issue = (path: string, error: unknown): void => {
    report.complete = false;
    report.issues.push({ path, message: error instanceof Error ? error.message : String(error) });
  };
  const git = (cwd: string, args: string[]) =>
    spawnSync("git", ["-C", cwd, "-c", "core.fsmonitor=false", ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    });
  const loadRepo = (repoRoot: string): Repository => {
    const cached = repositories.get(repoRoot);
    if (cached) return cached;
    const repo: Repository = {
      root: repoRoot,
      tracked: new Set(),
      untracked: new Set(),
      valid: false,
    };
    repositories.set(repoRoot, repo);
    for (const [args, target] of [
      [["ls-files", "--cached", "-z"], repo.tracked],
      [["ls-files", "--others", "--exclude-standard", "-z"], repo.untracked],
    ] as const) {
      const result = git(repoRoot, [...args]);
      if (result.status !== 0) {
        issue(
          portable(relative(root, repoRoot)) || ".",
          result.error ?? new Error(`Git classification failed: ${result.stderr.trim()}`),
        );
        return repo;
      }
      for (const path of result.stdout.split("\0")) if (path) target.add(path);
    }
    repo.valid = true;
    return repo;
  };
  const startDir = rootStat.isDirectory() ? root : dirname(root);
  const detected = git(startDir, ["rev-parse", "--show-toplevel"]);
  if (detected.error) issue(".", detected.error);
  const initialRepo = detected.status === 0 ? loadRepo(resolve(detected.stdout.trim())) : null;
  const repoLabel = (repo: Repository | null): string | null => {
    if (!repo) return null;
    const label = portable(relative(root, repo.root));
    return !label || label === ".." || label.startsWith("../") ? "." : label;
  };
  const metric = (row: DiskTotals): number =>
    options.apparent || row.allocated_bytes === null ? row.apparent_bytes : row.allocated_bytes;
  const compare = (a: DiskRow, b: DiskRow): number =>
    metric(b) - metric(a) || a.path.localeCompare(b.path);
  const add = (totals: DiskTotals, size: number, allocated: number): void => {
    totals.files++;
    totals.apparent_bytes += size;
    if (totals.allocated_bytes !== null) totals.allocated_bytes += allocated;
  };
  const excluded = (path: string): boolean =>
    excludes.some((value) =>
      value.includes("/")
        ? path === value || path.startsWith(`${value}/`)
        : path.split("/").includes(value),
    );
  const file = (path: string, metadata: Stats, repo: Repository | null, inGit: boolean): void => {
    const rel = portable(relative(root, path)) || ".";
    const extension = extname(path).slice(1).toLowerCase();
    const repoPath = repo ? portable(relative(repo.root, path)) : "";
    const state: DiskGitState = inGit
      ? "git-metadata"
      : !repo
        ? "non-repository"
        : !repo.valid
          ? "unknown"
          : repo.tracked.has(repoPath)
            ? "tracked"
            : repo.untracked.has(repoPath)
              ? "untracked"
              : "ignored";
    if ((states && !states.has(state)) || (extensions && !extensions.has(extension))) return;
    const blocksAvailable = process.platform !== "win32" && Number.isFinite(metadata.blocks);
    if (!blocksAvailable) allocatedAvailable = false;
    const allocation = blocksAvailable ? metadata.blocks * 512 : metadata.size;
    if (
      (options.apparent || !blocksAvailable ? metadata.size : allocation) < (options.minSize ?? 0)
    )
      return;
    const identity = metadata.ino ? `${metadata.dev}:${metadata.ino}` : path;
    const allocated = seen.has(identity) ? 0 : allocation;
    seen.add(identity);
    add(report.totals, metadata.size, allocated);
    add(report.git[state], metadata.size, allocated);
    const row: DiskReport["largest_files"][number] = {
      path: rel,
      files: 1,
      apparent_bytes: metadata.size,
      allocated_bytes: blocksAvailable ? allocation : null,
      git: state,
      repository: repoLabel(repo),
    };
    report.largest_files.push(row);
    report.largest_files.sort(compare);
    if (report.largest_files.length > top) report.largest_files.pop();
    if (group === "files") return;
    const parts = rel.split("/");
    const label =
      group === "git"
        ? state
        : group === "repository"
          ? (repoLabel(repo) ?? "(non-repository)")
          : group === "extension"
            ? extension
              ? `.${extension}`
              : "(no extension)"
            : parts.length > 1
              ? parts.slice(0, Math.min(depth, parts.length - 1)).join("/")
              : ".";
    let bucket = groups.get(label);
    if (!bucket) {
      bucket = { path: label, ...empty(allocatedAvailable) };
      groups.set(label, bucket);
    }
    add(bucket, metadata.size, allocated);
  };
  const walk = (dir: string, parentRepo: Repository | null, inGit: boolean): void => {
    let entries: Dirent[];
    try {
      // A directory can turn into a link between reading its parent and visiting it.
      if (lstatSync(dir).isSymbolicLink()) {
        report.skipped.symlinks++;
        return;
      }
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch (error) {
      issue(portable(relative(root, dir)) || ".", error);
      return;
    }
    const marker = entries.find((entry) => entry.name === ".git");
    const repo = !inGit && marker && !marker.isSymbolicLink() ? loadRepo(dir) : parentRepo;
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      const rel = portable(relative(root, path));
      if (excluded(rel)) {
        report.skipped.excluded++;
        continue;
      }
      if (entry.isSymbolicLink()) {
        report.skipped.symlinks++;
        continue;
      }
      const gitMetadata = inGit || entry.name === ".git";
      if (entry.isDirectory()) {
        if (gitMetadata && states && !states.has("git-metadata")) continue;
        walk(path, repo, gitMetadata);
      } else if (entry.isFile()) {
        try {
          const metadata = lstatSync(path);
          if (metadata.isSymbolicLink()) report.skipped.symlinks++;
          else if (metadata.isFile()) file(path, metadata, repo, gitMetadata);
          else report.skipped.special_files++;
        } catch (error) {
          issue(rel, error);
        }
      } else report.skipped.special_files++;
    }
  };
  const inMetadata = startDir.split(sep).includes(".git");
  if (rootStat.isDirectory()) walk(root, initialRepo, inMetadata);
  else if (!excluded("."))
    file(root, rootStat, initialRepo, inMetadata || root.endsWith(`${sep}.git`));
  if (!allocatedAvailable) {
    report.totals.allocated_bytes = null;
    for (const totals of Object.values(report.git)) totals.allocated_bytes = null;
    for (const row of groups.values()) row.allocated_bytes = null;
    report.measurement = options.apparent ? "apparent" : "apparent-fallback";
  }
  report.repositories = [...repositories.values()].map((repo) => repoLabel(repo)!).sort();
  report.group_count = group === "files" ? report.totals.files : groups.size;
  report.groups =
    group === "files" ? report.largest_files : [...groups.values()].sort(compare).slice(0, top);
  return report;
}
