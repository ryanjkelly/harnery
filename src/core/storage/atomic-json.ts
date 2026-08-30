import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Write one private JSON projection without exposing a partial frame to readers. */
export function writePrivateJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Windows does not expose POSIX modes. The atomic write still applies.
  }
  renameSync(temporary, path);
}
