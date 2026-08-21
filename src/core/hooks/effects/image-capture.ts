/**
 * Privacy-safe image artifact capture for normalized tool hooks.
 *
 * Image bytes are content-addressed under `.harnery/images/`. The canonical V3
 * ledger receives an `artifact.observed` record after the source tool event is
 * durable, so the web feed can recover provenance without retaining command,
 * output, intent, or absolute paths.
 */

import { createHash, randomUUID } from "node:crypto";
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
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildEventV3 } from "../../events/v3/builder.ts";
import type { EventV3 } from "../../events/v3/contract.ts";
import { writeEventV3 } from "../../events/v3/writer.ts";
import type { ParsedPayload } from "../adapter/parse.ts";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};
const MAX_CAPTURE_BYTES = 25 * 1024 * 1024;
const PRODUCED_MTIME_WINDOW_MS = 120_000;
const IMAGE_PATH_RE = /[\w./~@:+-]+\.(?:png|jpe?g|gif|webp|bmp|svg)\b/gi;

export interface CapturedImageArtifact {
  hash: string;
  ext: string;
  bytes: number;
  role: "viewed" | "produced";
  workspace_path?: string;
}

interface Candidate {
  path: string;
  role: CapturedImageArtifact["role"];
  requireRecentMtime: boolean;
}

