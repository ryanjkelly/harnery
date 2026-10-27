import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = {
  harn: "cli",
  "agent-hook": "core/hooks/cli",
  "agent-coord": "core/agents/cli",
};

export function launch(name, args = process.argv.slice(2)) {
  const entry = entries[name];
  if (!entry) throw new Error(`Unknown Harnery executable: ${name}`);
  const executable = process.platform === "win32" ? "bun.exe" : "bun";
  const candidates = [
    ...(process.versions.bun ? [process.execPath] : []),
    ...(process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, executable)),
    join(process.env.BUN_INSTALL || join(homedir(), ".bun"), "bin", executable),
    // npm's Windows shim is a .cmd file; spawn the installed binary directly.
    join(dirname(process.execPath), "node_modules", "bun", "bin", executable),
  ];
  const bun = candidates.find((candidate) => existsSync(candidate));
  const built = join(root, "dist", `${entry}.js`);
  const runtime = bun || process.execPath;
  const script = bun ? join(root, "src", `${entry}.ts`) : built;
  if (!existsSync(script)) {
    console.error(`${name}: install Bun to run this source checkout, or build dist/ for Node.`);
    process.exitCode = 1;
    return;
  }
  const child = spawnSync(runtime, [script, ...args], { stdio: "inherit", windowsHide: true });
  if (child.error) console.error(`${name}: ${child.error.message}`);
  process.exitCode = child.status ?? 1;
}

// Native hook commands keep the executable name as an argument so managed
// hook inspection can identify the same `agent-hook <event>` contract.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launch(process.argv[2], process.argv.slice(3));
}
