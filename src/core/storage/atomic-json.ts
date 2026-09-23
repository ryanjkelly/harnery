import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stateDirMode, stateFileMode } from "./modes.ts";

/** Write one private JSON projection without exposing a partial frame to readers. */
export function writePrivateJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: stateDirMode() });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: stateFileMode(),
  });
  try {
    chmodSync(temporary, stateFileMode());
  } catch {
    // Windows does not expose POSIX modes. The atomic write still applies.
  }
  renameSync(temporary, path);
}