/** Copy every qualifying image referenced by one tool hook into the blob store. */
export function captureImages(
  coordRoot: string,
  eventType: "tool.requested" | "tool.completed",
  payload: ParsedPayload | null,
): CapturedImageArtifact[] {
  const images = join(coordRoot, ".harnery", "images");
  const cwd = payload?.cwd ? resolve(payload.cwd) : process.cwd();
  const toolName = payload?.tool_name ?? "";
  const candidates =
    eventType === "tool.requested"
      ? collectViewed(toolName, payload?.tool_input, cwd)
      : collectProduced(toolName, payload, cwd);
  const captured: CapturedImageArtifact[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.path.startsWith(`${images}${sep}`)) continue;
    const blob = captureOne(images, candidate);
    if (!blob) continue;
    const dedupeKey = `${blob.hash}:${candidate.role}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const workspacePath = safeWorkspacePath(coordRoot, candidate.path);
    captured.push({
      ...blob,
      role: candidate.role,
      ...(workspacePath ? { workspace_path: workspacePath } : {}),
    });
  }
  return captured;
}

/**
 * Emit content-addressed image references as canonical V3 artifact events.
 * Each observation uses a one-event producer boot, which preserves independent
 * producer sequence continuity while the ledger writer serializes appends.
 */
export function recordImageArtifactsV3(
  coordRoot: string,
  sourceEvent: EventV3,
  artifacts: readonly CapturedImageArtifact[],
): void {
  if (!("generation_id" in sourceEvent.scope) || !sourceEvent.attestation_id) return;
  for (const artifact of artifacts) {
    writeEventV3(coordRoot, buildImageArtifactEventV3(sourceEvent, artifact));
  }
}

export function buildImageArtifactEventV3(
  sourceEvent: EventV3,
  artifact: CapturedImageArtifact,
): EventV3 {
  if (!("generation_id" in sourceEvent.scope) || !sourceEvent.attestation_id) {
    throw new Error("image artifacts require a generation-scoped source event");
  }
  return buildEventV3("artifact.observed", {
    producer: {
      producer_id: "prd_agent-hook-image-capture",
      boot_id: `boot_${randomUUID()}`,
      sequence: 1,
      component: "agent-hook",
      build_id: sourceEvent.producer.build_id,
      platform: sourceEvent.producer.platform,
      ...(sourceEvent.producer.bridge ? { bridge: sourceEvent.producer.bridge } : {}),
    },
    scope: {
      root_id: sourceEvent.scope.root_id,
      instance_id: sourceEvent.scope.instance_id,
      session_id: sourceEvent.scope.session_id,
      generation_id: sourceEvent.scope.generation_id,
      ...(sourceEvent.scope.run_id ? { run_id: sourceEvent.scope.run_id } : {}),
      ...(sourceEvent.scope.workflow_id ? { workflow_id: sourceEvent.scope.workflow_id } : {}),
      ...(sourceEvent.scope.workflow_agent_id
        ? { workflow_agent_id: sourceEvent.scope.workflow_agent_id }
        : {}),
    },
    attestation_id: sourceEvent.attestation_id as `att_${string}`,
    links: { caused_by: [sourceEvent.event_id] },
    provenance: {
      ...sourceEvent.provenance,
      attestation: "derived",
      confidence: "high",
    },
    payload: {
      artifact: {
        artifact_id: `art_${artifact.hash}`,
        kind: "image",
        media_type: MEDIA_TYPES[artifact.ext] ?? "image/png",
        bytes: artifact.bytes,
        retention_class: "bounded_local",
        ...(artifact.workspace_path ? { workspace_path: artifact.workspace_path } : {}),
      },
      operation: artifact.role === "viewed" ? "viewed" : "created",
    },
  });
}

/** Prune the bounded blob store by age and total size, oldest first. */
export function imageJanitor(coordRoot: string): void {
  try {
    const dir = join(coordRoot, ".harnery", "images");
    if (!existsSync(dir)) return;
    const maxBytes = envInt("HARNERY_IMAGES_MAX_BYTES", 2 * 1024 * 1024 * 1024);
    const maxAgeMs = envInt("HARNERY_IMAGES_MAX_AGE_DAYS", 30) * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const entries: Array<{ path: string; size: number; mtimeMs: number }> = [];

    for (const name of readdirSync(dir)) {
      if (name.endsWith(".tmp") || name.includes(".tmp.")) {
        rmSync(join(dir, name), { force: true });
        continue;
      }
      const full = join(dir, name);
      try {
        const stat = statSync(full);
        if (stat.isFile()) entries.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // A concurrent cleanup or write can make one entry disappear.
      }
    }

    let total = 0;
    const survivors: typeof entries = [];
    for (const entry of entries) {
      if (now - entry.mtimeMs > maxAgeMs) {
        rmSync(entry.path, { force: true });
      } else {
        total += entry.size;
        survivors.push(entry);
      }
    }
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of survivors) {
      if (total <= maxBytes) break;
      rmSync(entry.path, { force: true });
      total -= entry.size;
    }
  } catch {
    // Hook effects are always best-effort.
  }
}

function collectViewed(toolName: string, toolInput: unknown, cwd: string): Candidate[] {
  const name = normalizedToolName(toolName);
  if (name !== "read" && name !== "view_image" && name !== "image") return [];
  const input = objectInput(toolInput);
  const filePath = input?.file_path ?? input?.path ?? input?.image_path;
  if (typeof filePath !== "string" || !hasImageExt(filePath)) return [];
  return [{ path: toAbsolute(filePath, cwd), role: "viewed", requireRecentMtime: false }];
}

function collectProduced(
  toolName: string,
  payload: ParsedPayload | null,
  cwd: string,
): Candidate[] {
  const name = normalizedToolName(toolName);
  const producerTools = new Set([
    "bash",
    "shell",
    "exec_command",
    "imagegen",
    "image_gen",
    "browse",
    "browse_ai",
    "screenshot",
  ]);
  if (!producerTools.has(name)) return [];
  const input = objectInput(payload?.tool_input);
  const command = [input?.command, input?.cmd].find((value) => typeof value === "string") ?? "";
  const response = stringify(payload?.tool_response).slice(0, 2_000_000);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const text of [String(command), response]) {
    for (const match of text.matchAll(IMAGE_PATH_RE)) {
      const absolute = toAbsolute(match[0], cwd);
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      out.push({ path: absolute, role: "produced", requireRecentMtime: true });
    }
  }
  return out;
}

function captureOne(
  imagesDir: string,
  candidate: Candidate,
): Omit<CapturedImageArtifact, "role" | "workspace_path"> | null {
  try {
    const stat = statSync(candidate.path);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_CAPTURE_BYTES) return null;
    if (candidate.requireRecentMtime && Date.now() - stat.mtimeMs > PRODUCED_MTIME_WINDOW_MS) {
      return null;
    }
    const ext = extOf(candidate.path);
    if (!IMAGE_EXTS.has(ext)) return null;
    const bytes = readFileSync(candidate.path);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const destination = join(imagesDir, `${hash}.${ext}`);
    if (!existsSync(destination)) {
      mkdirSync(imagesDir, { recursive: true });
      const temporary = `${destination}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
      writeFileSync(temporary, bytes, { mode: 0o600 });
      renameSync(temporary, destination);
    }
    return { hash, ext, bytes: stat.size };
  } catch {
    return null;
  }
}

function normalizedToolName(value: string): string {
  return (value.split(/[.:/]/).pop() ?? value).toLowerCase().replaceAll("-", "_");
}

function objectInput(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}

function toAbsolute(value: string, cwd: string): string {
  if (value.startsWith("~/") && process.env.HOME) return resolve(process.env.HOME, value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function safeWorkspacePath(coordRoot: string, value: string): string | undefined {
  const rel = relative(resolve(coordRoot), resolve(value));
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  const normalized = rel.split(sep).join("/");
  return normalized.length <= 240 && !normalized.startsWith("/") ? normalized : undefined;
}

function hasImageExt(value: string): boolean {
  return IMAGE_EXTS.has(extOf(value));
}

function extOf(value: string): string {
  const clean = value.split(/[?#]/)[0] ?? value;
  const dot = clean.lastIndexOf(".");
  return dot < 0 ? "" : clean.slice(dot + 1).toLowerCase();
}

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
