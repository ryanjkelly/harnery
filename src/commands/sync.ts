/**
 * `harn sync`: keep a curated subset of `.harnery/` live across machines
 * via rclone (typically a Google Drive remote, but any rclone remote works).
 *
 * Scope: a deliberately small set of file types: durable identities,
 * archived scratchpads, council manifests. The high-churn machine-local
 * stuff (events.ndjson, .pid-map/, active/, .last-intent.*) stays put.
 *
 * Subcommands:
 *   init:    interactive: `rclone config` walks through Google OAuth, then
 *            we record the chosen remote name in ~/.config/harnery/sync.json
 *   status:  diff local vs remote (rclone check --one-way)
 *   push:    local to remote (rclone copy)
 *   pull:    remote to local (rclone copy)
 *   list:    show what's in the remote
 *
 * Power users override via env (HARNERY_SYNC_REMOTE, HARNERY_SYNC_PREFIX) or by
 * editing the config file. Like `harn backup`, this surfaces rclone rather
 * than abstracting it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";

// What we sync. Anything matching one of these (relative to .harnery/) is
// considered part of the sync set. Everything else stays local-only.
const SYNC_PATHS = ["identities/", "scratch/archived/", "councils/"];

interface SyncConfig {
  remote: string;
  prefix: string;
}

function configPath(): string {
  return path.join(os.homedir(), ".config", "harnery", "sync.json");
}

function loadConfig(): SyncConfig | null {
  const envRemote = process.env.HARNERY_SYNC_REMOTE;
  const envPrefix = process.env.HARNERY_SYNC_PREFIX ?? "harnery";
  if (envRemote) return { remote: envRemote, prefix: envPrefix };
  const p = configPath();
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as SyncConfig;
    if (typeof parsed.remote === "string" && typeof parsed.prefix === "string") {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function saveConfig(cfg: SyncConfig): void {
  const p = configPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
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

function checkRclone(emit: EmitContext): boolean {
  const r = spawnSync("rclone", ["version"], { encoding: "utf-8" });
  if (r.status !== 0) {
    emit.error({
      code: "rclone_missing",
      message: "rclone is not on PATH",
      hint:
        "Install via `curl https://rclone.org/install.sh | sudo bash` or " +
        "https://rclone.org/downloads/",
    });
    return false;
  }
  return true;
}

function listRemotes(): string[] {
  const r = spawnSync("rclone", ["listremotes"], { encoding: "utf-8" });
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim().replace(/:$/, ""))
    .filter(Boolean);
}

function ensureConfig(emit: EmitContext): SyncConfig | null {
  const cfg = loadConfig();
  if (cfg) return cfg;
  emit.error({
    code: "not_initialized",
    message: "no harn sync config",
    hint: "Run `harn sync init` to pick an rclone remote and record it.",
  });
  return null;
}

function buildRcloneArgs(
  cfg: SyncConfig,
  harneryDir: string,
  direction: "push" | "pull",
): {
  local: string;
  remote: string;
} {
  const local = harneryDir;
  const remote = `${cfg.remote}:${cfg.prefix}`;
  return direction === "push" ? { local, remote } : { local, remote };
}

interface FilterOpts {
  dryRun?: boolean;
  verbose?: boolean;
}

function syncIncludeFlags(): string[] {
  const out: string[] = [];
  for (const p of SYNC_PATHS) {
    out.push("--include", `/${p}**`);
  }
  return out;
}

export function registerSyncCommand(program: Command, emit: EmitContext): void {
  const sync = program
    .command("sync")
    .description(
      "Cross-machine sync of curated .harnery/ subset (identities, archived " +
        "scratchpads, council manifests) via rclone. Google Drive is the " +
        "expected remote; any rclone backend works.",
    );

  sync
    .command("init")
    .description(
      "Pick the rclone remote to sync against. Run `rclone config` first " +
        "if you haven't set up a remote yet (harnery doesn't wrap the OAuth " +
        "flow; rclone's own config wizard handles that).",
    )
    .option("--remote <name>", "Use this rclone remote (skips the picker)")
    .option("--prefix <path>", "Subpath under the remote root (default: harnery)", "harnery")
    .action((opts: { remote?: string; prefix: string }) => {
      if (!checkRclone(emit)) {
        emit.setExitCode(1);
        return;
      }
      const remotes = listRemotes();
      if (remotes.length === 0) {
        emit.error({
          code: "no_remotes",
          message: "rclone has no remotes configured",
          hint: "Run `rclone config` to add one (Google Drive: choose `drive`).",
        });
        emit.setExitCode(1);
        return;
      }

      let remote = opts.remote;
      if (!remote) {
        if (remotes.length === 1) {
          remote = remotes[0];
        } else {
          emit.error({
            code: "remote_required",
            message: `multiple rclone remotes; pass --remote <name>; available: ${remotes.join(", ")}`,
          });
          emit.setExitCode(1);
          return;
        }
      }
      if (!remotes.includes(remote)) {
        emit.error({
          code: "unknown_remote",
          message: `remote "${remote}" not in rclone config (have: ${remotes.join(", ")})`,
        });
        emit.setExitCode(1);
        return;
      }

      saveConfig({ remote, prefix: opts.prefix });
      emit.text(`recorded: remote=${remote}  prefix=${opts.prefix}`);
      emit.text(`config: ${configPath()}`);
    });

  sync
    .command("status")
    .description("Diff local .harnery/ subset vs the remote (rclone check --one-way).")
    .option("--dry-run", "Same as no-op for status; kept for symmetry with push/pull")
    .option("--verbose", "Pass -v to rclone")
    .action((opts: FilterOpts) => {
      if (!checkRclone(emit)) {
        emit.setExitCode(1);
        return;
      }
      const cfg = ensureConfig(emit);
      if (!cfg) {
        emit.setExitCode(1);
        return;
      }
      const hDir = findHarneryDir();
      if (!hDir) {
        emit.error({ code: "no_harnery", message: "no .harnery/ found above cwd" });
        emit.setExitCode(1);
        return;
      }
      const { local, remote } = buildRcloneArgs(cfg, hDir, "push");
      const args = ["check", local, remote, "--one-way", ...syncIncludeFlags()];
      if (opts.verbose) args.push("-v");
      const r = spawnSync("rclone", args, { stdio: "inherit" });
      emit.setExitCode(r.status ?? 1);
    });

  sync
    .command("push")
    .description("Push local .harnery/ subset to the remote (rclone copy).")
    .option("--dry-run", "Pass --dry-run to rclone")
    .option("--verbose", "Pass -v to rclone")
    .action((opts: FilterOpts) => {
      if (!checkRclone(emit)) {
        emit.setExitCode(1);
        return;
      }
      const cfg = ensureConfig(emit);
      if (!cfg) {
        emit.setExitCode(1);
        return;
      }
      const hDir = findHarneryDir();
      if (!hDir) {
        emit.error({ code: "no_harnery", message: "no .harnery/ found above cwd" });
        emit.setExitCode(1);
        return;
      }
      const { local, remote } = buildRcloneArgs(cfg, hDir, "push");
      const args = ["copy", local, remote, ...syncIncludeFlags()];
      if (opts.dryRun) args.push("--dry-run");
      if (opts.verbose) args.push("-v");
      const r = spawnSync("rclone", args, { stdio: "inherit" });
      emit.setExitCode(r.status ?? 1);
    });

  sync
    .command("pull")
    .description("Pull the remote subset down into local .harnery/ (rclone copy).")
    .option("--dry-run", "Pass --dry-run to rclone")
    .option("--verbose", "Pass -v to rclone")
    .action((opts: FilterOpts) => {
      if (!checkRclone(emit)) {
        emit.setExitCode(1);
        return;
      }
      const cfg = ensureConfig(emit);
      if (!cfg) {
        emit.setExitCode(1);
        return;
      }
      const hDir = findHarneryDir();
      if (!hDir) {
        emit.error({ code: "no_harnery", message: "no .harnery/ found above cwd" });
        emit.setExitCode(1);
        return;
      }
      const { local, remote } = buildRcloneArgs(cfg, hDir, "pull");
      const args = ["copy", remote, local, ...syncIncludeFlags()];
      if (opts.dryRun) args.push("--dry-run");
      if (opts.verbose) args.push("-v");
      const r = spawnSync("rclone", args, { stdio: "inherit" });
      emit.setExitCode(r.status ?? 1);
    });

  sync
    .command("list")
    .description("List what's currently in the remote (rclone lsf).")
    .option("--depth <n>", "Max recursion depth", "4")
    .action((opts: { depth: string }) => {
      if (!checkRclone(emit)) {
        emit.setExitCode(1);
        return;
      }
      const cfg = ensureConfig(emit);
      if (!cfg) {
        emit.setExitCode(1);
        return;
      }
      const remote = `${cfg.remote}:${cfg.prefix}`;
      const r = spawnSync("rclone", ["lsf", remote, "-R", "--max-depth", opts.depth], {
        stdio: "inherit",
      });
      emit.setExitCode(r.status ?? 1);
    });
}
