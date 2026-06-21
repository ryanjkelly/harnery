/**
 * Image-feed capture: a non-coordination side effect fired from the normalized
 * `agent-hook` tool handlers (see effects/index.ts for the family rationale).
 *
 * When an agent VIEWS an image (Read tool on a `.png`/`.jpg`/…) or PRODUCES one
 * (a Bash command writes an image file via `harn browse`, `harn image`, `--diff`, …),
 * we content-address the bytes into `.harnery/images/<sha256>.<ext>` (dedup:
 * identical bytes collapse to one blob) and emit an `image.captured` event into
 * the canonical stream. The web image feed (`/images`) groups those events by
 * hash and streams them live over the existing SSE infra.
 *
 * Why this lives at the hook layer: it's the single harness-agnostic chokepoint
 * that sees every tool call across Claude Code / Cursor / Codex with the full
 * `tool_input` (file paths) and `tool_response`. No per-command code needed.
 *
 * Everything here is best-effort and MUST NOT throw; callers wrap it in
 * try/catch + logError, matching every other effect.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { emit } from "../events/emit.ts";
import type { Harness } from "../events/schema.ts";
import type { ParsedPayload } from "../harness/parse.ts";

/** Raster + vector image extensions the feed accepts. PDF is intentionally
 * excluded: book renders aren't an "image feed" and don't thumbnail inline. */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

/** Skip hashing files larger than this; screenshots are tens of KB; a huge
 * file mentioned in passing isn't worth the read. */
const MAX_CAPTURE_BYTES = 25 * 1024 * 1024;

/** A produced image must have been written within this window of the command
 * finishing, otherwise a path merely *mentioned* in output (an old baseline,
 * a doc reference) would be captured. Viewed images skip this gate. */
const PRODUCED_MTIME_WINDOW_MS = 120_000;

/** Matches image-ish paths in a command string or its output. Deliberately
 * permissive on the path body (`~`, `@`, `.`, `-`, `/`); existence + ext + the
 * mtime gate do the real filtering. */
const IMAGE_PATH_RE = /[\w./~@+-]+\.(?:png|jpe?g|gif|webp|bmp|svg)\b/gi;

export interface CaptureContext {
  eventType: "tool.pre_use" | "tool.post_use";
  /** The built event data (tool_name, tool_input string, intent, tool_use_id). */
  data: Record<string, unknown>;
  /** The full parsed payload, used for the un-clamped command + tool_response. */
  payload: ParsedPayload | null;
  instanceId: string;
  sessionId: string;
  harness: Harness;
}

interface Candidate {
  path: string; // resolved absolute path
  role: "viewed" | "produced";
  intent?: string;
  commandHead?: string;
  requireRecentMtime: boolean;
}

/**
 * Inspect one tool event for image references and capture any that resolve to
 * a real image on disk. Emits zero or more `image.captured` events.
 */
export function captureImages(coordRoot: string, ctx: CaptureContext): void {
  const imagesDir = join(coordRoot, ".harnery", "images");
  const cwd = resolveCwd(ctx.payload);
  const toolName = String(ctx.data.tool_name ?? "");

  const candidates =
    ctx.eventType === "tool.pre_use"
      ? collectViewed(toolName, ctx.data, cwd)
      : collectProduced(toolName, ctx.payload, cwd);

  if (candidates.length === 0) return;

  for (const cand of candidates) {
    // Never re-capture our own blob store (would loop on Reads of the gallery).
    if (cand.path.startsWith(`${imagesDir}/`)) continue;
    const captured = captureOne(imagesDir, cand);
    if (!captured) continue;
    emit(coordRoot, {
      event_type: "image.captured",
      instance_id: ctx.instanceId,
      session_id: ctx.sessionId,
      harness: ctx.harness,
      data: {
        hash: captured.hash,
        ext: captured.ext,
        bytes: captured.bytes,
        role: cand.role,
        source_path: canonicalize(coordRoot, cand.path),
        tool_name: toolName,
        tool_use_id: ctx.data.tool_use_id as string | undefined,
        ...(cand.intent ? { intent: cand.intent } : {}),
        ...(cand.commandHead ? { command_head: cand.commandHead } : {}),
      },
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    } as Parameters<typeof emit>[1]);
  }
}

/** Read tool → the file_path it's about to show (the "agent saw this" signal). */
function collectViewed(toolName: string, data: Record<string, unknown>, cwd: string): Candidate[] {
  if (toolName !== "Read") return [];
  const input = parseToolInput(data.tool_input);
  const filePath = input?.file_path;
  if (typeof filePath !== "string" || !filePath) return [];
  if (!hasImageExt(filePath)) return [];
  return [
    {
      path: toAbsolute(filePath, cwd),
      role: "viewed",
      intent: typeof data.intent === "string" ? data.intent : undefined,
      requireRecentMtime: false,
    },
  ];
}

