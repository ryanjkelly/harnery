import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EmitContext } from "../commander.ts";

/**
 * Lazy-fetch of the web dashboard for npm consumers.
 *
 * The published npm package ships the CLI + coord engine but deliberately
 * excludes `web/` (ADR 0001/0003: keep the core lean for CLI-only users). The
 * dashboard also imports harnery's `src/` directly (see `web/next.config.ts`),
 * so it can't be lifted out as a standalone folder. Instead, the first time
 * `harn web up` runs from an install without a local `web/`, we clone the
 * harnery repo at the *matching version tag* into a cache dir and install the
 * web app's deps. Subsequent runs reuse the cache.
 *
 * `web/` imports readers from `src/`, and `web/next.config.ts` resolves the
 * root `playwright` package, so the install covers the repository root and
 * then `web/`. Installing the `playwright` package downloads no browsers.
 * Installing `web/` alone left `harn web up` failing with
 * `Cannot find module 'playwright/package.json'`.
 */

const DEFAULT_REPO_URL = "https://github.com/ryanjkelly/harnery.git";

/** harnery's own package root: src/commands/ -> ../.. ; valid in both src/ and dist/. */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

function readPkg(): { version: string; repoUrl: string } {
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8"));
    const raw = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? "");
    const repoUrl = raw.replace(/^git\+/, "") || DEFAULT_REPO_URL;
    return { version: typeof pkg.version === "string" ? pkg.version : "0.0.0", repoUrl };
  } catch {
    return { version: "0.0.0", repoUrl: DEFAULT_REPO_URL };
  }
}

/** The git ref to fetch: HARNERY_WEB_REF override, else the version tag (`v<version>`). */
function resolveRef(version: string): string {
  return process.env.HARNERY_WEB_REF || `v${version}`;
}

/** Per-ref cache dir under the XDG cache (matches harnery's `~/.cache/harnery/...`). */
function webCacheRoot(ref: string): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const safeRef = ref.replace(/[^\w.-]/g, "_");
  return path.join(base, "harnery", "web", safeRef);
}

/** bun if available (preferred), else npm. Both support `<runner> install` and `<runner> run <script>`. */
export function webRunner(spawn: typeof spawnSync = spawnSync): "bun" | "npm" {
  const r = spawn("bun", ["--version"], { stdio: "ignore" });
  return r.status === 0 ? "bun" : "npm";
}

/**
 * Ensure a cached harnery checkout's `web/` exists for this version and return
 * its path, fetching (clone + install) on first use. Returns null on failure
 * (after emitting an actionable error).
 */
export function lazyFetchWebRoot(
  emit: EmitContext,
  spawn: typeof spawnSync = spawnSync,
): string | null {
  const { version, repoUrl } = readPkg();
  const ref = resolveRef(version);
  const cacheRoot = webCacheRoot(ref);
  const webDir = path.join(cacheRoot, "web");

  // node_modules in both the cached root and web/ is the "fetched + installed" marker.
  if (
    existsSync(path.join(cacheRoot, "node_modules")) &&
    existsSync(path.join(webDir, "node_modules"))
  ) {
    emit.log(`harn web · using cached dashboard (${ref})`, "info");
    return webDir;
  }

  emit.log(
    `harn web · dashboard is not bundled in the npm package; fetching harnery ${ref} (one-time)`,
    "info",
  );
  emit.log(`           into ${cacheRoot}  ·  clone + web/ deps; pass --no-fetch to skip`, "info");

  // Clear any partial/stale state so a retry is clean.
  if (existsSync(cacheRoot)) rmSync(cacheRoot, { recursive: true, force: true });
  mkdirSync(path.dirname(cacheRoot), { recursive: true });

  const clone = spawn("git", ["clone", "--depth", "1", "--branch", ref, repoUrl, cacheRoot], {
    stdio: "inherit",
  });
  if (clone.status !== 0) {
    emit.error({
      code: "web_fetch_failed",
      message: `git clone of ${repoUrl} @ ${ref} failed${clone.error ? `: ${clone.error.message}` : ` (status ${clone.status})`}`,
      hint:
        "Fetching the dashboard needs git + network. Do it manually: " +
        `git clone ${repoUrl} && cd harnery/web && ${webRunner()} install, then run it pointed at your project via HARNERY_COORD_ROOT. ` +
        "See https://harnery.com/cli/web/.",
    });
    return null;
  }

  const runner = webRunner(spawn);
  for (const dir of [cacheRoot, webDir]) {
    const where = dir === webDir ? "web/" : "the harnery root";
    emit.log(`harn web · installing dashboard deps (${runner} install in ${where})`, "info");
    const install = spawn(runner, ["install"], { cwd: dir, stdio: "inherit" });
    if (install.status !== 0) {
      emit.error({
        code: "web_fetch_failed",
        message: `${runner} install in ${dir} failed (status ${install.status})`,
        hint: `Try manually: cd ${dir} && ${runner} install`,
      });
      return null;
    }
  }

  emit.log(`harn web · dashboard ready (cached at ${webDir})`, "info");
  return webDir;
}
