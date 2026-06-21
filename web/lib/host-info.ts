/**
 * Browser-safe host-info type + default bin name. NO `node:*` imports here, so
 * client components (e.g. HostInfoProvider) can import these without webpack
 * dragging server-only `fs` code into the browser bundle. The server-side
 * reader that actually computes a HostInfo lives in ./config.
 */

export interface HostInfo {
  /** Host CLI bin name (e.g. `myapp`) for agent-facing command strings. */
  binName: string;
  /** Absolute coord root, used to shorten absolute paths for display. */
  repoRoot: string;
}

export const DEFAULT_BIN_NAME = "harn";
