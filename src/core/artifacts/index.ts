/**
 * Repository-local working artifacts.
 *
 * Artifacts are file trees that should survive an agent session but should not
 * become project records: screenshots, exports, audit dumps, rollback inputs,
 * and similar material. Each direct child of `.harnery/artifacts/` is one
 * managed unit with a small manifest. Cleanup fails closed: only a valid,
 * expired, inactive, untracked managed unit is deletable.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { artifactDefaultRetentionDays } from "../config.ts";

export const ARTIFACTS_DIR = join(".harnery", "artifacts");
export const ARTIFACT_MANIFEST = ".harnery-artifact.json";
export const ARTIFACT_SCHEMA_VERSION = 1 as const;

export interface ArtifactActor {
  instance_id: string;
  session_id?: string;
  name?: string;
}

export interface ArtifactManifestV1 {
  schema_version: typeof ARTIFACT_SCHEMA_VERSION;
  artifact_id: string;
  slug: string;
  purpose: string;
  created_at: string;
  created_by?: ArtifactActor;
  retention: {
    expires_at: string;
    renewed_at?: string;
    reason?: string;
  };
  released_at?: string;
  released_by?: ArtifactActor;
}

export type ArtifactClassification =
  | "managed-active"
  | "managed-current"
  | "managed-expired"
  | "managed-tracked"
  | "invalid-manifest"
  | "unmanaged"
  | "symlink"
  | "unknown";

export interface ArtifactInventoryEntry {
  name: string;
  path: string;
  relative_path: string;
  classification: ArtifactClassification;
  reason: string;
  action: "keep" | "would-delete" | "deleted";
  bytes: number | null;
  artifact_id: string | null;
  slug: string | null;
  created_at: string | null;
  expires_at: string | null;
  owner_instance_id: string | null;
}

export interface ArtifactCreateInput {
  slug: string;
  purpose: string;
  retentionDays: number;
  actor?: ArtifactActor;
  now?: Date;
  id?: string;
}

export interface ArtifactMutationInput {
  actor?: ArtifactActor;
  now?: Date;
}

interface ParsedManifest {
  ok: true;
  manifest: ArtifactManifestV1;
}

interface ManifestError {
  ok: false;
  reason: string;
}

export function artifactsRoot(repoRoot: string): string {
  return join(resolve(repoRoot), ARTIFACTS_DIR);
}

/** Public config-aware default for embedding hosts that create artifact units. */
export function configuredArtifactRetentionDays(repoRoot: string): number {
  return artifactDefaultRetentionDays(repoRoot);
}

export function createArtifact(
  repoRoot: string,
  input: ArtifactCreateInput,
): { path: string; manifest: ArtifactManifestV1 } {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  const slug = normalizeSlug(input.slug);
  if (!slug) throw new Error("slug must contain at least one ASCII letter or digit");
  const purpose = input.purpose.trim();
  if (!purpose) throw new Error("purpose must not be empty");
  const retentionDays = positiveDays(input.retentionDays);
  const artifactId = input.id ?? randomUUID();
  if (!isSafeId(artifactId)) {
    throw new Error("artifact id must use ASCII letters, digits, hyphens, or underscores");
  }

  const root = artifactsRoot(repoRoot);
  mkdirSync(root, { recursive: true });
  const date = now.toISOString().slice(0, 10);
  const path = join(root, `${date}_${slug}_${artifactId.slice(0, 8)}`);
  mkdirSync(path);

  const manifest: ArtifactManifestV1 = {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    artifact_id: artifactId,
    slug,
    purpose,
    created_at: now.toISOString(),
    created_by: input.actor,
    retention: {
      expires_at: addDays(now, retentionDays).toISOString(),
    },
  };
  atomicWriteManifest(path, manifest);
  return { path, manifest };
}

