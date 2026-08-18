/**
 * Image-feed reader for the harnery web UI.
 *
 * V3 image observations carry only content-addressed references and safe
 * workspace-relative paths. Raw bytes stay in the bounded local blob store.
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
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { EventV3 } from "../../src/core/events/v3/contract";
import { readLedgerV3 } from "../../src/core/events/v3/reader";
import { coordRoot, harneryDir, readInstanceIdentities } from "./coord-reader";

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

/** One privacy-safe image-artifact observation, name-resolved. */
export interface ImageTouch {
  event_id?: string;
  instance_id: string;
  agent: string; // display name (`agent-<Name>` or raw id fallback)
  role: "viewed" | "produced";
  ts: string;
  source_path: string;
  tool_name: string;
  intent?: string;
  command_head?: string;
  adapter?: string; // claude-code | cursor | codex, for the fallback hover card
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
    source: "v3";
    authoritative: boolean;
    reason?: string;
  };
}

/**
 * Return the V3 image-artifact projection. Canonical artifact observations
 * supply attribution for new captures; retained pre-V3 blobs remain visible
 * as unattributed images instead of disappearing from the operator surface.
 */
export function readImageCaptures(opts: { limit?: number } = {}): ImageCapturesResponse {
  const dir = imagesDir();
  const blobs = blobIndex(dir);
  const ledger = readLedgerV3(coordRoot());
  const identities = readInstanceIdentities();
  const captures = projectImageCaptures(
    ledger.complete ? ledger.events.map(({ event }) => event) : [],
    blobs,
    identities,
  );
  const limit = Math.max(1, Math.min(opts.limit ?? Math.max(captures.length, 1), 2_000));
  const images = captures.slice(0, limit);
  return {
    images,
    meta: {
      dir,
      distinct: captures.length,
      total_touches: captures.reduce((sum, image) => sum + image.touch_count, 0),
      source: "v3",
      authoritative: ledger.complete,
      ...(!ledger.complete
        ? {
            reason:
              "V3 artifact metadata is temporarily unavailable; retained blobs are still listed",
          }
        : {}),
    },
  };
}

interface BlobInfo {
  ext: string;
  bytes: number;
  mtime: string;
}

interface IdentityLike {
  name: string;
  platform?: string | null;
}

/** Pure projection boundary, exported so blob/event joining stays fixture-testable. */
export function projectImageCaptures(
  events: readonly EventV3[],
  blobs: ReadonlyMap<string, BlobInfo>,
  identities: Readonly<Record<string, IdentityLike>>,
): ImageCapture[] {
  const byHash = new Map<string, ImageCapture>();
  const eventById = new Map(events.map((event) => [event.event_id, event]));

  for (const event of events) {
    if (event.event_type !== "artifact.observed") continue;
    const artifact = event.payload.artifact;
    if (artifact.kind !== "image") continue;
    const hash = artifact.artifact_id.startsWith("art_")
      ? artifact.artifact_id.slice("art_".length)
      : "";
    if (!/^[a-f0-9]{64}$/.test(hash)) continue;
    const ext = extForMediaType(artifact.media_type) ?? blobs.get(hash)?.ext;
    if (!ext) continue;
    const links = record(event.links);
    const causedBy = Array.isArray(links.caused_by)
      ? links.caused_by.filter((value): value is string => typeof value === "string")
      : [];
    const source = causedBy
      .map((eventId) => eventById.get(eventId))
      .find((candidate) =>
        candidate
          ? candidate.event_type === "tool.requested" || candidate.event_type === "tool.completed"
          : false,
      );
    const instanceId = event.scope.instance_id;
    const identity = identities[instanceId];
    const tool = record(source ? record(source.payload).tool : undefined);
    const role = event.payload.operation === "viewed" ? "viewed" : "produced";
    const touch: ImageTouch = {
      event_id: event.event_id,
      instance_id: instanceId,
      agent: identity?.name ?? instanceId,
      role,
      ts: event.time.observed_at,
      source_path: artifact.workspace_path ?? "",
      tool_name: stringValue(tool.name) ?? "unknown_tool",
      adapter: stringValue(tool.namespace) ?? identity?.platform ?? undefined,
    };
    const blob = blobs.get(hash);
    const existing = byHash.get(hash);
    if (existing) {
      existing.touches.push(touch);
      existing.touch_count += 1;
      if (!existing.agents.includes(touch.agent)) existing.agents.push(touch.agent);
      if (!existing.roles.includes(role)) existing.roles.push(role);
      if (touch.ts > existing.latest_ts) existing.latest_ts = touch.ts;
      if (touch.ts < existing.first_ts) existing.first_ts = touch.ts;
      continue;
    }
    byHash.set(hash, {
      hash,
      ext,
      bytes: artifact.bytes || blob?.bytes || 0,
      latest_ts: touch.ts,
      first_ts: touch.ts,
      touch_count: 1,
      agents: [touch.agent],
      roles: [role],
      touches: [touch],
      blob_exists: !!blob,
    });
  }

  for (const [hash, blob] of blobs) {
    const existing = byHash.get(hash);
    if (existing) {
      existing.blob_exists = true;
      existing.ext = blob.ext;
      existing.bytes = blob.bytes;
      continue;
    }
    byHash.set(hash, {
      hash,
      ext: blob.ext,
      bytes: blob.bytes,
      latest_ts: blob.mtime,
      first_ts: blob.mtime,
      touch_count: 0,
      agents: [],
      roles: [],
      touches: [],
      blob_exists: true,
    });
  }

  for (const image of byHash.values()) {
    image.touches.sort((a, b) => b.ts.localeCompare(a.ts));
    image.agents.sort();
  }
  return [...byHash.values()].sort((a, b) => b.latest_ts.localeCompare(a.latest_ts));
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
  const srcExt = blobIndex(dir).get(hash)?.ext;
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
function blobIndex(dir: string): Map<string, BlobInfo> {
  const out = new Map<string, BlobInfo>();
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
    if (!/^[a-f0-9]{64}$/.test(hash) || !CONTENT_TYPES[ext]) continue;
    try {
      const stat = statSync(path.join(dir, name));
      if (!stat.isFile()) continue;
      out.set(hash, { ext, bytes: stat.size, mtime: stat.mtime.toISOString() });
    } catch {
      // A concurrent capture or janitor pass can remove one entry mid-scan.
    }
  }
  return out;
}

function extForMediaType(mediaType: string): string | undefined {
  if (mediaType === "image/jpeg") return "jpg";
  return Object.entries(CONTENT_TYPES).find(([, value]) => value === mediaType)?.[0];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
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
  const ext = blobIndex(dir).get(hash)?.ext;
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
