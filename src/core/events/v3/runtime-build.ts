import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export { liveEventV3BuildId, livePlatformV3 } from "./runtime-identity.ts";

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
