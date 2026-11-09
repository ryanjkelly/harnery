import { rmSync } from "node:fs";

/**
 * Remove a test directory. On Windows a just-closed Chrome profile, child
 * process or scanner can keep it busy for a moment (EBUSY/EPERM), and Bun's
 * rmSync ignores `maxRetries`, so retry there for up to `timeoutMs`.
 */
export function removeDir(path: string, timeoutMs = 15_000): void {
  const deadline = Date.now() + (process.platform === "win32" ? timeoutMs : 0);
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || Date.now() >= deadline) throw error;
      Bun.sleepSync(100);
    }
  }
}
