/**
 * Image-feed reader for the harnery web UI.
 *
 * Source of truth is the canonical event stream: `image.captured` events in
 * `.harnery/events.ndjson` (emitted by agent-hooks when an agent views or
 * produces an image) point at content-addressed blobs in `.harnery/images/`.
 * This module groups those events by content hash (one card per distinct
 * image with a touch timeline) and resolves a blob path for the byte-serving
 * route. No sibling-JSON store: the event stream IS the context.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { harneryDir, readAgents, readInstanceIdentities, scanEventsTail } from "./coord-reader";

/** ext → HTTP content-type. Mirrors the IMAGE_EXTS set in the capture effect. */
const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

export function imagesDir(): string {
  return path.join(harneryDir(), "images");
}

/** The `data` payload of an `image.captured` event (see schema.ts ImageCaptured). */
export interface ImageCaptureData {
  hash: string;
  ext: string;
  bytes: number;
  role: "viewed" | "produced";
  source_path: string;
  tool_name: string;
  tool_use_id?: string;
  intent?: string;
  command_head?: string;
}

/** One touch of an image: a single `image.captured` event, name-resolved. */
export interface ImageTouch {
  instance_id: string;
  agent: string; // display name (`agent-<Name>` or raw id fallback)
  role: "viewed" | "produced";
  ts: string;
  source_path: string;
  tool_name: string;
  intent?: string;
  command_head?: string;
  harness?: string; // claude-code | cursor | codex, for the fallback hover card
}

/** A distinct image (one content hash), with every touch that referenced it. */
export interface ImageCapture {
  hash: string;
  ext: string;
  bytes: number;
  latest_ts: string;
  first_ts: string;
  touch_count: number;
  agents: string[]; // distinct display names that touched it
  roles: ("viewed" | "produced")[]; // distinct roles seen
  touches: ImageTouch[]; // newest-first
  blob_exists: boolean; // false once the janitor has pruned the blob
}

export interface ImageCapturesResponse {
  images: ImageCapture[];
  meta: {
    dir: string;
    distinct: number;
    total_touches: number;
  };
}

/** Resolve `instance_id → display name`, mirroring /events: live heartbeats
 * win, the durable start-event log fills in agents that have since ended. */
function buildNameMap(): Record<string, string> {
  const map: Record<string, string> = {};
  const snap = readAgents();
  for (const hb of [...snap.active, ...snap.stale]) map[hb.instance_id] = hb.name;
  const ids = readInstanceIdentities();
  for (const [iid, id] of Object.entries(ids)) {
    if (!map[iid]) map[iid] = id.name;
  }
  return map;
}

function displayName(instanceId: string | undefined, nameMap: Record<string, string>): string {
  if (!instanceId) return "unknown";
  const name = nameMap[instanceId];
  if (name) return name.startsWith("agent-") ? name : `agent-${name}`;
  return `agent-${instanceId.slice(0, 8)}`;
}

/**
 * Read + group `image.captured` events into distinct-image cards, newest first.
 * `limit` caps the number of distinct images returned (not raw events).
 */
export function readImageCaptures(opts: { limit?: number } = {}): ImageCapturesResponse {
  const limit = opts.limit ?? 300;
  const dir = imagesDir();

  const nameMap = buildNameMap();
  const blobExt = blobExtIndex(dir); // hash → ext present on disk

  const byHash = new Map<string, ImageCapture>();
  let totalTouches = 0;

  // Tail-scan the ledger newest-first. `image.captured` events are sparse, so
  // we walk back (bounded by scanEventsTail's cap) collecting the newest
  // `limit` distinct images; the whole-file readFileSync this replaced silently
  // returned [] once events.ndjson passed V8's ~512MB max string length.
  scanEventsTail((row) => {
    if (row.event_type !== "image.captured") return;
    const d = row.data as unknown as ImageCaptureData | undefined;
    if (!d?.hash) return;
    const existing = byHash.get(d.hash);
    // Newest `limit` distinct images already collected — the next new hash is
    // an older image the feed won't show, so stop the scan.
    if (!existing && byHash.size >= limit) return false;

    const ts = row.ts ?? "";
    const touch: ImageTouch = {
      instance_id: row.instance_id ?? "",
      agent: displayName(row.instance_id, nameMap),
      role: d.role,
      ts,
      source_path: d.source_path,
      tool_name: d.tool_name,
      intent: d.intent,
      command_head: d.command_head,
      harness: row.harness,
    };
    totalTouches++;

    if (existing) {
      existing.touches.push(touch);
      existing.touch_count++;
      if (ts > existing.latest_ts) existing.latest_ts = ts;
      if (ts < existing.first_ts) existing.first_ts = ts;
      if (!existing.agents.includes(touch.agent)) existing.agents.push(touch.agent);
      if (!existing.roles.includes(touch.role)) existing.roles.push(touch.role);
    } else {
      byHash.set(d.hash, {
        hash: d.hash,
        ext: d.ext,
        bytes: d.bytes,
        latest_ts: ts,
        first_ts: ts,
        touch_count: 1,
        agents: [touch.agent],
        roles: [touch.role],
        touches: [touch],
        blob_exists: blobExt.has(d.hash),
      });
    }
  });

  const images = [...byHash.values()];
  for (const img of images) {
    img.touches.sort((a, b) => (a.ts < b.ts ? 1 : -1)); // newest-first
  }
  images.sort((a, b) => (a.latest_ts < b.latest_ts ? 1 : -1));

  return {
    images: images.slice(0, limit),
    meta: { dir, distinct: byHash.size, total_touches: totalTouches },
  };
}

