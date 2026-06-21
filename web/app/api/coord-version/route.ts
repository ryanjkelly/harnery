/**
 * Cheap change-detection endpoint for the polling fallback in LiveRefresher.
 *
 * When the SSE stream can't be used (e.g. Cloudflare's `harn tunnel` quick tunnel
 * buffers `text/event-stream` wholesale), the client polls this instead and
 * only calls router.refresh() when `v` changes, so an idle dashboard sits
 * still rather than re-rendering on every tick. Returns a tiny JSON body
 * (normal responses aren't buffered by the tunnel, only event streams are).
 *
 * `v` is a hash over the mtime+size of everything the SSE route fs.watches:
 * the events log (catches appends) plus the top-level entries of the active /
 * councils / scratch dirs (catches heartbeat writes, council edits, etc.).
 * Just stats, no file-content reads, so it's sub-millisecond per call.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { activeDir, councilsDir, eventsPath, scratchDir } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";

function statSig(p: string): string {
  try {
    const st = statSync(p);
    return `${Math.floor(st.mtimeMs)}:${st.size}`;
  } catch {
    return "-";
  }
}

function dirSig(dir: string): string {
  if (!existsSync(dir)) return "";
  try {
    return readdirSync(dir)
      .sort()
      .map((name) => `${name}=${statSig(path.join(dir, name))}`)
      .join(",");
  } catch {
    return "";
  }
}

export function GET(): Response {
  const raw = [
    `events:${statSig(eventsPath())}`,
    `active:${dirSig(activeDir())}`,
    `councils:${dirSig(councilsDir())}`,
    `scratch:${dirSig(scratchDir())}`,
  ].join("|");
  const v = createHash("sha1").update(raw).digest("hex").slice(0, 16);
  return Response.json({ v }, { headers: { "Cache-Control": "no-store" } });
}
