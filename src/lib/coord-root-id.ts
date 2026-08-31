import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { DEFAULT_WEB_PORT } from "./local-file-url.ts";

/** Local-only endpoint used to prove that a dashboard serves the caller's repo. */
export const COORD_ROOT_ID_PATH = "/api/coord-root";

/**
 * Opaque identity for a canonical coordination root. The path stays local;
 * only its digest crosses the dashboard boundary.
 */
export function coordRootId(root: string): string {
  const canonical = realpathSync(root);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function localCoordRootIdUrl(
  port: number | string = DEFAULT_WEB_PORT,
  protocol = "http:",
): string {
  const portPart = String(port) === "" ? "" : `:${port}`;
  return `${protocol}//127.0.0.1${portPart}${COORD_ROOT_ID_PATH}`;
}
