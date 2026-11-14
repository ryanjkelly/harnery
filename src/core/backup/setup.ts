import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { whichBin } from "../../lib/which.ts";
import type { BackupConfig } from "../config.ts";

export interface MissingBackupPrerequisite {
  code: "restic_missing" | "backup_password_missing" | "rclone_missing" | "rclone_remote_missing";
  message: string;
}

export interface BackupSetup {
  missing: readonly MissingBackupPrerequisite[];
}

/**
 * Inspect this machine's local setup without spawning tools, contacting the
 * repository, or reading the password. This proves presence, not working
 * credentials: encrypted/unreadable rclone config and other operational errors
 * remain the snapshot command's responsibility rather than silently disabling it.
 */
export function inspectBackupSetup(
  config: Pick<BackupConfig, "repo" | "passwordFile">,
): BackupSetup {
  const missing: MissingBackupPrerequisite[] = [];
  if (!whichBin("restic")) {
    missing.push({ code: "restic_missing", message: "restic is not on PATH" });
  }
  if (fileAbsent(config.passwordFile)) {
    missing.push({
      code: "backup_password_missing",
      message: `Backup password file is missing: ${config.passwordFile}`,
    });
  }
  if (config.repo.startsWith("rclone:")) {
    const binary = whichBin("rclone");
    if (!binary) {
      missing.push({ code: "rclone_missing", message: "rclone is not on PATH" });
    } else {
      // Inline backends (:local:...), local paths and connection strings are
      // resolved by rclone itself. A plain named remote needs local configuration.
      const remote = /^rclone:([^:,]+):/.exec(config.repo)?.[1];
      if (remote && !/^[a-zA-Z]:[\\/]/.test(config.repo.slice("rclone:".length))) {
        const envType = process.env[`RCLONE_CONFIG_${remote.toUpperCase()}_TYPE`];
        if (!envType && !hasRcloneRemote(binary, remote)) {
          missing.push({
            code: "rclone_remote_missing",
            message: `rclone remote "${remote}" is not configured on this machine`,
          });
        }
      }
    }
  }
  return { missing };
}

function absentError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function fileAbsent(file: string): boolean {
  try {
    // A directory is not a usable password/config file either.
    return !statSync(file).isFile();
  } catch (error) {
    return absentError(error);
  }
}

function rcloneConfigPaths(binary: string): string[] {
  if (process.env.RCLONE_CONFIG !== undefined) {
    return process.env.RCLONE_CONFIG ? [resolve(process.env.RCLONE_CONFIG)] : [];
  }
  let executable = binary;
  try {
    executable = realpathSync(binary);
  } catch {
    // A concurrently replaced executable can still be diagnosed by restic.
  }
  const paths = [join(dirname(executable), "rclone.conf")];
  if (process.platform === "win32" && process.env.APPDATA) {
    paths.push(join(process.env.APPDATA, "rclone", "rclone.conf"));
  }
  if (process.env.XDG_CONFIG_HOME) {
    paths.push(join(process.env.XDG_CONFIG_HOME, "rclone", "rclone.conf"));
  }
  const home =
    (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || homedir();
  paths.push(join(home, ".config", "rclone", "rclone.conf"), join(home, ".rclone.conf"));
  return paths;
}

function hasRcloneRemote(binary: string, remote: string): boolean {
  // Use the first existing file, matching rclone's config precedence. Never
  // fall through to a different config merely because a section is absent.
  for (const file of rcloneConfigPaths(binary)) {
    let text: string;
    try {
      if (!statSync(file).isFile()) return true;
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (absentError(error)) continue;
      return true; // Present but unreadable is a run failure, not missing setup.
    }
    if (/^RCLONE_ENCRYPT_V\d+:/m.test(text)) return true;
    return [...text.matchAll(/^\s*\[([^\]\r\n]+)\]\s*(?:[#;].*)?$/gm)].some(
      (match) => match[1] === remote,
    );
  }
  return false;
}
