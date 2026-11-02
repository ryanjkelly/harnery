/**
 * Locate a real bash for running host-provided `.sh` scripts.
 *
 * On macOS and Linux this is just `bash` from PATH. Windows needs care: the
 * first `bash.exe` on PATH is often `%SystemRoot%\System32\bash.exe` (or the
 * `WindowsApps` alias), which is the WSL launcher. It runs the script inside a
 * Linux distribution, where a Windows path like `C:\repo\scripts\x.sh` does not
 * exist, or it fails outright when no distribution is installed. Git for
 * Windows ships a native bash that understands Windows paths, so prefer it.
 *
 * Precedence:
 *   1. HARNERY_BASH_PATH (explicit override, honored on every platform)
 *   2. non-Windows: `bash`
 *   3. Windows: Git for Windows' bash, derived from `git --exec-path`
 *   4. Windows: the standard Git for Windows install folders
 *   5. Windows: any `bash.exe` on PATH that is not the WSL launcher
 * Returns null when nothing usable exists, so best-effort callers can skip.
 *
 * Internal: not part of the package exports map.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { coordEnv } from "../env.ts";

/** Everything the resolver reads from the machine, injectable for tests. */
export interface BashProbe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Value of HARNERY_BASH_PATH, if set. */
  override: string | undefined;
  exists(path: string): boolean;
  /** Output of `git --exec-path`, or null when git is absent or fails. */
  gitExecPath(): string | null;
}

/** Case-insensitive env lookup: Windows env names are case-insensitive. */
function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function normalizeWin(path: string): string {
  return win32.normalize(path.trim().replace(/\//g, "\\"));
}

function isUnder(path: string, dir: string): boolean {
  const p = normalizeWin(path).toLowerCase();
  const d = normalizeWin(dir).toLowerCase().replace(/\\+$/, "");
  return p === d || p.startsWith(`${d}\\`);
}

/** The WSL launcher lives under %SystemRoot% (System32, Sysnative) or WindowsApps. */
function isWslLauncher(path: string, env: NodeJS.ProcessEnv): boolean {
  const systemRoot = envGet(env, "SystemRoot") ?? envGet(env, "windir") ?? "C:\\Windows";
  if (isUnder(path, systemRoot)) return true;
  return normalizeWin(path).toLowerCase().split("\\").includes("windowsapps");
}

/**
 * Git for Windows' install root from its exec path, e.g.
 * `C:/Program Files/Git/mingw64/libexec/git-core` → `C:\Program Files\Git`.
 */
export function gitRootFromExecPath(execPath: string): string | null {
  const parts = normalizeWin(execPath).split("\\");
  const n = parts.length;
  if (n < 4) return null;
  if (parts[n - 1]?.toLowerCase() !== "git-core") return null;
  if (parts[n - 2]?.toLowerCase() !== "libexec") return null;
  const root = parts.slice(0, n - 3).join("\\");
  return root === "" ? null : root;
}

function windowsCandidates(probe: BashProbe): string[] {
  const out: string[] = [];
  const execPath = probe.gitExecPath();
  if (execPath) {
    const root = gitRootFromExecPath(execPath);
    if (root) {
      out.push(win32.join(root, "bin", "bash.exe"), win32.join(root, "usr", "bin", "bash.exe"));
    }
  }
  for (const base of [
    envGet(probe.env, "ProgramFiles"),
    envGet(probe.env, "ProgramW6432"),
    envGet(probe.env, "ProgramFiles(x86)"),
  ]) {
    if (base) out.push(win32.join(base, "Git", "bin", "bash.exe"));
  }
  const localAppData = envGet(probe.env, "LOCALAPPDATA");
  if (localAppData) out.push(win32.join(localAppData, "Programs", "Git", "bin", "bash.exe"));
  for (const dir of (envGet(probe.env, "PATH") ?? "").split(";")) {
    const trimmed = dir.trim().replace(/^"|"$/g, "");
    if (trimmed) out.push(win32.join(trimmed, "bash.exe"));
  }
  return out;
}

/** Pure resolver over an injected probe. See the module comment for precedence. */
export function findBash(probe: BashProbe): string | null {
  const override = probe.override?.trim();
  if (override) {
    // A bare command name is left to PATH lookup; a path must exist.
    const bare = !/[\\/]/.test(override);
    return bare || probe.exists(override) ? override : null;
  }
  if (probe.platform !== "win32") return "bash";
  for (const candidate of windowsCandidates(probe)) {
    if (isWslLauncher(candidate, probe.env)) continue;
    if (probe.exists(candidate)) return candidate;
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultProbe(): BashProbe {
  return {
    platform: process.platform,
    env: process.env,
    override: coordEnv("BASH_PATH"),
    exists: isFile,
    gitExecPath: () => {
      try {
        const r = spawnSync("git", ["--exec-path"], {
          windowsHide: true,
          encoding: "utf8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const out = r.status === 0 ? (r.stdout ?? "").trim() : "";
        return out === "" ? null : out;
      } catch {
        return null;
      }
    },
  };
}

let cached: { value: string | null } | null = null;

/** The bash to spawn for `.sh` scripts on this machine, or null. Cached per process. */
export function resolveBash(): string | null {
  if (!cached) cached = { value: findBash(defaultProbe()) };
  return cached.value;
}

/** Test seam: forget the cached result so the next call probes again. */
export function resetBashCache(): void {
  cached = null;
}
