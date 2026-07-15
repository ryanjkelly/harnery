import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { coordEnv } from "../env.ts";

/**
 * Managed ripgrep provisioning for `grep --files` / content search.
 *
 * harnery can install a pinned, checksum-verified ripgrep into its own tools
 * directory (`$XDG_DATA_HOME/harnery/tools`, default `~/.local/share/harnery/
 * tools`) so `harn grep` gets the fast engine even on machines where nobody
 * ever installed rg. The download is version-pinned and every artifact's
 * sha256 is baked in below (cross-checked against the official release
 * checksums), so the install is reproducible, never "whatever is latest."
 *
 * Consent model: the installer only runs automatically when the host project
 * opts in via `.harnery/config.jsonc` `{ "tools": { "ripgrep": { "autoInstall":
 * true } } }` — a repo commits that once and every clone self-heals. Without
 * the opt-in, a missing rg produces a rate-limited stderr hint naming
 * `harn doctor --fix` (explicit install). Environments that forbid downloads
 * lose nothing: every failure path falls back to GNU grep.
 */

export const RG_VERSION = "14.1.1";

/** sha256 pins verified against the official ripgrep release .sha256 assets. */
const ARTIFACTS: Record<string, { name: string; sha256: string }> = {
  "linux-x64": {
    name: `ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: "4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e",
  },
  "linux-arm64": {
    name: `ripgrep-${RG_VERSION}-aarch64-unknown-linux-gnu.tar.gz`,
    sha256: "c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f",
  },
  "darwin-x64": {
    name: `ripgrep-${RG_VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: "fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3",
  },
  "darwin-arm64": {
    name: `ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: "24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be",
  },
};

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/** True when a pinned artifact exists for this OS/arch (Windows: not yet). */
export function rgInstallSupported(): boolean {
  return platformKey() in ARTIFACTS;
}

/** Machine-level harnery tools dir (NOT the per-project .harnery/ state dir). */
export function toolsDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".local", "share");
  return join(base, "harnery", "tools");
}

/** Path the managed rg binary lives at once installed. */
export function managedRgPath(): string {
  return join(toolsDir(), "rg");
}

function isExecutable(p: string): boolean {
  try {
    const r = spawnSync(p, ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Locate a usable ripgrep. Precedence:
 *   1. HARNERY_RG_PATH (explicit override)
 *   2. the managed tools-dir install (works even when PATH doesn't carry it)
 *   3. `rg` on PATH
 * Returns the spawnable path/name, or null when none respond to --version.
 */
export function findRg(): string | null {
  const override = coordEnv("RG_PATH");
  if (override && override.trim() !== "") {
    return isExecutable(override) ? override : null;
  }
  const managed = managedRgPath();
  if (existsSync(managed) && isExecutable(managed)) return managed;
  if (isExecutable("rg")) return "rg";
  return null;
}

/**
 * Download + verify + install the pinned ripgrep into the tools dir.
 * Atomic: extracts to a temp dir and renames the binary into place.
 * Throws on unsupported platform, network failure, or checksum mismatch —
 * callers are expected to fall back to grep and say why.
 */
export async function installRg(log?: (line: string) => void): Promise<string> {
  const key = platformKey();
  const artifact = ARTIFACTS[key];
  if (!artifact) {
    throw new Error(
      `no pinned ripgrep artifact for ${key} — install ripgrep manually (https://github.com/BurntSushi/ripgrep#installation)`,
    );
  }

  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${artifact.name}`;
  log?.(`downloading ${artifact.name} (pinned ${RG_VERSION})...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) {
    throw new Error(
      `sha256 mismatch for ${artifact.name}: expected ${artifact.sha256}, got ${digest} — refusing to install`,
    );
  }

  const work = join(tmpdir(), `harnery-rg-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const tarball = join(work, artifact.name);
    writeFileSync(tarball, bytes);
    await extractTar(tarball, work);

    const extractedRg = join(work, artifact.name.replace(/\.tar\.gz$/, ""), "rg");
    const rgStat = await stat(extractedRg);
    if (!rgStat.isFile()) throw new Error(`extracted archive missing rg binary at ${extractedRg}`);

    mkdirSync(toolsDir(), { recursive: true });
    const dest = managedRgPath();
    // rename() can't cross filesystems (tmp is often tmpfs); copy + rename
    // within the destination dir keeps the final placement atomic.
    const staged = `${dest}.tmp-${process.pid}`;
    writeFileSync(staged, await readFile(extractedRg));
    chmodSync(staged, 0o755);
    renameSync(staged, dest);

    if (!isExecutable(dest)) {
      rmSync(dest, { force: true });
      throw new Error(`installed rg at ${dest} but it failed to execute`);
    }
    log?.(`installed ripgrep ${RG_VERSION} -> ${dest}`);
    return dest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function extractTar(tarball: string, cwd: string): Promise<void> {
  return new Promise((resolveP, reject) => {
    const proc = spawn("tar", ["xzf", tarball], { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c: string) => {
      stderr += c;
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolveP();
      else reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Emit `line` to stderr at most once per 24h (stamp file in the tools dir).
 * Keeps the "rg missing" nudge from nagging on every single grep invocation.
 */
export function hintOncePerDay(line: string): void {
  try {
    const stamp = join(toolsDir(), ".rg-hint-stamp");
    if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < 24 * 60 * 60 * 1000) {
      return;
    }
    mkdirSync(toolsDir(), { recursive: true });
    writeFileSync(stamp, String(Date.now()));
  } catch {
    // stamping failed; still emit the hint
  }
  process.stderr.write(`${line}\n`);
}
