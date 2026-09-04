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
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readLiveCoordinationRow } from "../agents/state/live-coordination-view.ts";
import {
  artifactAutoCleanEnabled,
  artifactAutoCleanIntervalHours,
  artifactDefaultRetentionDays,
  artifactMaxBytes,
  artifactMaxUnitBytes,
} from "../config.ts";
import { ARTIFACT_MANIFEST, ARTIFACT_SCHEMA_VERSION, ARTIFACTS_DIR } from "./constants.ts";

export { ARTIFACT_MANIFEST, ARTIFACT_SCHEMA_VERSION, ARTIFACTS_DIR } from "./constants.ts";
export type {
  ArtifactDeliveryCard,
  ArtifactDeliveryItem,
  ArtifactDeliveryManifest,
  ArtifactDeliveryPath,
  ArtifactDeliveryUrl,
} from "./delivery-card.ts";
export {
  ARTIFACT_DELIVERY_AUTO_ITEM_LIMIT,
  ARTIFACT_DELIVERY_MANIFEST,
  ARTIFACT_DELIVERY_SCHEMA_VERSION,
  parseArtifactDeliverySpec,
  readArtifactDeliveryManifest,
  renderArtifactDeliveryCard,
  resolveArtifactDeliveryManifest,
  writeArtifactDeliveryManifest,
} from "./delivery-card.ts";

export interface ArtifactActor {
  instance_id: string;
  session_id?: string;
  name?: string;
}

export interface ArtifactManifestV2 {
  schema_version: typeof ARTIFACT_SCHEMA_VERSION;
  holds: ArtifactHold[];
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
  oversize_acknowledged?: boolean;
}

export interface ArtifactHold {
  id: string;
  reason: string;
  set_by: ArtifactActor;
  set_at: string;
}

export interface ArtifactHoldInput {
  id: string;
  reason: string;
}

export function artifactCapabilities() {
  return {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    holds: true,
    atomic_create_holds: true,
    owner_scoped_unhold: true,
    explicit_v1_migration: true,
  } as const;
}

export type ArtifactClassification =
  | "managed-held"
  | "managed-active"
  | "managed-current"
  | "managed-expired"
  | "managed-oversize"
  | "managed-over-budget"
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
  last_modified_at: string | null;
  expires_at: string | null;
  owner_instance_id: string | null;
  oversize_acknowledged: boolean;
}

export interface ArtifactCreateInput {
  slug: string;
  purpose: string;
  retentionDays: number;
  /** Sub-day retention. When set, it replaces `retentionDays` for this unit
   * (a page review pack expires in minutes, not days). 1 to 5,256,000. */
  retentionMinutes?: number;
  actor?: ArtifactActor;
  /** Holds are persisted with the first manifest; a valid actor is required. */
  holds?: ArtifactHoldInput[];
  now?: Date;
  id?: string;
  big?: boolean;
}

export interface ArtifactMutationInput {
  actor?: ArtifactActor;
  now?: Date;
}

export interface ArtifactAdoptionResult {
  candidates: Array<{ path: string; name: string; bytes: number; kind: "file" | "directory" }>;
  candidate_bytes: number;
  requires_big: boolean;
  adopted_artifact_id: string | null;
  adopted_path: string | null;
  adopted_directories: number;
}

interface ParsedManifest {
  ok: true;
  manifest: ArtifactManifestV2;
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
): { path: string; manifest: ArtifactManifestV2 } {
  return withArtifactLock(repoRoot, () => createArtifactUnlocked(repoRoot, input));
}