/** Allowed thumbnail widths. A small allowlist so `?w=` can't be driven to
 * arbitrary sizes that fill the blob store with one-off renders. 360 is the
 * grid (2× the ~180px cell for retina); 720 covers a larger preview. */
const THUMB_WIDTHS = new Set([180, 360, 720]);

export interface ResolvedThumb {
  /** OPEN read-only fd on the cached thumbnail; caller owns it (hand to a
   * stream with autoClose, or closeSync). Same fd-not-path contract as
   * resolveBlob so the byte route can never re-open by path. */
  fd: number;
  contentType: string;
  size: number;
}

/**
 * Resolve a small WebP thumbnail for a blob, generating + disk-caching it on
 * first request. Thumbnails live beside the blob as `<hash>.w<width>.webp`:
 * invisible to `blobExtIndex`/`resolveBlob` (they fail the bare-sha256 name
 * test) yet still pruned by `imageJanitor`, which sweeps every regular file in
 * the dir by mtime — so no orphan leak and no janitor change.
 *
 * Returns null when the width isn't allowlisted, the source is missing or a
 * vector/animated format best served whole (svg/gif), or `sharp` isn't
 * installed. The route then falls back to the full blob, so a host without
 * sharp still serves images correctly — just without the scroll win. sharp is
 * imported lazily so its absence is a graceful fallback, never a load error.
 *
 * The gallery grid renders 300+ cards; the blobs are full-page screenshots
 * (routinely 1280×3900, 5-15 MB PNG). Decoding those into 180px cells held
 * hundreds of MB of decoded bitmap and hung scroll. A 360px WebP is ~40-60 KB
 * and decodes in well under a millisecond.
 */
export async function resolveThumb(hash: string, width: number): Promise<ResolvedThumb | null> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  if (!THUMB_WIDTHS.has(width)) return null;
  const dir = imagesDir();
  if (!existsSync(dir)) return null;
  const srcExt = blobExtIndex(dir).get(hash);
  if (!srcExt || srcExt === "svg" || srcExt === "gif") return null; // serve vector/animated whole

  // Crop to the grid cell's 4:3 box (not width-only). Full-page screenshots
  // here run to extreme heights — one is 1280x179095 — so a width-only resize
  // produced a 360x50333 image that BOTH decoded to a huge bitmap AND exceeded
  // WebP's 16383px max dimension, making sharp throw and the route fall back to
  // serving the multi-MB source PNG (a ~470ms decode per scroll frame). Cover
  // to a fixed w×(3/4·w) box: every thumbnail is tiny and uniform, anchored at
  // the top (the meaningful part of a page capture). `.t` prefix, not `.w`, so
  // any stale width-only cache from before this change is ignored + janitored.
  const height = Math.round((width * 3) / 4);
  const thumbPath = path.join(dir, `${hash}.t${width}.webp`);
  if (!existsSync(thumbPath)) {
    let sharp: typeof import("sharp").default;
    try {
      sharp = (await import("sharp")).default;
    } catch {
      return null; // sharp not installed on this host → caller serves full blob
    }
    try {
      // limitInputPixels:false: these are our own content-addressed blobs, and
      // a very tall screenshot legitimately exceeds sharp's default pixel cap.
      const buf = await sharp(path.join(dir, `${hash}.${srcExt}`), { limitInputPixels: false })
        .resize(width, height, { fit: "cover", position: "top" })
        .webp({ quality: 72 })
        .toBuffer();
      // Atomic publish via a uniquely-named temp so concurrent generators for
      // the same thumb never clobber a half-written file (rename is atomic;
      // identical content makes last-writer-wins harmless).
      const tmp = `${thumbPath}.${randomUUID()}.tmp`;
      writeFileSync(tmp, buf);
      renameSync(tmp, thumbPath);
    } catch {
      return null; // corrupt/undecodable source → fall back to full blob
    }
  }

  let fd: number;
  try {
    fd = openSync(thumbPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      closeSync(fd);
      return null;
    }
    return { fd, contentType: "image/webp", size: st.size };
  } catch {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    return null;
  }
}

/** Build a `hash → ext` index of the blobs actually present on disk. */
function blobExtIndex(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const dot = name.lastIndexOf(".");
    if (dot < 0) continue;
    const hash = name.slice(0, dot);
    const ext = name.slice(dot + 1).toLowerCase();
    if (/^[a-f0-9]{64}$/.test(hash) && CONTENT_TYPES[ext]) out.set(hash, ext);
  }
  return out;
}

export interface ResolvedBlob {
  /** OPEN read-only fd: caller owns it and MUST close it (or hand it to a
   * stream with autoClose). Returned instead of a path string so the route
   * can never re-open by path: a check-then-reopen has the same TOCTOU shape
   * the universal file viewer's `resolveFile` closes. */
  fd: number;
  ext: string;
  contentType: string;
  size: number;
}

/**
 * Resolve a content hash to an open fd on its on-disk blob for the
 * byte-serving route. Validates the hash is a bare sha256 hex (no path
 * traversal possible) and that the blob is a regular file. Returns null
 * otherwise.
 */
export function resolveBlob(hash: string): ResolvedBlob | null {
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  const dir = imagesDir();
  if (!existsSync(dir)) return null;
  const ext = blobExtIndex(dir).get(hash);
  if (!ext) return null;
  const full = path.join(dir, `${hash}.${ext}`);
  let fd: number;
  try {
    // O_NOFOLLOW: the blob store is flat and written by the capture effect, so
    // a symlink here is wrong by construction. O_NONBLOCK: never hang on a
    // special file (same posture as lib/files.ts).
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      closeSync(fd);
      return null;
    }
    return {
      fd,
      ext,
      contentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
      size: st.size,
    };
  } catch {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    return null;
  }
}