export function inventoryArtifacts(
  repoRoot: string,
  opts: { now?: Date; freshnessSeconds?: number } = {},
): ArtifactInventoryEntry[] {
  const root = artifactsRoot(repoRoot);
  if (!existsSync(root)) return [];
  const now = opts.now ?? new Date();
  assertValidDate(now, "now");
  const freshnessSeconds = opts.freshnessSeconds ?? 600;
  const rows: ArtifactInventoryEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch (error) {
    return [
      rowFor(
        root,
        basename(root),
        repoRoot,
        "unknown",
        errorMessage("cannot read artifact root", error),
      ),
    ];
  }
  for (const name of names) {
    rows.push(classifyArtifactPath(repoRoot, join(root, name), now, freshnessSeconds));
  }
  return rows;
}

export function showArtifact(
  repoRoot: string,
  ref: string,
  opts: { now?: Date; freshnessSeconds?: number } = {},
): { entry: ArtifactInventoryEntry; manifest: ArtifactManifestV1 } {
  const path = resolveArtifactRef(repoRoot, ref);
  const entry = classifyArtifactPath(
    repoRoot,
    path,
    opts.now ?? new Date(),
    opts.freshnessSeconds ?? 600,
  );
  const parsed = readManifest(path);
  if (!parsed.ok) throw new Error(parsed.reason);
  return { entry, manifest: parsed.manifest };
}

export function renewArtifact(
  repoRoot: string,
  ref: string,
  days: number,
  reason: string,
  input: ArtifactMutationInput = {},
): ArtifactManifestV1 {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  const retentionDays = positiveDays(days);
  const why = reason.trim();
  if (!why) throw new Error("renewal reason must not be empty");
  const path = resolveArtifactRef(repoRoot, ref);
  const parsed = readManifest(path);
  if (!parsed.ok) throw new Error(parsed.reason);
  const manifest: ArtifactManifestV1 = {
    ...parsed.manifest,
    retention: {
      expires_at: addDays(now, retentionDays).toISOString(),
      renewed_at: now.toISOString(),
      reason: why,
    },
  };
  atomicWriteManifest(path, manifest);
  return manifest;
}

export function releaseArtifact(
  repoRoot: string,
  ref: string,
  input: ArtifactMutationInput = {},
): ArtifactManifestV1 {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  const path = resolveArtifactRef(repoRoot, ref);
  const parsed = readManifest(path);
  if (!parsed.ok) throw new Error(parsed.reason);
  const manifest: ArtifactManifestV1 = {
    ...parsed.manifest,
    released_at: now.toISOString(),
    released_by: input.actor,
  };
  atomicWriteManifest(path, manifest);
  return manifest;
}

export function cleanArtifacts(
  repoRoot: string,
  opts: { yes?: boolean; now?: Date; freshnessSeconds?: number } = {},
): ArtifactInventoryEntry[] {
  const now = opts.now ?? new Date();
  const freshnessSeconds = opts.freshnessSeconds ?? 600;
  const rows = inventoryArtifacts(repoRoot, { now, freshnessSeconds });
  if (!opts.yes) return rows;

  return rows.map((entry) => {
    if (entry.classification !== "managed-expired") return entry;
    // Reclassify immediately before removal. A renewal, release-state change,
    // heartbeat, symlink swap, or tracked file added since inventory must win.
    const current = classifyArtifactPath(repoRoot, entry.path, now, freshnessSeconds);
    if (current.classification !== "managed-expired") return current;
    try {
      const top = lstatSync(current.path);
      if (!top.isDirectory() || top.isSymbolicLink()) {
        return {
          ...current,
          classification: "unknown",
          reason: "entry changed before deletion",
          action: "keep",
        };
      }
      rmSync(current.path, { recursive: true, force: false });
      return { ...current, action: "deleted" };
    } catch (error) {
      return {
        ...current,
        classification: "unknown",
        reason: errorMessage("entry changed or could not be deleted", error),
        action: "keep",
      };
    }
  });
}

