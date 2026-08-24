import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Stable producer build id bound into one V3 epoch. */
export function liveEventV3BuildId(harneryBuild: string): `build_${string}` {
  const exact = harneryBuild.normalize("NFC");
  if (/^[a-zA-Z0-9._-]{1,120}$/.test(exact)) return `build_${exact}`;
  return `build_${createHash("sha256").update(exact).digest("hex")}`;
}

/** Platform recorded by runtime-owned V3 producers. */
export function livePlatformV3(): "linux" | "windows" | "macos" | "unknown" {
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "unknown";
}

/**
 * Identify the code running this producer.
 *
 * Source checkouts use the exact Git commit. Published packages use their
 * package version, which changes at the installation boundary without tying
 * the authority profile to a machine-specific install path.
 */
export function currentHarneryRuntimeBuild(): string {
  const root = harneryPackageRoot();
  if (existsSync(resolve(root, ".git"))) {
    const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const commit = result.status === 0 ? result.stdout.trim() : "";
    if (/^[0-9a-f]{40,64}$/.test(commit)) return commit;
  }

  const packagePath = resolve(root, "package.json");
  if (existsSync(packagePath)) {
    try {
      const value = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
      if (typeof value.version === "string" && /^[0-9A-Za-z._+-]{1,100}$/.test(value.version)) {
        return `npm-${value.version}`;
      }
    } catch {
      // A malformed package manifest falls through to a stable source digest.
    }
  }
  throw new Error("harnery_runtime_build_unavailable");
}

export function harneryPackageRoot(): string {
  return resolve(import.meta.dir, "../../../..");
}
