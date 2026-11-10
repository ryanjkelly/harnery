import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "./remove-dir.ts";

/**
 * Plant a fake CLI named `name` in `dir` whose behaviour is the ES module
 * source `script`, run by this test's Bun. Spawning resolves it the way it
 * resolves a real installed CLI on the host OS:
 *
 * - POSIX: `<dir>/<name>` is a `#!/bin/sh` shim that execs Bun on the script.
 * - Windows: `<dir>/<name>.exe` is a real executable (a compiled launcher that
 *   imports the `<name>.fake.mjs` beside it). A `.cmd` shim would not do:
 *   `child_process` refuses to spawn batch files without a shell, and a bare
 *   name only resolves to `.com`/`.exe`.
 *
 * Returns the planted executable's path.
 */
export function plantFakeCli(dir: string, name: string, script: string): string {
  const scriptPath = join(dir, `${name}.fake.mjs`);
  writeFileSync(scriptPath, `${script}\n`);
  if (process.platform === "win32") {
    const exe = join(dir, `${name}.exe`);
    rmSync(exe, { force: true });
    const launcher = windowsLauncher();
    try {
      linkSync(launcher, exe);
    } catch {
      copyFileSync(launcher, exe);
    }
    return exe;
  }
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(scriptPath)} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const LAUNCHER_SOURCE = `import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const exe = process.execPath;
const name = basename(exe).replace(/\\.exe$/i, "");
await import(pathToFileURL(join(dirname(exe), name + ".fake.mjs")).href);
`;

let cachedLauncher: string | undefined;

/** Compile the launcher once per Bun version and cache it in the OS temp dir
 * (compiling costs seconds; every fake is then a hard link to it). */
function windowsLauncher(): string {
  if (cachedLauncher) return cachedLauncher;
  const key = createHash("sha256")
    .update(`${Bun.version}\0${LAUNCHER_SOURCE}`)
    .digest("hex")
    .slice(0, 16);
  const target = join(tmpdir(), `harnery-fake-cli-launcher-${key}.exe`);
  if (!existsSync(target)) {
    const work = mkdtempSync(join(tmpdir(), "harnery-fake-cli-build-"));
    try {
      const source = join(work, "launcher.ts");
      const out = join(work, "launcher.exe");
      writeFileSync(source, LAUNCHER_SOURCE);
      const built = spawnSync(process.execPath, ["build", "--compile", source, "--outfile", out], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (built.status !== 0 || !existsSync(out)) {
        throw new Error(`could not compile the fake CLI launcher: ${built.stderr || built.error}`);
      }
      try {
        renameSync(out, target);
      } catch (error) {
        // A concurrent test process may have installed it first.
        if (!existsSync(target)) throw error;
      }
    } finally {
      removeDir(work);
    }
  }
  cachedLauncher = target;
  return target;
}