export function resolveArtifactRef(repoRoot: string, ref: string): string {
  const root = artifactsRoot(repoRoot);
  const candidate = isAbsolute(ref) ? resolve(ref) : resolve(root, ref);
  if (candidate === root || !candidate.startsWith(`${root}${sep}`) || dirname(candidate) !== root) {
    // A bare artifact id is the only non-path lookup. It must match exactly,
    // never by prefix, so two UUIDs cannot make a command ambiguous.
    const matches = inventoryArtifacts(repoRoot)
      .filter((entry) => entry.artifact_id === ref)
      .map((entry) => entry.path);
    if (matches.length === 1) return matches[0]!;
    throw new Error(`artifact "${ref}" was not found`);
  }
  if (!existsSync(candidate)) {
    const matches = inventoryArtifacts(repoRoot)
      .filter((entry) => entry.artifact_id === ref)
      .map((entry) => entry.path);
    if (matches.length === 1) return matches[0]!;
    throw new Error(`artifact "${ref}" was not found`);
  }
  return candidate;
}

function classifyArtifactPath(
  repoRoot: string,
  path: string,
  now: Date,
  freshnessSeconds: number,
): ArtifactInventoryEntry {
  const name = basename(path);
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch (error) {
    return rowFor(path, name, repoRoot, "unknown", errorMessage("cannot inspect entry", error));
  }
  if (st.isSymbolicLink()) {
    return rowFor(path, name, repoRoot, "symlink", "symlinks are never traversed or deleted");
  }
  if (!st.isDirectory()) {
    return rowFor(path, name, repoRoot, "unmanaged", "workspace entries must be directories");
  }

  const parsed = readManifest(path);
  if (!parsed.ok) {
    const classification = existsSync(join(path, ARTIFACT_MANIFEST))
      ? "invalid-manifest"
      : "unmanaged";
    return rowFor(path, name, repoRoot, classification, parsed.reason);
  }
  const manifest = parsed.manifest;
  const bytes = safeTreeSize(path);
  const base = rowFor(path, name, repoRoot, "managed-current", "retention has not expired", bytes);
  Object.assign(base, {
    artifact_id: manifest.artifact_id,
    slug: manifest.slug,
    created_at: manifest.created_at,
    expires_at: manifest.retention.expires_at,
    owner_instance_id: manifest.created_by?.instance_id ?? null,
  });

  if (base.bytes === null) {
    return {
      ...base,
      classification: "unknown",
      reason: "one or more artifact paths are unreadable",
      action: "keep",
    };
  }
  if (containsTrackedPath(repoRoot, path)) {
    return {
      ...base,
      classification: "managed-tracked",
      reason: "Git tracks one or more paths inside this artifact",
      action: "keep",
    };
  }
  if (!manifest.released_at && manifest.created_by?.instance_id) {
    const live = ownerLiveness(repoRoot, manifest.created_by.instance_id, now, freshnessSeconds);
    if (live === "live") {
      return {
        ...base,
        classification: "managed-active",
        reason: `owner ${manifest.created_by.instance_id} has a fresh heartbeat`,
        action: "keep",
      };
    }
    if (live === "unknown") {
      return {
        ...base,
        classification: "unknown",
        reason: `owner ${manifest.created_by.instance_id} heartbeat is unreadable`,
        action: "keep",
      };
    }
  }
  if (Date.parse(manifest.retention.expires_at) > now.getTime()) return base;
  return {
    ...base,
    classification: "managed-expired",
    reason: `retention expired at ${manifest.retention.expires_at}`,
    action: "would-delete",
  };
}

