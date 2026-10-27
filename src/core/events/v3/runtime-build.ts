import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
      windowsHide: true,
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
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

export interface HarneryBuild {
  version: string;
  revision: string;
}

/** The installed package version and runtime revision; "unknown" when unreadable. */
export function installedHarneryBuild(): HarneryBuild {
  let version = "unknown";
  let revision = "unknown";
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(harneryPackageRoot(), "package.json"), "utf8"),
    ) as { version?: unknown };
    if (typeof manifest.version === "string" && manifest.version.length <= 100)
      version = manifest.version;
  } catch {
    // Missing package metadata cannot establish that a running build is current.
  }
  try {
    revision = currentHarneryRuntimeBuild();
  } catch {
    // Status still reports the unavailable build instead of guessing a match.
  }
  return { version, revision };
}

export interface ServiceBuildStatus {
  running_build: HarneryBuild | null;
  installed_build: HarneryBuild;
  restart_needed: boolean;
  build_status: string;
}

/** A missing or unknown running build, or any difference, means restart. */
export function serviceBuildStatus(recorded: unknown): ServiceBuildStatus {
  const installed_build = installedHarneryBuild();
  const candidate = recorded as Partial<HarneryBuild> | undefined;
  const known = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 100 && value !== "unknown";
  const running_build =
    candidate && known(candidate.version) && known(candidate.revision)
      ? { version: candidate.version, revision: candidate.revision }
      : null;
  const restart_needed =
    running_build === null ||
    installed_build.version === "unknown" ||
    installed_build.revision === "unknown" ||
    running_build.version !== installed_build.version ||
    running_build.revision !== installed_build.revision;
  return {
    running_build,
    installed_build,
    restart_needed,
    build_status:
      running_build === null
        ? "running build unknown; restart needed"
        : restart_needed
          ? "restart needed"
          : "current",
  };
}
