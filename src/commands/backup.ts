/**
 * `harn backup`: restic-backed snapshots of `.harnery/`.
 *
 * Wraps `restic` with sensible defaults so single-user use doesn't require
 * remembering env vars. Repo path + password file live under XDG-style
 * paths and are init'd on first `harn backup init`. Subcommands:
 *
 *   init      restic init the repo (one-time)
 *   snapshot  restic backup of the durable, privacy-safe V3 state
 *   list      restic snapshots
 *   restore   restic restore <id>
 *   prune     restic forget --keep-daily 7 --keep-weekly 4 --prune
 *
 * Defaults (repo path, password file, and the keep-daily/weekly/monthly prune
 * policy) come from `.harnery/config.jsonc` `backup.*`, overridable per field by
 * env vars (HARNERY_RESTIC_REPO, HARNERY_RESTIC_PASSWORD_FILE) and CLI flags —
 * see `backupConfig()`. The wrapper deliberately doesn't try to abstract restic;
 * it surfaces it, with opinionated defaults plus passthrough after `--`.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import {
  newestSnapshotTime,
  parseBackupDuration,
  recordHostSnapshot,
} from "../core/backup/host-snapshot.ts";
import { type BackupConfig, backupConfig } from "../core/config.ts";
import { createStorageCatalog } from "../core/storage/catalog.ts";
import type { HarneryStorageClass } from "../core/storage/contract.ts";

export {
  hostSnapshotCachePath,
  newestSnapshotTime,
  parseBackupDuration,
  readHostSnapshotCache,
} from "../core/backup/host-snapshot.ts";

export const DEFAULT_BACKUP_MAX_BYTES = 50 * 1_024 * 1_024;
export const DEFAULT_BACKUP_CLASSES = new Set<HarneryStorageClass>([
  "canonical-authority",
  "durable-object-history",
  "recovery-state",
]);
export const DEFAULT_BACKUP_EXCLUDED_CLASSES = new Set<HarneryStorageClass>([
  "debug-log",
  "managed-artifact",
  "operational-log",
  "repairable-cache",
]);
export const DEFAULT_BACKUP_EXCLUDED_FAMILY_IDS = new Set([
  "event-v3-canonical-active",
  "event-v3-canonical-archives",
  "event-v3-support-active",
  "event-v3-support-archives",
  "event-v3-recovery-records",
  "legacy-canonical-ledgers",
  "managed-artifacts",
  "captured-images",
  "storage-exports",
]);

function defaultRepo(): string {
  return backupConfig().repo;
}

function defaultPasswordFile(): string {
  return backupConfig().passwordFile;
}

function findHarneryDir(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, ".harnery"))) {
      return path.join(dir, ".harnery");
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function ensurePasswordFile(file: string): void {
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const pw = randomBytes(24).toString("base64");
  writeFileSync(file, `${pw}\n`, { encoding: "utf-8", mode: 0o600 });
}

function isFilesystemRepository(repo: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(repo)) return true;
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(repo);
}

function inside(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function configPath(harneryDir: string, value: string): string | null {
  if (path.isAbsolute(value)) return null;
  const normalized = value.replaceAll("\\", "/").replace(/^\.harnery\//, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) {
    return null;
  }
  const resolved = path.resolve(harneryDir, normalized);
  return inside(harneryDir, resolved) ? resolved : null;
}

export interface BackupSelection {
  targets: readonly string[];
  familyIds: readonly string[];
}

export function resolveBackupSelection(
  projectRoot: string,
  config: BackupConfig = backupConfig(projectRoot),
  includeArtifacts = false,
): BackupSelection {
  const root = path.resolve(projectRoot);
  const harneryDir = path.join(root, ".harnery");
  const catalog = createStorageCatalog({ coord_root: root, project_root: root });
  const knownFamilyIds = new Set(catalog.families.map((family) => family.id));
  const configuredFamilyExclusions = new Set(
    config.exclude.filter((entry) => knownFamilyIds.has(entry)),
  );
  const configuredPathExclusions = config.exclude
    .filter((entry) => !knownFamilyIds.has(entry))
    .map((entry) => configPath(harneryDir, entry))
    .filter((entry): entry is string => entry !== null);
  const selectedFamilies = catalog.families.filter(
    (family) =>
      DEFAULT_BACKUP_CLASSES.has(family.storage_class) &&
      !DEFAULT_BACKUP_EXCLUDED_FAMILY_IDS.has(family.id) &&
      !configuredFamilyExclusions.has(family.id),
  );
  const excludedByPath = (candidate: string): boolean =>
    configuredPathExclusions.some(
      (excluded) => candidate === excluded || inside(excluded, candidate),
    );
  const targets = selectedFamilies
    .flatMap((family) => family.resolved_roots.map((storageRoot) => storageRoot.path))
    .filter((candidate) => inside(harneryDir, candidate))
    .filter((candidate) => !excludedByPath(candidate));
  for (const entry of config.include) {
    const candidate = configPath(harneryDir, entry);
    if (candidate && !excludedByPath(candidate)) targets.push(candidate);
  }
  if (includeArtifacts) targets.push(path.join(harneryDir, "artifacts"));
  return {
    targets: [...new Set(targets)].filter(existsSync).sort(),
    familyIds: selectedFamilies.map((family) => family.id).sort(),
  };
}

export function backupCatalogCoverage(projectRoot: string): {
  uncovered: readonly string[];
} {
  const root = path.resolve(projectRoot);
  const harneryDir = path.join(root, ".harnery");
  const catalog = createStorageCatalog({ coord_root: root, project_root: root });
  const uncovered = catalog.families
    .filter((family) => {
      const selected =
        DEFAULT_BACKUP_CLASSES.has(family.storage_class) &&
        !DEFAULT_BACKUP_EXCLUDED_FAMILY_IDS.has(family.id);
      const excluded =
        DEFAULT_BACKUP_EXCLUDED_CLASSES.has(family.storage_class) ||
        DEFAULT_BACKUP_EXCLUDED_FAMILY_IDS.has(family.id);
      const externalOnly =
        family.resolved_roots.length === 0 ||
        family.resolved_roots.every((storageRoot) => !inside(harneryDir, storageRoot.path));
      return !selected && !excluded && !externalOnly;
    })
    .map((family) => family.id);
  return { uncovered };
}

export function selectedLogicalBytes(targets: readonly string[]): number {
  const visited = new Set<string>();
  const measure = (candidate: string): number => {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(candidate);
    } catch {
      return 0;
    }
    const identity = `${stat.dev}:${stat.ino}`;
    if (visited.has(identity)) return 0;
    visited.add(identity);
    if (stat.isSymbolicLink()) return 0;
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    return readdirSync(candidate).reduce(
      (total, entry) => total + measure(path.join(candidate, entry)),
      0,
    );
  };
  return targets.reduce((total, target) => total + measure(target), 0);
}

function lockOwnerIsAlive(lockDir: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(path.join(lockDir, "owner.json"), "utf8")) as {
      pid?: number;
      created_at?: string;
    };
    if (typeof owner.pid === "number" && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        return true;
      } catch {
        // The owner is gone; the directory is reclaimable.
      }
    }
    const createdAt = typeof owner.created_at === "string" ? Date.parse(owner.created_at) : 0;
    return Number.isFinite(createdAt) && Date.now() - createdAt < 60 * 60 * 1_000;
  } catch {
    return false;
  }
}

function acquireSnapshotLock(harneryDir: string): { acquired: boolean; release(): void } {
  const locksDir = path.join(harneryDir, "locks");
  const lockDir = path.join(locksDir, "backup-snapshot.lock");
  mkdirSync(locksDir, { recursive: true });
  const create = (): boolean => {
    try {
      mkdirSync(lockDir);
      writeFileSync(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
        "utf8",
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };
  if (!create()) {
    if (lockOwnerIsAlive(lockDir)) return { acquired: false, release() {} };
    rmSync(lockDir, { recursive: true, force: true });
    if (!create()) return { acquired: false, release() {} };
  }
  return {
    acquired: true,
    release() {
      rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

interface RunOpts {
  repo?: string;
  passwordFile?: string;
  passThrough?: string[];
  stdio?: "inherit" | "pipe";
}

function runRestic(args: string[], opts: RunOpts = {}): { exitCode: number; stdout: string } {
  const repo = opts.repo ?? defaultRepo();
  const pwFile = opts.passwordFile ?? defaultPasswordFile();
  const wantInherit = opts.stdio === "inherit";
  const r = spawnSync("restic", [...args, ...(opts.passThrough ?? [])], {
    env: {
      ...process.env,
      RESTIC_REPOSITORY: repo,
      RESTIC_PASSWORD_FILE: pwFile,
    },
    encoding: "utf-8",
    stdio: wantInherit ? "inherit" : "pipe",
  });
  return {
    exitCode: r.status ?? 1,
    stdout: wantInherit ? "" : (r.stdout ?? "") + (r.stderr ?? ""),
  };
}

function checkRestic(emit: EmitContext): boolean {
  const r = spawnSync("restic", ["version"], { encoding: "utf-8" });
  if (r.status !== 0) {
    emit.error({
      code: "restic_missing",
      message: "restic is not on PATH",
      hint: "brew install restic (mac) / apt-get install restic (ubuntu) / https://restic.readthedocs.io/en/stable/020_installation.html",
    });
    return false;
  }
  return true;
}

interface BaseOpts {
  repo?: string;
  passwordFile?: string;
  json?: boolean;
}

export function registerBackupCommand(program: Command, emit: EmitContext): void {
  const backup = program
    .command("backup")
    .description("restic-backed snapshots of .harnery/ (multi-machine recovery insurance)");

  // -- init --
  backup
    .command("init")
    .description("Create the restic repository + password file (one-time).")
    .option("--repo <path>", "Repository path (default: configured backup.repo)")
    .option(
      "--password-file <path>",
      "Password file (default: configured backup.password_file; autogenerated)",
    )
    .action((opts: BaseOpts) => {
      if (!checkRestic(emit)) {
        emit.setExitCode(1);
        return;
      }
      const repo = opts.repo ?? defaultRepo();
      const pwFile = opts.passwordFile ?? defaultPasswordFile();
      ensurePasswordFile(pwFile);
      if (isFilesystemRepository(repo)) mkdirSync(path.dirname(repo), { recursive: true });
      const r = runRestic(["init"], { repo, passwordFile: pwFile, stdio: "inherit" });
      if (r.exitCode === 0) {
        emit.text(`restic repo initialized at ${repo}\npassword file: ${pwFile}`);
      } else {
        emit.setExitCode(r.exitCode);
      }
    });

  // -- snapshot --
  backup
    .command("snapshot")
    .description(
      "Take a restic snapshot of the durable, privacy-safe V3 ledger and coordination state.",
    )
    .option("--tag <tag>", "Restic tag (repeatable)", collect, [] as string[])
    .option("--repo <path>", "Repository path")
    .option("--password-file <path>", "Password file")
    .option(
      "--include-artifacts",
      "Include managed working artifacts (default: excluded; potentially large + ephemeral)",
    )
    .option("--allow-large", "Permit a selected set larger than backup.max_bytes")
    .option("--if-stale <duration>", "Skip when this host has a newer snapshot (for example 24h)")
    .action(
      (
        opts: BaseOpts & {
          tag: string[];
          includeArtifacts?: boolean;
          allowLarge?: boolean;
          ifStale?: string;
        },
      ) => {
        if (!checkRestic(emit)) {
          emit.setExitCode(1);
          return;
        }
        const harneryDir = findHarneryDir();
        if (!harneryDir) {
          emit.error({
            code: "target_missing",
            message: "No .harnery/ found above cwd; run from an initialized project",
          });
          emit.setExitCode(1);
          return;
        }
        const staleMs = opts.ifStale ? parseBackupDuration(opts.ifStale) : null;
        if (opts.ifStale && staleMs === null) {
          emit.error({
            code: "backup_invalid_duration",
            message: `Invalid --if-stale duration: ${opts.ifStale}`,
            hint: "Use an integer duration such as 30m, 24h, or 7d",
          });
          emit.setExitCode(1);
          return;
        }
        const lock = acquireSnapshotLock(harneryDir);
        if (!lock.acquired) {
          emit.text("backup snapshot already running; skipped");
          return;
        }
        try {
          if (staleMs !== null) {
            const latest = runRestic(["snapshots", "--json", "--host", hostname()], {
              repo: opts.repo,
              passwordFile: opts.passwordFile,
              stdio: "pipe",
            });
            if (latest.exitCode !== 0) {
              emit.error({ code: "backup_snapshot_list_failed", message: latest.stdout.trim() });
              emit.setExitCode(latest.exitCode);
              return;
            }
            const newest = newestSnapshotTime(latest.stdout);
            if (newest !== null && Date.now() - newest < staleMs) {
              recordHostSnapshot(harneryDir, newest);
              emit.text(`latest snapshot for ${hostname()} is newer than ${opts.ifStale}; skipped`);
              return;
            }
          }
          const config = backupConfig(path.dirname(harneryDir));
          const selection = resolveBackupSelection(
            path.dirname(harneryDir),
            config,
            opts.includeArtifacts,
          );
          if (selection.targets.length === 0) {
            emit.error({
              code: "backup_empty",
              message: "No durable Harnery state is available to back up",
            });
            emit.setExitCode(1);
            return;
          }
          const logicalBytes = selectedLogicalBytes(selection.targets);
          if (!opts.allowLarge && logicalBytes > config.maxBytes) {
            emit.error({
              code: "backup_too_large",
              message: `Selected backup is ${logicalBytes} bytes; limit is ${config.maxBytes} bytes`,
              hint: "Review backup.include/exclude or pass --allow-large for this snapshot",
            });
            emit.setExitCode(1);
            return;
          }
          const passThrough: string[] = [];
          for (const tag of opts.tag) passThrough.push("--tag", tag);
          const startedAt = Date.now();
          const result = runRestic(["backup", ...selection.targets], {
            repo: opts.repo,
            passwordFile: opts.passwordFile,
            stdio: "inherit",
            passThrough,
          });
          if (result.exitCode === 0) recordHostSnapshot(harneryDir, startedAt);
          emit.setExitCode(result.exitCode);
        } finally {
          lock.release();
        }
      },
    );

  // -- list --
  backup
    .command("list")
    .description("List snapshots in the repo.")
    .option("--repo <path>", "Repository path")
    .option("--password-file <path>", "Password file")
    .option("--json", "JSON output")
    .action((opts: BaseOpts) => {
      if (!checkRestic(emit)) {
        emit.setExitCode(1);
        return;
      }
      const args = ["snapshots"];
      if (opts.json) args.push("--json");
      const r = runRestic(args, {
        repo: opts.repo,
        passwordFile: opts.passwordFile,
        stdio: opts.json ? "pipe" : "inherit",
      });
      if (opts.json && r.exitCode === 0) {
        try {
          emit.data(JSON.parse(r.stdout));
        } catch {
          emit.text(r.stdout);
        }
      }
      emit.setExitCode(r.exitCode);
    });

  // -- restore --
  backup
    .command("restore <snapshotId>")
    .description("Restore a snapshot to a target directory (default: ./restore-<timestamp>).")
    .option("--target <path>", "Restore destination")
    .option("--repo <path>", "Repository path")
    .option("--password-file <path>", "Password file")
    .action((snapshotId: string, opts: BaseOpts & { target?: string }) => {
      if (!checkRestic(emit)) {
        emit.setExitCode(1);
        return;
      }
      const target = opts.target ?? path.join(process.cwd(), `restore-${Date.now()}`);
      mkdirSync(target, { recursive: true });
      const r = runRestic(["restore", snapshotId, "--target", target], {
        repo: opts.repo,
        passwordFile: opts.passwordFile,
        stdio: "inherit",
      });
      if (r.exitCode === 0) {
        emit.text(`restored to: ${target}`);
      }
      emit.setExitCode(r.exitCode);
    });

  // -- prune --
  // Prune-policy defaults come from backup.keep_* in config.jsonc (falling back
  // to 7/4/6); an explicit --keep-* flag still overrides per invocation.
  backup
    .command("prune")
    .description("Forget + prune snapshots (default policy comes from backup.keep_* config).")
    .option("--keep-daily <n>", "Daily snapshots to keep (default: configured backup.keep_daily)")
    .option(
      "--keep-weekly <n>",
      "Weekly snapshots to keep (default: configured backup.keep_weekly)",
    )
    .option(
      "--keep-monthly <n>",
      "Monthly snapshots to keep (default: configured backup.keep_monthly)",
    )
    .option("--dry-run", "Show what would be pruned without actually pruning")
    .option("--repo <path>", "Repository path")
    .option("--password-file <path>", "Password file")
    .action(
      (
        opts: BaseOpts & {
          keepDaily?: string;
          keepWeekly?: string;
          keepMonthly?: string;
          dryRun?: boolean;
        },
      ) => {
        if (!checkRestic(emit)) {
          emit.setExitCode(1);
          return;
        }
        const prunePolicy = backupConfig();
        const args = [
          "forget",
          "--keep-daily",
          opts.keepDaily ?? String(prunePolicy.keepDaily),
          "--keep-weekly",
          opts.keepWeekly ?? String(prunePolicy.keepWeekly),
          "--keep-monthly",
          opts.keepMonthly ?? String(prunePolicy.keepMonthly),
        ];
        if (!opts.dryRun) args.push("--prune");
        else args.push("--dry-run");
        const r = runRestic(args, {
          repo: opts.repo,
          passwordFile: opts.passwordFile,
          stdio: "inherit",
        });
        emit.setExitCode(r.exitCode);
      },
    );

  // -- check --
  backup
    .command("check")
    .description("restic check: verify repo integrity")
    .option("--repo <path>", "Repository path")
    .option("--password-file <path>", "Password file")
    .action((opts: BaseOpts) => {
      if (!checkRestic(emit)) {
        emit.setExitCode(1);
        return;
      }
      const r = runRestic(["check"], {
        repo: opts.repo,
        passwordFile: opts.passwordFile,
        stdio: "inherit",
      });
      emit.setExitCode(r.exitCode);
    });
}

function collect(value: string, acc: string[]): string[] {
  acc.push(value);
  return acc;
}
