import { createHash } from "node:crypto";

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