/** Bash tool → scan the command + its output for freshly-written image files. */
function collectProduced(
  toolName: string,
  payload: ParsedPayload | null,
  cwd: string,
): Candidate[] {
  if (toolName !== "Bash") return [];
  const command = bashCommand(payload);
  const responseText = stringifyResponse(payload?.tool_response);
  const commandHead = command ? command.slice(0, 120) : undefined;

  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const text of [command, responseText]) {
    if (!text) continue;
    for (const m of text.matchAll(IMAGE_PATH_RE)) {
      const raw = m[0];
      const abs = toAbsolute(raw, cwd);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ path: abs, role: "produced", commandHead, requireRecentMtime: true });
    }
  }
  return out;
}

interface CapturedBlob {
  hash: string;
  ext: string;
  bytes: number;
}

/**
 * Validate the candidate on disk, hash it, and copy into the content-addressed
 * store (skipping the copy when the blob already exists). Returns null when the
 * candidate doesn't qualify.
 */
function captureOne(imagesDir: string, cand: Candidate): CapturedBlob | null {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(cand.path);
  } catch {
    return null; // path doesn't exist (common for "produced" false-positives)
  }
  if (!st.isFile() || st.size === 0 || st.size > MAX_CAPTURE_BYTES) return null;
  if (cand.requireRecentMtime && Date.now() - st.mtimeMs > PRODUCED_MTIME_WINDOW_MS) {
    return null; // mentioned but not freshly produced by this command
  }
  const ext = extOf(cand.path);
  if (!ext || !IMAGE_EXTS.has(ext)) return null;

  let bytes: Buffer;
  try {
    bytes = readFileSync(cand.path);
  } catch {
    return null;
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  const dest = join(imagesDir, `${hash}.${ext}`);
  if (!existsSync(dest)) {
    try {
      mkdirSync(imagesDir, { recursive: true });
      const tmp = `${dest}.tmp.${process.pid}`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, dest);
    } catch {
      return null; // couldn't store, don't emit a dangling event
    }
  }
  return { hash, ext, bytes: st.size };
}

/**
 * Prune `.harnery/images/` past a size cap (default 2 GB) and an age cap
 * (default 30 days), oldest-mtime-first. Fired on session.start next to
 * scratchJanitor. Pure-fs, fail-soft. Orphaned `image.captured` events whose
 * blob was pruned render as an "expired" placeholder in the gallery.
 */
export function imageJanitor(coordRoot: string): void {
  try {
    const dir = join(coordRoot, ".harnery", "images");
    if (!existsSync(dir)) return;
    const maxBytes = envInt("HARNERY_IMAGES_MAX_BYTES", 2 * 1024 * 1024 * 1024);
    const maxAgeMs = envInt("HARNERY_IMAGES_MAX_AGE_DAYS", 30) * 24 * 60 * 60 * 1000;
    const now = Date.now();

    type Entry = { path: string; size: number; mtimeMs: number };
    const entries: Entry[] = [];
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".tmp") || name.includes(".tmp.")) {
        // Orphaned temp from a crashed copy; sweep it.
        rmSync(join(dir, name), { force: true });
        continue;
      }
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      entries.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
    }

    // Age cap.
    let total = 0;
    const survivors: Entry[] = [];
    for (const e of entries) {
      if (now - e.mtimeMs > maxAgeMs) {
        rmSync(e.path, { force: true });
        continue;
      }
      total += e.size;
      survivors.push(e);
    }

    // Size cap: drop oldest first until under.
    if (total > maxBytes) {
      survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const e of survivors) {
        if (total <= maxBytes) break;
        rmSync(e.path, { force: true });
        total -= e.size;
      }
    }
  } catch {
    // best-effort
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseToolInput(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** The un-clamped Bash command from the raw payload (falls back to clamped). */
function bashCommand(payload: ParsedPayload | null): string {
  const ti = payload?.raw?.tool_input as Record<string, unknown> | undefined;
  const cmd = ti?.command;
  return typeof cmd === "string" ? cmd : "";
}

function stringifyResponse(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function resolveCwd(payload: ParsedPayload | null): string {
  const raw = payload?.raw as Record<string, unknown> | undefined;
  const cwd = raw?.cwd;
  return typeof cwd === "string" && cwd ? cwd : process.cwd();
}

function hasImageExt(p: string): boolean {
  const ext = extOf(p);
  return !!ext && IMAGE_EXTS.has(ext);
}

function extOf(p: string): string {
  const clean = p.split(/[?#]/)[0] ?? p; // drop any query/fragment
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return "";
  return clean.slice(dot + 1).toLowerCase();
}

function toAbsolute(p: string, cwd: string): string {
  let path = p;
  if (path.startsWith("~/")) {
    const home = process.env.HOME;
    if (home) path = join(home, path.slice(2));
  }
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Strip the coordRoot prefix so the feed shows repo-relative paths. */
function canonicalize(coordRoot: string, p: string): string {
  if (p.startsWith(`${coordRoot}/`)) return p.slice(coordRoot.length + 1);
  return p;
}
