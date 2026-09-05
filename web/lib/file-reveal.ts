import { execFile as execFileCallback } from "node:child_process";
import { closeSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { coordRoot } from "./coord-reader";
import { explorerRevealArgs } from "./file-reveal-windows";
import { resolveFile } from "./files";

const execFile = promisify(execFileCallback);

export type FileManagerName = "Explorer" | "Finder" | "file manager";

export interface NativeRevealPlan {
  command: string;
  args: string[];
  manager: FileManagerName;
}

/** Pure platform routing, exported so the argv contract is testable without
 * launching a desktop application. Both WSL paths are required under WSL. */
export function nativeRevealPlan(
  absoluteFile: string,
  options: {
    platform?: NodeJS.Platform;
    wsl?: boolean;
    wslPowerShellPath?: string;
    wslWindowsPath?: string;
  } = {},
): NativeRevealPlan | null {
  const platform = options.platform ?? process.platform;
  const wsl = options.wsl ?? Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
  if (platform === "darwin") {
    return { command: "open", args: ["-R", absoluteFile], manager: "Finder" };
  }
  if (platform === "win32") {
    return {
      command: path.win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      args: explorerRevealArgs(absoluteFile),
      manager: "Explorer",
    };
  }
  if (platform === "linux" && wsl) {
    if (!options.wslPowerShellPath || !options.wslWindowsPath) return null;
    return {
      command: options.wslPowerShellPath,
      args: explorerRevealArgs(options.wslWindowsPath),
      manager: "Explorer",
    };
  }
  if (platform === "linux") {
    return {
      command: "xdg-open",
      args: [path.dirname(absoluteFile)],
      manager: "file manager",
    };
  }
  return null;
}

export type RevealOutcome =
  | { ok: true; manager: FileManagerName }
  | { ok: false; status: number; error: string; detail: string | null };

/** One native command per request. Windows uses the shell API's result, not
 * explorer.exe's unreliable exit status, and opens and raises in one script. */
export async function launchNativeReveal(plan: NativeRevealPlan): Promise<void> {
  await execFile(plan.command, plan.args, { encoding: "utf8", timeout: 8_000, windowsHide: true });
}

/** Validate through the same fail-closed resolver used by file serving, then
 * hand only its canonical in-repository path to the native file manager. */
export async function revealInNativeFileManager(rawPath: string): Promise<RevealOutcome> {
  const resolved = resolveFile(rawPath);
  if (!resolved.ok) {
    return {
      ok: false,
      status: resolved.status,
      error: resolved.code,
      detail: resolved.detail ?? null,
    };
  }
  closeSync(resolved.fd);

  const absoluteFile = path.resolve(coordRoot(), ...resolved.relPath.split("/"));
  const wsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
  let wslPowerShellPath: string | undefined;
  let wslWindowsPath: string | undefined;
  try {
    if (process.platform === "linux" && wsl) {
      const [convertedFile, convertedPowerShell] = await Promise.all([
        execFile("wslpath", ["-w", absoluteFile], {
          encoding: "utf8",
          timeout: 5_000,
        }),
        execFile(
          "wslpath",
          ["-u", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
          {
            encoding: "utf8",
            timeout: 5_000,
          },
        ),
      ]);
      wslWindowsPath = convertedFile.stdout.trim();
      wslPowerShellPath = convertedPowerShell.stdout.trim();
      if (!wslWindowsPath || !wslPowerShellPath) throw new Error("wslpath returned an empty path");
    }
    const plan = nativeRevealPlan(absoluteFile, { wsl, wslPowerShellPath, wslWindowsPath });
    if (!plan) {
      return {
        ok: false,
        status: 501,
        error: "unsupported_platform",
        detail: `No native file manager integration for ${process.platform}`,
      };
    }
    await launchNativeReveal(plan);
    return { ok: true, manager: plan.manager };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: "launch_failed",
      detail: (err as Error).message,
    };
  }
}