function createArtifactUnlocked(
  repoRoot: string,
  input: ArtifactCreateInput,
): { path: string; manifest: ArtifactManifestV2 } {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  const slug = normalizeSlug(input.slug);
  if (!slug) throw new Error("slug must contain at least one ASCII letter or digit");
  const purpose = input.purpose.trim();
  if (!purpose) throw new Error("purpose must not be empty");
  const expiresAt =
    input.retentionMinutes !== undefined
      ? addMinutes(now, positiveMinutes(input.retentionMinutes))
      : addDays(now, positiveDays(input.retentionDays));
  const artifactId = input.id ?? randomUUID();
  if (!isSafeId(artifactId)) {
    throw new Error("artifact id must use ASCII letters, digits, hyphens, or underscores");
  }
  const holds = (input.holds ?? []).map((hold) => makeHold(hold, input.actor, now));
  if (new Set(holds.map((hold) => hold.id)).size !== holds.length) {
    throw new Error("duplicate hold id");
  }

  const root = artifactsRoot(repoRoot);
  mkdirSync(root, { recursive: true });
  const date = now.toISOString().slice(0, 10);
  const path = join(root, `${date}_${slug}_${artifactId.slice(0, 8)}`);
  mkdirSync(path);

  const manifest: ArtifactManifestV2 = {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    holds,
    artifact_id: artifactId,
    slug,
    purpose,
    created_at: now.toISOString(),
    created_by: input.actor,
    retention: {
      expires_at: expiresAt.toISOString(),
    },
    ...(input.big ? { oversize_acknowledged: true } : {}),
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
  return applyArtifactBudgets(repoRoot, rows);
}

export function showArtifact(
  repoRoot: string,
  ref: string,
  opts: { now?: Date; freshnessSeconds?: number } = {},
): { entry: ArtifactInventoryEntry; manifest: ArtifactManifestV2 } {
  const path = resolveArtifactRef(repoRoot, ref);
  const entry = inventoryArtifacts(repoRoot, opts).find((row) => row.path === path);
  if (!entry) throw new Error(`artifact "${ref}" was not found`);
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
): ArtifactManifestV2 {
  return withArtifactLock(repoRoot, () =>
    renewArtifactUnlocked(repoRoot, ref, days, reason, input),
  );
}

function renewArtifactUnlocked(
  repoRoot: string,
  ref: string,
  days: number,
  reason: string,
  input: ArtifactMutationInput,
): ArtifactManifestV2 {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  const retentionDays = positiveDays(days);
  const why = reason.trim();
  if (!why) throw new Error("renewal reason must not be empty");
  const path = resolveArtifactRef(repoRoot, ref);
  const parsed = readManifest(path);
  if (!parsed.ok) throw new Error(parsed.reason);
  const manifest: ArtifactManifestV2 = {
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
): ArtifactManifestV2 {
  return withArtifactLock(repoRoot, () => releaseArtifactUnlocked(repoRoot, ref, input));
}

function releaseArtifactUnlocked(
  repoRoot: string,
  ref: string,
  input: ArtifactMutationInput,
): ArtifactManifestV2 {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  const path = resolveArtifactRef(repoRoot, ref);
  const parsed = readManifest(path);
  if (!parsed.ok) throw new Error(parsed.reason);
  const manifest: ArtifactManifestV2 = {
    ...parsed.manifest,
    released_at: now.toISOString(),
    released_by: input.actor,
  };
  atomicWriteManifest(path, manifest);
  return manifest;
}

export function holdArtifact(
  repoRoot: string,
  ref: string,
  input: ArtifactHoldInput & { actor: ArtifactActor; now?: Date },
): ArtifactManifestV2 {
  const hold = makeHold(input, input.actor, input.now ?? new Date());
  return withArtifactLock(repoRoot, () => {
    const path = resolveArtifactRef(repoRoot, ref);
    const parsed = readManifest(path);
    if (!parsed.ok) throw new Error(parsed.reason);
    const previous = parsed.manifest.holds.find((item) => item.id === hold.id);
    if (previous) {
      if (
        previous.set_by.instance_id !== input.actor.instance_id ||
        previous.reason !== hold.reason
      ) {
        throw new Error("hold id already exists with a different owner or reason");
      }
      return parsed.manifest;
    }
    const manifest = { ...parsed.manifest, holds: [...parsed.manifest.holds, hold] };
    atomicWriteManifest(path, manifest);
    return manifest;
  });
}

export function unholdArtifact(
  repoRoot: string,
  ref: string,
  id: string,
  input: { actor: ArtifactActor; now?: Date },
): ArtifactManifestV2 {
  if (!validHoldId(id)) throw new Error("invalid hold id");
  if (!validActor(input.actor)) throw new Error("a valid hold actor is required");
  return withArtifactLock(repoRoot, () => {
    const path = resolveArtifactRef(repoRoot, ref);
    const parsed = readManifest(path);
    if (!parsed.ok) throw new Error(parsed.reason);
    const hold = parsed.manifest.holds.find((item) => item.id === id);
    if (!hold) return parsed.manifest;
    if (hold.set_by.instance_id !== input.actor.instance_id) {
      throw new Error("only the hold owner may remove this hold");
    }
    const manifest = {
      ...parsed.manifest,
      holds: parsed.manifest.holds.filter((item) => item.id !== id),
    };
    atomicWriteManifest(path, manifest);
    return manifest;
  });
}

/** Adopt untracked loose files and legacy directories without changing directory paths. */
export function adoptUnmanagedArtifactFiles(
  repoRoot: string,
  input: {
    yes?: boolean;
    big?: boolean;
    purpose: string;
    retentionDays: number;
    actor?: ArtifactActor;
    now?: Date;
  },
): ArtifactAdoptionResult {
  if (input.yes)
    return withArtifactLock(repoRoot, () => adoptUnmanagedArtifactFilesUnlocked(repoRoot, input));
  return adoptUnmanagedArtifactFilesUnlocked(repoRoot, input);
}

function adoptUnmanagedArtifactFilesUnlocked(
  repoRoot: string,
  input: {
    yes?: boolean;
    big?: boolean;
    purpose: string;
    retentionDays: number;
    actor?: ArtifactActor;
    now?: Date;
  },
): ArtifactAdoptionResult {
  const now = input.now ?? new Date();
  const candidates: ArtifactAdoptionResult["candidates"] = [];
  for (const row of inventoryArtifacts(repoRoot, { now })) {
    if (row.classification !== "unmanaged") continue;
    try {
      const stat = lstatSync(row.path);
      if (stat.isSymbolicLink() || containsTrackedPath(repoRoot, row.path)) continue;
      if (stat.isFile()) {
        candidates.push({ path: row.path, name: row.name, bytes: stat.size, kind: "file" });
        continue;
      }
      if (stat.isDirectory() && !existsSync(join(row.path, ARTIFACT_MANIFEST))) {
        const bytes = safeTreeSize(row.path);
        if (bytes !== null && normalizeSlug(row.name)) {
          candidates.push({ path: row.path, name: row.name, bytes, kind: "directory" });
        }
      }
    } catch {
      // A racing or unreadable entry stays unmanaged.
    }
  }
  const candidateBytes = candidates.reduce((sum, row) => sum + row.bytes, 0);
  const fileBytes = candidates.reduce((sum, row) => sum + (row.kind === "file" ? row.bytes : 0), 0);
  const maxUnitBytes = artifactMaxUnitBytes(repoRoot);
  const requiresBig =
    fileBytes > maxUnitBytes ||
    candidates.some((row) => row.kind === "directory" && row.bytes > maxUnitBytes);
  const preview: ArtifactAdoptionResult = {
    candidates,
    candidate_bytes: candidateBytes,
    requires_big: requiresBig,
    adopted_artifact_id: null,
    adopted_path: null,
    adopted_directories: 0,
  };
  if (!input.yes || candidates.length === 0) return preview;
  if (requiresBig && !input.big) {
    throw new Error("unmanaged adoption exceeds the per-bundle ceiling; repeat with --big");
  }

  // Revalidate every exact source before creating a destination. A changed,
  // tracked, linked, or non-regular entry aborts the whole adoption.
  for (const candidate of candidates) {
    const stat = lstatSync(candidate.path);
    const bytes = stat.isDirectory() ? safeTreeSize(candidate.path) : stat.size;
    if (
      stat.isSymbolicLink() ||
      bytes !== candidate.bytes ||
      containsTrackedPath(repoRoot, candidate.path)
    ) {
      throw new Error(`unmanaged entry changed before adoption: ${candidate.name}`);
    }
    if (candidate.kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`unmanaged entry changed before adoption: ${candidate.name}`);
    }
  }
  const files = candidates.filter((candidate) => candidate.kind === "file");
  const created = files.length
    ? createArtifactUnlocked(repoRoot, {
        slug: "adopted-unmanaged",
        purpose: input.purpose,
        retentionDays: input.retentionDays,
        actor: input.actor,
        now,
        big: input.big,
      })
    : null;
  for (const candidate of files) renameSync(candidate.path, join(created!.path, candidate.name));
  const retentionDays = positiveDays(input.retentionDays);
  const directories = candidates.filter((candidate) => candidate.kind === "directory");
  for (const candidate of directories) {
    atomicWriteManifest(candidate.path, {
      schema_version: ARTIFACT_SCHEMA_VERSION,
      holds: [],
      artifact_id: randomUUID(),
      slug: normalizeSlug(candidate.name),
      purpose: `${input.purpose}: ${candidate.name}`,
      created_at: now.toISOString(),
      created_by: input.actor,
      retention: { expires_at: addDays(now, retentionDays).toISOString() },
      ...(input.big ? { oversize_acknowledged: true } : {}),
    });
  }
  return {
    ...preview,
    adopted_artifact_id: created?.manifest.artifact_id ?? null,
    adopted_path: created?.path ?? null,
    adopted_directories: directories.length,
  };
}

export function cleanArtifacts(
  repoRoot: string,
  opts: { yes?: boolean; now?: Date; freshnessSeconds?: number } = {},
): ArtifactInventoryEntry[] {
  if (!opts.yes) return inventoryArtifacts(repoRoot, opts);
  try {
    return withArtifactLock(repoRoot, () => cleanArtifactsUnlocked(repoRoot, opts));
  } catch (error) {
    return inventoryArtifacts(repoRoot, opts).map((row) =>
      row.action === "would-delete"
        ? {
            ...row,
            classification: "unknown",
            action: "keep",
            reason: errorMessage("cleanup refused", error),
          }
        : row,
    );
  }
}

function cleanArtifactsUnlocked(
  repoRoot: string,
  opts: { yes?: boolean; now?: Date; freshnessSeconds?: number },
): ArtifactInventoryEntry[] {
  const now = opts.now ?? new Date();
  const freshnessSeconds = opts.freshnessSeconds ?? 600;
  const rows = inventoryArtifacts(repoRoot, { now, freshnessSeconds });
  if (!opts.yes) return rows;

  return rows.map((entry) => {
    if (entry.action !== "would-delete") return entry;
    // Reclassify immediately before removal. A renewal, release-state change,
    // heartbeat, symlink swap, or tracked file added since inventory must win.
    const current = inventoryArtifacts(repoRoot, { now, freshnessSeconds }).find(
      (row) => row.path === entry.path,
    );
    if (!current) {
      return { ...entry, classification: "unknown", reason: "entry disappeared", action: "keep" };
    }
    if (
      current.action !== "would-delete" ||
      current.artifact_id !== entry.artifact_id ||
      current.bytes !== entry.bytes ||
      current.last_modified_at !== entry.last_modified_at ||
      current.expires_at !== entry.expires_at
    ) {
      return current;
    }
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

/** Sibling of the artifacts root so the stamp never appears in the inventory scan. */
const AUTO_CLEAN_STAMP = ".harnery/artifacts-auto-clean.json";

export interface ArtifactAutoCleanResult {
  ran: boolean;
  reason: "swept" | "disabled" | "fresh" | "no-root";
  deleted: number;
  bytes: number;
}

/**
 * Throttled expired-artifact sweep, fired as a SessionStart effect.
 *
 * Retention was previously enforced only when someone remembered to run
 * `artifacts clean --yes`, so expired workspaces accumulated indefinitely on
 * busy hosts. This runs the exact same guarded deletion (only
 * `managed-expired` entries, each re-classified immediately before removal;
 * unmanaged and legacy directories are never touched) at most once per
 * interval (default 24h), claim-first via a stamp file so concurrent session
 * starts do not double-sweep. Disable with `artifacts.auto_clean: false` or
 * `HARNERY_ARTIFACT_AUTO_CLEAN=0`.
 */
export function autoCleanArtifacts(
  repoRoot: string,
  opts: { now?: Date } = {},
): ArtifactAutoCleanResult {
  const now = opts.now ?? new Date();
  assertValidDate(now, "now");
  if (!existsSync(artifactsRoot(repoRoot))) {
    return { ran: false, reason: "no-root", deleted: 0, bytes: 0 };
  }
  if (!artifactAutoCleanEnabled(repoRoot)) {
    return { ran: false, reason: "disabled", deleted: 0, bytes: 0 };
  }
  const stampPath = join(resolve(repoRoot), AUTO_CLEAN_STAMP);
  const intervalMs = artifactAutoCleanIntervalHours() * 60 * 60 * 1000;
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as { last_run_at?: string };
    const last = Date.parse(stamp.last_run_at ?? "");
    if (Number.isFinite(last) && now.getTime() - last < intervalMs) {
      return { ran: false, reason: "fresh", deleted: 0, bytes: 0 };
    }
  } catch {
    // Missing or unreadable stamp: sweep now and write a fresh one.
  }
  // Claim first: a crash mid-sweep costs one skipped interval, while claiming
  // after would let two concurrent session starts both walk the store.
  writeFileSync(stampPath, `${JSON.stringify({ last_run_at: now.toISOString() }, null, 2)}\n`);
  const rows = cleanArtifacts(repoRoot, { yes: true, now });
  const deletedRows = rows.filter((row) => row.action === "deleted");
  const deleted = deletedRows.length;
  const bytes = deletedRows.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
  writeFileSync(
    stampPath,
    `${JSON.stringify({ last_run_at: now.toISOString(), deleted, bytes }, null, 2)}\n`,
  );
  return { ran: true, reason: "swept", deleted, bytes };
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
  const lastModifiedMs = safeTreeLastModified(path, now);
  const retentionAnchorMs = Date.parse(manifest.retention.renewed_at ?? manifest.created_at);
  const retentionWindowMs = Date.parse(manifest.retention.expires_at) - retentionAnchorMs;
  const effectiveLastModifiedMs = Math.max(retentionAnchorMs, lastModifiedMs ?? 0);
  const effectiveExpiresAt = new Date(effectiveLastModifiedMs + retentionWindowMs).toISOString();
  const base = rowFor(path, name, repoRoot, "managed-current", "retention has not expired", bytes);
  Object.assign(base, {
    artifact_id: manifest.artifact_id,
    slug: manifest.slug,
    created_at: manifest.created_at,
    last_modified_at: new Date(effectiveLastModifiedMs).toISOString(),
    expires_at: effectiveExpiresAt,
    owner_instance_id: manifest.created_by?.instance_id ?? null,
    oversize_acknowledged: manifest.oversize_acknowledged === true,
  });

  if (manifest.holds.length > 0) {
    return {
      ...base,
      classification: "managed-held",
      reason: `held: ${manifest.holds.map((hold) => hold.id).join(", ")}`,
      action: "keep",
    };
  }
  if (base.bytes === null || lastModifiedMs === null) {
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
  if (Date.parse(effectiveExpiresAt) > now.getTime()) return base;
  return {
    ...base,
    classification: "managed-expired",
    reason: `retention expired at ${effectiveExpiresAt}`,
    action: "would-delete",
  };
}

function applyArtifactBudgets(
  repoRoot: string,
  inputRows: ArtifactInventoryEntry[],
): ArtifactInventoryEntry[] {
  const maxUnitBytes = artifactMaxUnitBytes(repoRoot);
  const maxBytes = artifactMaxBytes(repoRoot);
  const rows = inputRows.map((row) => ({ ...row }));

  for (const row of rows) {
    if (
      row.classification === "managed-current" &&
      row.bytes !== null &&
      row.bytes > maxUnitBytes &&
      !row.oversize_acknowledged
    ) {
      row.classification = "managed-oversize";
      row.reason = `bundle uses ${row.bytes} bytes, above the ${maxUnitBytes}-byte ceiling without --big`;
      row.action = "would-delete";
    }
  }

  const managedBytes = rows.reduce(
    (sum, row) => sum + (row.artifact_id && row.bytes !== null ? row.bytes : 0),
    0,
  );
  let retainedBytes =
    managedBytes -
    rows.reduce(
      (sum, row) => sum + (row.action === "would-delete" && row.bytes !== null ? row.bytes : 0),
      0,
    );
  if (retainedBytes <= maxBytes) return rows;

  const candidates = rows
    .filter(
      (row) =>
        row.classification === "managed-current" && row.action === "keep" && row.bytes !== null,
    )
    .sort((left, right) =>
      `${left.expires_at ?? ""}\0${left.created_at ?? ""}\0${left.name}`.localeCompare(
        `${right.expires_at ?? ""}\0${right.created_at ?? ""}\0${right.name}`,
      ),
    );
  for (const row of candidates) {
    if (retainedBytes <= maxBytes) break;
    row.classification = "managed-over-budget";
    row.reason = `repository artifact budget is ${maxBytes} bytes; earliest-expiring inactive bundles are removed first`;
    row.action = "would-delete";
    retainedBytes -= row.bytes ?? 0;
  }
  return rows;
}

function readManifest(path: string): ParsedManifest | ManifestError {
  const manifestPath = join(path, ARTIFACT_MANIFEST);
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: `missing ${ARTIFACT_MANIFEST}` };
  }
  let value: unknown;
  try {
    const unit = lstatSync(path);
    const stat = lstatSync(manifestPath);
    if (
      !unit.isDirectory() ||
      unit.isSymbolicLink() ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 1024 * 1024
    ) {
      return { ok: false, reason: "manifest must be a bounded regular file in a direct directory" };
    }
    value = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, reason: errorMessage("manifest is unreadable", error) };
  }
  return parseArtifactManifest(value);
}

/** Validate only the current schema. Legacy conversion belongs to migrateArtifacts. */
export function parseArtifactManifest(value: unknown): ParsedManifest | ManifestError {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "manifest must be a JSON object" };
  }
  const m = value as Partial<ArtifactManifestV2>;
  if (m.schema_version !== ARTIFACT_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported schema_version ${String(m.schema_version)}` };
  }
  if (
    !Array.isArray(m.holds) ||
    m.holds.some((hold) => !validHold(hold)) ||
    new Set(m.holds.map((hold) => hold.id)).size !== m.holds.length
  ) {
    return { ok: false, reason: "invalid holds" };
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
  if (m.retention.renewed_at !== undefined && !validIso(m.retention.renewed_at)) {
    return { ok: false, reason: "invalid retention.renewed_at" };
  }
  const retentionAnchor = Date.parse(m.retention.renewed_at ?? m.created_at);
  if (Date.parse(m.retention.expires_at) <= retentionAnchor) {
    return { ok: false, reason: "retention.expires_at must follow its retention anchor" };
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
  if (m.oversize_acknowledged !== undefined && typeof m.oversize_acknowledged !== "boolean") {
    return { ok: false, reason: "invalid oversize_acknowledged" };
  }
  return { ok: true, manifest: m as ArtifactManifestV2 };
}

function atomicWriteManifest(path: string, manifest: ArtifactManifestV2): void {
  const target = join(path, ARTIFACT_MANIFEST);
  const tmp = `${target}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export interface ArtifactMigrationEntry {
  path: string;
  action: "keep" | "would-migrate" | "migrated";
  reason: string;
  preimage_path?: string;
}

/** Explicit, bounded v1 cutover. Preview never writes; every applied unit keeps its exact preimage. */
export function migrateArtifacts(
  repoRoot: string,
  opts: { yes?: boolean } = {},
): ArtifactMigrationEntry[] {
  const migrate = (): ArtifactMigrationEntry[] => {
    const root = artifactsRoot(repoRoot);
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .sort()
      .map((name): ArtifactMigrationEntry => {
        const path = join(root, name);
        try {
          const stat = lstatSync(path);
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error("not a direct directory");
          if (containsTrackedPath(repoRoot, path))
            throw new Error("artifact contains tracked files");
          const target = join(path, ARTIFACT_MANIFEST);
          const manifestStat = lstatSync(target);
          if (
            !manifestStat.isFile() ||
            manifestStat.isSymbolicLink() ||
            manifestStat.size > 1024 * 1024
          ) {
            throw new Error("manifest is not a bounded regular file");
          }
          const preimage = readFileSync(target, "utf8");
          const legacy = JSON.parse(preimage);
          if (legacy?.schema_version !== 1) {
            return {
              path,
              action: "keep",
              reason: `schema_version ${String(legacy?.schema_version)} is not a migration source`,
            };
          }
          if (Object.hasOwn(legacy, "holds"))
            throw new Error("v1 manifest unexpectedly contains holds");
          const parsed = parseArtifactManifest({
            ...legacy,
            schema_version: ARTIFACT_SCHEMA_VERSION,
            holds: [],
          });
          if (!parsed.ok) throw new Error(parsed.reason);
          const digest = createHash("sha256").update(preimage).digest("hex");
          const preimagePath = join(
            resolve(repoRoot),
            ".harnery/artifact-migrations",
            `${digest}.v1.json`,
          );
          if (!opts.yes)
            return {
              path,
              action: "would-migrate",
              reason: "valid v1 manifest",
              preimage_path: preimagePath,
            };
          mkdirSync(dirname(preimagePath), { recursive: true });
          try {
            writeFileSync(preimagePath, preimage, { flag: "wx", mode: 0o600 });
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== "EEXIST" ||
              lstatSync(preimagePath).isSymbolicLink() ||
              readFileSync(preimagePath, "utf8") !== preimage
            )
              throw error;
          }
          if (readFileSync(target, "utf8") !== preimage)
            throw new Error("manifest changed before migration");
          atomicWriteManifest(path, parsed.manifest);
          return {
            path,
            action: "migrated",
            reason: "v1 preimage preserved; identity and retention unchanged",
            preimage_path: preimagePath,
          };
        } catch (error) {
          return { path, action: "keep", reason: errorMessage("migration refused", error) };
        }
      });
  };
  return opts.yes ? withArtifactLock(repoRoot, migrate) : migrate();
}

