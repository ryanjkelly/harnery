import { existsSync } from "node:fs";
import { platform } from "node:os";

/**
 * Where WSL finds the Windows tools Harnery shells out to. A WSL process
 * started outside an interactive shell (a service, a supervisor, a dashboard
 * server) often has no Windows folders on PATH, so a bare `cmd.exe` fails
 * there even though interop works. Use the standard install path when it
 * exists and fall back to the bare name on native Windows or unusual layouts.
 */
const WSL_PATHS = {
  "cmd.exe": "/mnt/c/Windows/System32/cmd.exe",
  "powershell.exe": "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
} as const;

export type WindowsTool = keyof typeof WSL_PATHS;

export function windowsExecutable(
  tool: WindowsTool,
  deps: { platform?: NodeJS.Platform; exists?: (path: string) => boolean } = {},
): string {
  if ((deps.platform ?? platform()) !== "linux") return tool;
  const path = WSL_PATHS[tool];
  return (deps.exists ?? existsSync)(path) ? path : tool;
}
