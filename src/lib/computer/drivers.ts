/**
 * Desktop driver registry for `harn computer` (ADR 0231).
 *
 * Harnery ships two pinned drivers that complement each other on one desktop:
 * Cua Driver (tool calls, pixel routes, screenshots, isolated browser control)
 * and agent-desktop (accessibility-tree snapshots with snapshot-scoped refs, no
 * daemon). Both share the one desktop lease. The command resolves a driver by
 * id here and never branches on which one it got.
 *
 * Internal module: not exported from package.json.
 */
import type { DesktopDriver } from "./types.ts";

export const DRIVER_IDS = ["cua", "agent-desktop"] as const;
export type DriverId = (typeof DRIVER_IDS)[number];
export const DEFAULT_DRIVER: DriverId = "cua";

/** Load every driver adapter (lazily, so commands that never touch a driver stay cheap). */
export async function loadDrivers(): Promise<DesktopDriver[]> {
  const [{ cuaDriver }, { agentDesktopDriver }] = await Promise.all([
    import("./cua.ts"),
    import("./agent-desktop.ts"),
  ]);
  return [cuaDriver, agentDesktopDriver];
}