function readManifest(path: string): ParsedManifest | ManifestError {
  const manifestPath = join(path, ARTIFACT_MANIFEST);
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: `missing ${ARTIFACT_MANIFEST}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, reason: errorMessage("manifest is unreadable", error) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "manifest must be a JSON object" };
  }
  const m = value as Partial<ArtifactManifestV1>;
  if (m.schema_version !== ARTIFACT_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported schema_version ${String(m.schema_version)}` };
  }
  if (!isSafeId(m.artifact_id)) return { ok: false, reason: "invalid artifact_id" };
  if (typeof m.slug !== "string" || !m.slug || normalizeSlug(m.slug) !== m.slug) {
    return { ok: false, reason: "invalid slug" };
  }
  if (typeof m.purpose !== "string" || !m.purpose.trim()) {
    return { ok: false, reason: "invalid purpose" };
  }
  if (!validIso(m.created_at)) return { ok: false, reason: "invalid created_at" };
  if (!m.retention || typeof m.retention !== "object" || !validIso(m.retention.expires_at)) {
    return { ok: false, reason: "invalid retention.expires_at" };
  }
  if (m.released_at !== undefined && !validIso(m.released_at)) {
    return { ok: false, reason: "invalid released_at" };
  }
  if (m.created_by !== undefined && !validActor(m.created_by)) {
    return { ok: false, reason: "invalid created_by" };
  }
  if (m.released_by !== undefined && !validActor(m.released_by)) {
    return { ok: false, reason: "invalid released_by" };
  }
  return { ok: true, manifest: m as ArtifactManifestV1 };
}

function atomicWriteManifest(path: string, manifest: ArtifactManifestV1): void {
  const target = join(path, ARTIFACT_MANIFEST);
  const tmp = `${target}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, target);
}

function ownerLiveness(
  repoRoot: string,
  instanceId: string,
  now: Date,
  freshnessSeconds: number,
): "live" | "stale" | "unknown" {
  const path = join(repoRoot, ".harnery", "active", `${instanceId}.json`);
  if (!existsSync(path)) return "stale";
  try {
    const hb = JSON.parse(readFileSync(path, "utf8")) as { last_heartbeat?: unknown };
    if (typeof hb.last_heartbeat !== "string") return "unknown";
    const ts = Date.parse(hb.last_heartbeat);
    if (!Number.isFinite(ts)) return "unknown";
    return now.getTime() - ts <= freshnessSeconds * 1000 ? "live" : "stale";
  } catch {
    return "unknown";
  }
}

function containsTrackedPath(repoRoot: string, path: string): boolean {
  const rel = relative(repoRoot, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return true;
  const result = spawnSync("git", ["ls-files", "-z", "--", rel], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  // If Git itself cannot answer, fail closed.
  return result.status !== 0 || result.stdout.length > 0;
}

function safeTreeSize(path: string): number | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return st.size;
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let total = st.size;
    for (const child of readdirSync(path)) {
      const size = safeTreeSize(join(path, child));
      if (size === null) return null;
      total += size;
    }
    return total;
  } catch {
    return null;
  }
}

function rowFor(
  path: string,
  name: string,
  repoRoot: string,
  classification: ArtifactClassification,
  reason: string,
  bytes: number | null = safeTreeSize(path),
): ArtifactInventoryEntry {
  return {
    name,
    path,
    relative_path: relative(repoRoot, path),
    classification,
    reason,
    action: classification === "managed-expired" ? "would-delete" : "keep",
    bytes,
    artifact_id: null,
    slug: null,
    created_at: null,
    expires_at: null,
    owner_instance_id: null,
  };
}

function normalizeSlug(value: string): string {
  // Collapsing every non-alphanumeric run to a single "-" leaves no two
  // adjacent dashes, so trimming the edges needs fixed-length patterns rather
  // than "-+", whose backtracking is polynomial on a long run of dashes.
  const collapsed = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  return collapsed.replace(/^-/, "").replace(/-$/, "").slice(0, 64);
}

function positiveDays(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 3650) {
    throw new Error("retention days must be between 1 and 3650");
  }
  return value;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function validActor(value: unknown): value is ArtifactActor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actor = value as Partial<ArtifactActor>;
  return (
    isSafeId(actor.instance_id) &&
    (actor.session_id === undefined || isSafeId(actor.session_id)) &&
    (actor.name === undefined || (typeof actor.name === "string" && actor.name.length <= 128))
  );
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertValidDate(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be a valid date`);
}

function errorMessage(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
