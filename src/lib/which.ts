import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Cross-runtime `which`: walk PATH (and PATHEXT on Windows) for an
 * executable. Node has no built-in and Bun.which only exists under Bun. */
export function whichBin(bin: string): string | undefined {
  if (isAbsolute(bin)) return isExecutable(bin) ? bin : undefined;
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext.toLowerCase());
      if (isExecutable(candidate)) return candidate;
      if (ext) {
        const upper = join(dir, bin + ext);
        if (isExecutable(upper)) return upper;
      }
    }
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