/** A persistent directory lock fails closed on contention or a crashed owner. */
function withArtifactLock<T>(repoRoot: string, action: () => T): T {
  const lock = join(resolve(repoRoot), ".harnery/artifacts-mutation.lock");
  mkdirSync(dirname(lock), { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    throw new Error(
      errorMessage(
        "artifact store mutation lock unavailable; retry after its owner finishes",
        error,
      ),
    );
  }
  try {
    return action();
  } finally {
    rmdirSync(lock);
  }
}

function validHoldId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function validHold(value: unknown): value is ArtifactHold {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hold = value as Partial<ArtifactHold>;
  return (
    validHoldId(hold.id) &&
    typeof hold.reason === "string" &&
    !!hold.reason.trim() &&
    validActor(hold.set_by) &&
    validIso(hold.set_at)
  );
}

function makeHold(
  input: ArtifactHoldInput,
  actor: ArtifactActor | undefined,
  now: Date,
): ArtifactHold {
  assertValidDate(now, "now");
  if (!validActor(actor)) throw new Error("a valid hold actor is required");
  if (!validHoldId(input.id)) throw new Error("invalid hold id");
  if (typeof input.reason !== "string" || !input.reason.trim())
    throw new Error("hold reason must not be empty");
  return {
    id: input.id,
    reason: input.reason.trim(),
    set_by: { ...actor },
    set_at: now.toISOString(),
  };
}

function ownerLiveness(
  repoRoot: string,
  instanceId: string,
  now: Date,
  freshnessSeconds: number,
): "live" | "stale" | "unknown" {
  try {
    const row = readLiveCoordinationRow(repoRoot, instanceId);
    if (!row) return "stale";
    const ts = Date.parse(row.last_heartbeat);
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

/**
 * Return the newest filesystem change in a managed tree without following
 * symlinks. A small future tolerance protects a write racing the inventory
 * scan; timestamps farther ahead are ignored as clock-skewed metadata.
 */
function safeTreeLastModified(path: string, now: Date): number | null {
  const nowMs = now.getTime();
  const futureToleranceMs = 5 * 60 * 1000;
  try {
    const st = lstatSync(path);
    let latest = 0;
    for (const timestamp of [st.mtimeMs, st.ctimeMs]) {
      if (Number.isFinite(timestamp) && timestamp <= nowMs + futureToleranceMs) {
        latest = Math.max(latest, Math.min(timestamp, nowMs));
      }
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return latest;
    for (const child of readdirSync(path)) {
      const childLatest = safeTreeLastModified(join(path, child), now);
      if (childLatest === null) return null;
      latest = Math.max(latest, childLatest);
    }
    return latest;
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
    last_modified_at: null,
    expires_at: null,
    owner_instance_id: null,
    oversize_acknowledged: false,
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

function positiveMinutes(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 3650 * 24 * 60) {
    throw new Error("retention minutes must be between 1 and 5256000");
  }
  return value;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
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
