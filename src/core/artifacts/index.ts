/**
 * Repository-local working artifacts.
 *
 * Artifacts are file trees that should survive an agent session but should not
 * become project records: screenshots, exports, audit dumps, rollback inputs,
 * and similar material. Each direct child of `.harnery/artifacts/` is one
 * managed unit with a small manifest. Cleanup fails closed: only a valid,
 * unheld, inactive, untracked managed unit is deletable, and only when its
 * retention expired or a size rule applies after its idle grace. Explicit
 * removal lets a creating owner delete its reviewed, unheld workspace sooner.
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
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readLiveCoordinationRow } from "../agents/state/live-coordination-view.ts";
import {
  artifactAutoCleanEnabled,
  artifactAutoCleanIntervalHours,
  artifactDefaultRetentionDays,
  artifactHoldDays,
  artifactIdleGraceHours,
  artifactMaxBytes,
  artifactMaxHeldBytes,
  artifactMaxUnitBytes,
  artifactMinFreeBytes,
  coordFreshnessSeconds,
  resolveBinName,
} from "../config.ts";
import {
  readCoordinationViewV3,
  requireAuthoritySafeCoordinationViewV3,
} from "../events/v3/coordination-view.ts";
import { liveInstanceIdV3 } from "../events/v3/live-route-observer.ts";
import { stateFileMode } from "../storage/modes.ts";
import {
  type ArtifactActivity,
  artifactRootEntries,
  readArtifactActivity,
  validArtifactActivity,
} from "./activity.ts";
import { ARTIFACT_MANIFEST, ARTIFACT_SCHEMA_VERSION, ARTIFACTS_DIR } from "./constants.ts";
import { withArtifactLock } from "./mutation-lock.ts";

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
  activity?: ArtifactActivity;
}

export interface ArtifactHold {
  id: string;
  reason: string;
  set_by: ArtifactActor;
  set_at: string;
  /** When the hold lapses unless renewed. Absent only on a persistent hold or
   * a hold recorded before holds expired; the latter stays in force. */
  expires_at?: string;
  /** Set by embedding hosts whose hold mirrors an external lease. Never lapses. */
  persistent?: true;
}

export interface ArtifactHoldInput {
  id: string;
  reason: string;
  /** Hold lifetime in days (1 to 365); defaults to `artifacts.hold_days`. */
  days?: number;
  /** Hold lifetime in minutes (1 to 525,600); replaces `days`. */
  minutes?: number;
  /** For a hold that mirrors an external lease, such as an open checkout with
   * unsynchronized work. The hold never lapses; its owner must remove it. */
  persistent?: boolean;
}

export function artifactCapabilities() {
  return {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    holds: true,
    atomic_create_holds: true,
    owner_scoped_unhold: true,
    explicit_v1_migration: true,
    minute_retention: true,
    discard_after_review: true,
    owner_scoped_remove: true,
    allow_big_after_create: true,
    hold_expiry: true,
    persistent_holds: true,
    held_budget: true,
    disk_free_report: true,
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
  /** Disk use: allocated blocks, each hard-linked file counted once. Every
   * size rule reads this figure. */
  bytes: number | null;
  /** Sum of file lengths. A sparse file makes this larger than `bytes`. */
  apparent_bytes: number | null;
  artifact_id: string | null;
  slug: string | null;
  created_at: string | null;
  last_modified_at: string | null;
  expires_at: string | null;
  owner_instance_id: string | null;
  oversize_acknowledged: boolean;
  /** Latest file change, owner heartbeat, renewal, or release. Size rules wait
   * `artifacts.idle_grace_hours` past this before they may delete. */
  idle_since: string | null;
  /** Advice for a unit that a size rule will delete once its grace ends. */
  warning: string | null;
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
  const holdDays = artifactHoldDays(repoRoot);
  const holds = (input.holds ?? []).map((hold) => makeHold(hold, input.actor, now, holdDays));
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
  atomicWriteManifest(path, manifest, now);
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
  return applyArtifactBudgets(repoRoot, rows, now);
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
  days: number | { minutes: number },
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
  days: number | { minutes: number },
  reason: string,
  input: ArtifactMutationInput,
): ArtifactManifestV2 {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  const expiresAt =
    typeof days === "number"
      ? addDays(now, positiveDays(days))
      : addMinutes(now, positiveMinutes(days.minutes));
  const why = reason.trim();
  if (!why) throw new Error("renewal reason must not be empty");
  const path = resolveArtifactRef(repoRoot, ref);
  const parsed = readManifest(path);
  if (!parsed.ok) throw new Error(parsed.reason);
  const manifest: ArtifactManifestV2 = {
    ...parsed.manifest,
    retention: {
      expires_at: expiresAt.toISOString(),
      renewed_at: now.toISOString(),
      reason: why,
    },
  };
  atomicWriteManifest(path, manifest, now);
  return manifest;
}

/**
 * Record the `--big` acknowledgement on an existing workspace, for work that
 * turns out larger than expected. Unlike a hold, it leaves expiry in force and
 * exempts the unit only from the per-bundle ceiling. Idempotent.
 */
export function allowBigArtifact(
  repoRoot: string,
  ref: string,
  input: ArtifactMutationInput = {},
): ArtifactManifestV2 {
  return withArtifactLock(repoRoot, () => {
    const path = resolveArtifactRef(repoRoot, ref);
    const parsed = readManifest(path);
    if (!parsed.ok) throw new Error(parsed.reason);
    if (parsed.manifest.oversize_acknowledged) return parsed.manifest;
    const manifest: ArtifactManifestV2 = { ...parsed.manifest, oversize_acknowledged: true };
    atomicWriteManifest(path, manifest, input.now);
    return manifest;
  });
}

export function releaseArtifact(
  repoRoot: string,
  ref: string,
  input: ArtifactMutationInput = {},
): ArtifactManifestV2 {
  return withArtifactLock(repoRoot, () => releaseArtifactUnlocked(repoRoot, ref, input));
}

/** Retire reviewed evidence without deleting it or extending an earlier deadline. */
export function discardArtifact(
  repoRoot: string,
  ref: string,
  reason: string,
  input: ArtifactMutationInput & { minutes?: number } = {},
): ArtifactManifestV2 {
  return withArtifactLock(repoRoot, () => {
    const now = input.now ?? new Date();
    assertValidDate(now, "now");
    const minutes = positiveMinutes(input.minutes ?? 60);
    const why = reason.trim();
    if (!why)
      throw new Error("discard requires a reason confirming the files are no longer needed");
    const path = resolveArtifactRef(repoRoot, ref);
    const entry = classifyArtifactPath(repoRoot, path, now, coordFreshnessSeconds(repoRoot));
    if (
      !["managed-current", "managed-expired", "managed-active"].includes(entry.classification) ||
      (entry.classification === "managed-active" &&
        entry.owner_instance_id !== input.actor?.instance_id)
    )
      throw new Error(`cannot discard artifact: ${entry.reason}`);
    const parsed = readManifest(path);
    if (!parsed.ok) throw new Error(parsed.reason);
    const manifest = parsed.manifest;
    const remaining = Date.parse(entry.expires_at!) - now.getTime();
    const priorWindow =
      Date.parse(manifest.retention.expires_at) -
      Date.parse(manifest.retention.renewed_at ?? manifest.created_at);
    const windowMs = Math.min(minutes * 60_000, remaining, priorWindow);
    const updated: ArtifactManifestV2 = {
      ...manifest,
      retention: {
        ...manifest.retention,
        ...(windowMs > 0
          ? {
              renewed_at: now.toISOString(),
              expires_at: new Date(now.getTime() + windowMs).toISOString(),
            }
          : {}),
        reason: why,
      },
      released_at: now.toISOString(),
      released_by: input.actor,
    };
    atomicWriteManifest(path, updated, now);
    return updated;
  });
}

export interface ArtifactRemovalResult {
  entry: ArtifactInventoryEntry;
  reason: string;
  deleted: boolean;
}

/** Preview or immediately remove one reviewed workspace belonging to this actor. */
export function removeArtifact(
  repoRoot: string,
  ref: string,
  reason: string,
  input: ArtifactMutationInput & { yes?: boolean } = {},
): ArtifactRemovalResult {
  const why = reason.trim();
  if (!why) throw new Error("remove requires a reason confirming the files are no longer needed");
  if (!validActor(input.actor))
    throw new Error("remove requires a current artifact owner identity");
  const actor = input.actor;
  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  const store = artifactsRoot(repoRoot);
  const checkStore = () => {
    for (const path of [resolve(repoRoot), dirname(store), store]) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("artifact store must use real directories, not symlinks");
    }
  };
  checkStore();
  return withArtifactLock(repoRoot, () => {
    checkStore();
    const path = resolveArtifactRef(repoRoot, ref);
    const inspect = () => {
      const target = realpathSync(path);
      const cwd = realpathSync(process.cwd());
      if (cwd === target || cwd.startsWith(`${target}${sep}`))
        throw new Error("cannot remove the working directory or its ancestor");
      if (lstatSync(path).dev !== lstatSync(store).dev)
        throw new Error("artifact removal cannot cross a mount boundary");
      const entry = classifyArtifactPath(repoRoot, path, now, coordFreshnessSeconds(repoRoot));
      if (!["managed-current", "managed-expired", "managed-active"].includes(entry.classification))
        throw new Error(`cannot remove artifact: ${entry.reason}`);
      if (entry.owner_instance_id !== actor.instance_id)
        throw new Error("only the creating artifact owner may remove this workspace");
      const view = requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(repoRoot));
      for (const peer of Object.values(view.instances)) {
        if (!peer.authority_eligible || peer.instance_id === liveInstanceIdV3(actor.instance_id))
          continue;
        for (const claim of peer.files_touched) {
          const claimed = resolve(repoRoot, claim);
          if (
            path === claimed ||
            path.startsWith(`${claimed}${sep}`) ||
            claimed.startsWith(`${path}${sep}`)
          )
            throw new Error(`artifact overlaps another agent's claim: ${claim}`);
        }
      }
      return entry;
    };
    const entry = inspect();
    const before = artifactRemovalSnapshot(path);
    if (!input.yes) return { entry, reason: why, deleted: false };
    // Metadata mutations share this lock. Recheck payload, claims, and protections
    // immediately before removal because ordinary file writers do not take it.
    checkStore();
    const current = inspect();
    if (
      !isDeepStrictEqual(entry, current) ||
      !isDeepStrictEqual(before, artifactRemovalSnapshot(path))
    )
      throw new Error("artifact changed during removal inspection; preview it again");
    rmSync(path, { recursive: true, force: false });
    const removed = { ...current, action: "deleted" as const, reason: why };
    recordArtifactDeletion(repoRoot, removed, now, actor);
    return { entry: removed, reason: why, deleted: true };
  });
}

/** Refuse links, mounts, special files, and embedded stores; fingerprint every entry. */
function artifactRemovalSnapshot(path: string): Map<string, string> {
  const device = lstatSync(path).dev;
  const entries = new Map<string, string>();
  const walk = (target: string) => {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || stat.dev !== device || (!stat.isFile() && !stat.isDirectory()))
      throw new Error(`unsafe artifact removal path: ${target}`);
    if (target !== path && [".git", ".harnery"].includes(basename(target)))
      throw new Error(`embedded repository or coordination state cannot be removed: ${target}`);
    if (target !== join(path, ARTIFACT_MANIFEST) && basename(target) === ARTIFACT_MANIFEST)
      throw new Error(`nested artifact must be managed separately: ${target}`);
    entries.set(
      target,
      [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"),
    );
    if (stat.isDirectory()) {
      const names = readdirSync(target).sort();
      if (names.includes("HEAD") && names.includes("objects") && names.includes("config"))
        throw new Error(`embedded Git metadata cannot be removed: ${target}`);
      for (const name of names) walk(join(target, name));
    }
  };
  walk(path);
  return entries;
}

/** Advice only: a successful check does not establish that its evidence is disposable. */
export function artifactReviewGuidance(repoRoot: string, ref: string): string {
  const target = isAbsolute(ref) ? basename(ref) : ref;
  if (!/^[A-Za-z0-9_.-]+$/.test(target))
    throw new Error("review guidance requires an artifact id or directory name");
  return `After reviewing these files, if they are disposable or superseded and no review, handoff, failure investigation, or final evidence depends on them, run ${resolveBinName(repoRoot)} artifacts discard ${target} --reason "Reviewed; no longer needed" (60-minute grace). Otherwise retain them; use a hold for pending review.`;
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
  atomicWriteManifest(path, manifest, now);
  return manifest;
}

export function holdArtifact(
  repoRoot: string,
  ref: string,
  input: ArtifactHoldInput & { actor: ArtifactActor; now?: Date },
): ArtifactManifestV2 {
  const hold = makeHold(input, input.actor, input.now ?? new Date(), artifactHoldDays(repoRoot));
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
      // Repeating a hold renews it: the original owner and set_at stay, and the
      // window restarts from now. A persistent hold stays persistent.
      const { expires_at: _expires, persistent: _persistent, ...kept } = previous;
      const renewed: ArtifactHold =
        previous.persistent || hold.persistent
          ? { ...kept, persistent: true }
          : { ...kept, expires_at: hold.expires_at! };
      const manifest = {
        ...parsed.manifest,
        holds: parsed.manifest.holds.map((item) => (item.id === hold.id ? renewed : item)),
      };
      atomicWriteManifest(path, manifest, input.now);
      return manifest;
    }
    const manifest = { ...parsed.manifest, holds: [...parsed.manifest.holds, hold] };
    atomicWriteManifest(path, manifest, input.now);
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
    atomicWriteManifest(path, manifest, input.now);
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
  opts: {
    yes?: boolean;
    now?: Date;
    freshnessSeconds?: number;
    maxDeletes?: number;
    timeBudgetMs?: number;
  },
): ArtifactInventoryEntry[] {
  const started = performance.now();
  const now = opts.now ?? new Date();
  const freshnessSeconds = opts.freshnessSeconds ?? 600;
  const rows = inventoryArtifacts(repoRoot, { now, freshnessSeconds });
  if (!opts.yes) return rows;

  let attempted = 0;
  return rows.map((entry) => {
    if (entry.action !== "would-delete") return entry;
    if (
      attempted >= (opts.maxDeletes ?? Infinity) ||
      (attempted > 0 && performance.now() - started >= (opts.timeBudgetMs ?? Infinity))
    )
      return entry;
    attempted++;
    // Reclassify immediately before removal. A renewal, release-state change,
    // heartbeat, symlink swap, or tracked file added since inventory must win.
    // Only repository-budget eviction needs a new whole-store plan. Expiry and
    // per-unit size are local decisions; recheck all their guards on the target.
    const current =
      entry.classification === "managed-over-budget"
        ? inventoryArtifacts(repoRoot, { now, freshnessSeconds }).find(
            (row) => row.path === entry.path,
          )
        : applyArtifactUnitBudget(
            repoRoot,
            classifyArtifactPath(repoRoot, entry.path, now, freshnessSeconds),
            now,
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
      recordArtifactDeletion(repoRoot, current, now);
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

/** Sibling of the artifacts root, like the stamp, so it never enters the inventory. */
const DELETION_LOG = ".harnery/artifact-deletions.jsonl";
const DELETION_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ArtifactDeletionRecord {
  deleted_at: string;
  name: string;
  relative_path: string;
  artifact_id: string | null;
  slug: string | null;
  owner_instance_id: string | null;
  classification: ArtifactClassification;
  reason: string;
  bytes: number | null;
  apparent_bytes: number | null;
  expires_at: string | null;
  idle_since: string | null;
  removed_by?: ArtifactActor;
}

/**
 * Append one deletion to the log, keeping 30 days. Callers hold the artifact
 * lock. Best-effort: the directory is already gone, so a failed write must not
 * turn a completed deletion into a reported failure.
 */
function recordArtifactDeletion(
  repoRoot: string,
  row: ArtifactInventoryEntry,
  now: Date,
  removedBy?: ArtifactActor,
): void {
  const record: ArtifactDeletionRecord = {
    deleted_at: now.toISOString(),
    name: row.name,
    relative_path: row.relative_path,
    artifact_id: row.artifact_id,
    slug: row.slug,
    owner_instance_id: row.owner_instance_id,
    classification: row.classification,
    reason: row.reason,
    bytes: row.bytes,
    apparent_bytes: row.apparent_bytes,
    expires_at: row.expires_at,
    idle_since: row.idle_since,
    ...(removedBy ? { removed_by: removedBy } : {}),
  };
  try {
    const path = join(resolve(repoRoot), DELETION_LOG);
    const kept = readArtifactDeletions(repoRoot, {
      since: new Date(now.getTime() - DELETION_LOG_RETENTION_MS),
    });
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, [...kept, record].map((item) => `${JSON.stringify(item)}\n`).join(""), {
      mode: stateFileMode(),
    });
    renameSync(temp, path);
  } catch {
    // See the doc comment: the deletion stands even if its record cannot.
  }
}

/** Deletions the cleanup recorded, oldest first. Unreadable lines are skipped. */
export function readArtifactDeletions(
  repoRoot: string,
  opts: { since?: Date } = {},
): ArtifactDeletionRecord[] {
  let text: string;
  try {
    text = readFileSync(join(resolve(repoRoot), DELETION_LOG), "utf8");
  } catch {
    return [];
  }
  const since = opts.since?.getTime() ?? -Infinity;
  const records: ArtifactDeletionRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as ArtifactDeletionRecord;
      if (typeof record?.name === "string" && Date.parse(record.deleted_at) >= since)
        records.push(record);
    } catch {
      // A torn or foreign line does not hide the others.
    }
  }
  return records;
}

/** Sibling of the artifacts root, like the deletion log, so it never enters the inventory. */
const USAGE_CACHE = ".harnery/artifact-usage.json";
const LARGEST_HOLDS = 5;

export interface ArtifactHeldSummary {
  name: string;
  bytes: number;
  holds: Array<{
    id: string;
    /** The hold owner's name when recorded, otherwise its instance id. */
    set_by: string;
    expires_at: string | null;
    persistent: boolean;
  }>;
}

/** Last full-inventory measurement, read by commands that must not walk the store. */
export interface ArtifactUsageCache {
  measured_at: string;
  bytes: number;
  held_bytes: number;
  free_bytes: number | null;
  largest_holds: ArtifactHeldSummary[];
}

export interface ArtifactUsageReport {
  held_bytes: number;
  max_held_bytes: number;
  held_over_budget: boolean;
  largest_holds: ArtifactHeldSummary[];
  free_bytes: number | null;
  min_free_bytes: number;
  low_disk: boolean;
  /** Plain sentences for a human; empty when nothing needs attention. */
  warnings: string[];
}

/** Bytes available to this user on the artifact store's filesystem, or null. */
export function artifactFreeBytes(repoRoot: string): number | null {
  try {
    const root = artifactsRoot(repoRoot);
    const stat = statfsSync(existsSync(root) ? root : resolve(repoRoot));
    const free = Number(stat.bavail) * Number(stat.bsize);
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch {
    return null;
  }
}

/**
 * Held bytes, free disk, and warnings for one full inventory. Held work is
 * never deleted: the held budget and the disk floor only report. Records the
 * measurement in `.harnery/artifact-usage.json` so `create` and `hold` can
 * warn without walking the store.
 */
export function artifactUsageReport(
  repoRoot: string,
  rows: ArtifactInventoryEntry[],
  opts: { now?: Date } = {},
): ArtifactUsageReport {
  const now = opts.now ?? new Date();
  const kept = rows.filter((row) => row.action !== "deleted");
  const held = kept.filter((row) => row.classification === "managed-held");
  const heldBytes = held.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
  const largest = [...held]
    .sort((left, right) => (right.bytes ?? 0) - (left.bytes ?? 0))
    .slice(0, LARGEST_HOLDS)
    .map((row) => heldSummary(row));
  const freeBytes = artifactFreeBytes(repoRoot);
  if (existsSync(artifactsRoot(repoRoot))) {
    writeUsageCache(repoRoot, {
      measured_at: now.toISOString(),
      bytes: kept.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
      held_bytes: heldBytes,
      free_bytes: freeBytes,
      largest_holds: largest,
    });
  }
  return usageReport(repoRoot, heldBytes, largest, freeBytes, null);
}

/** The cached measurement, or null when none was recorded or it is unreadable. */
export function readArtifactUsageCache(repoRoot: string): ArtifactUsageCache | null {
  try {
    const value = JSON.parse(readFileSync(join(resolve(repoRoot), USAGE_CACHE), "utf8"));
    if (
      !value ||
      !validIso(value.measured_at) ||
      typeof value.held_bytes !== "number" ||
      typeof value.bytes !== "number"
    )
      return null;
    return {
      measured_at: value.measured_at,
      bytes: value.bytes,
      held_bytes: value.held_bytes,
      free_bytes: typeof value.free_bytes === "number" ? value.free_bytes : null,
      largest_holds: Array.isArray(value.largest_holds) ? value.largest_holds : [],
    };
  } catch {
    return null;
  }
}

/**
 * Usage for commands that must stay cheap (`create`, `hold`): held bytes from
 * the last full inventory, free disk measured now. Never walks the store.
 */
export function artifactQuickUsage(repoRoot: string): {
  usage: { held_bytes: number | null; held_measured_at: string | null; free_bytes: number | null };
  low_disk: boolean;
  min_free_bytes: number;
  warnings: string[];
} {
  const cache = readArtifactUsageCache(repoRoot);
  const freeBytes = artifactFreeBytes(repoRoot);
  const report = usageReport(
    repoRoot,
    cache?.held_bytes ?? 0,
    cache?.largest_holds ?? [],
    freeBytes,
    cache?.measured_at ?? null,
  );
  return {
    usage: {
      held_bytes: cache?.held_bytes ?? null,
      held_measured_at: cache?.measured_at ?? null,
      free_bytes: freeBytes,
    },
    low_disk: report.low_disk,
    min_free_bytes: report.min_free_bytes,
    warnings: report.warnings,
  };
}

/**
 * Refuse new large work when the artifact store's disk is below its floor.
 * `create --big` calls this; `--allow-low-disk` is the deliberate override.
 */
export function assertArtifactDiskFloor(repoRoot: string): void {
  const minFree = artifactMinFreeBytes(repoRoot);
  const freeBytes = artifactFreeBytes(repoRoot);
  if (minFree === 0 || freeBytes === null || freeBytes >= minFree) return;
  const bin = resolveBinName(repoRoot);
  throw new Error(
    `only ${gib(freeBytes)} is free on the artifact store's disk, below the ${gib(minFree)} floor (artifacts.min_free_bytes), so a --big workspace was not created. Free space with \`${bin} artifacts clean --yes\`, \`${bin} artifacts discard <ref> --reason <text>\` for reviewed work, or \`${bin} artifacts unhold <ref> --id <id>\` for finished holds, then retry. Pass --allow-low-disk to create it anyway.`,
  );
}

function heldSummary(row: ArtifactInventoryEntry): ArtifactHeldSummary {
  const parsed = readManifest(row.path);
  return {
    name: row.name,
    bytes: row.bytes ?? 0,
    holds: parsed.ok
      ? parsed.manifest.holds.map((hold) => ({
          id: hold.id,
          set_by: hold.set_by.name ?? hold.set_by.instance_id,
          expires_at: hold.expires_at ?? null,
          persistent: hold.persistent === true,
        }))
      : [],
  };
}

function usageReport(
  repoRoot: string,
  heldBytes: number,
  largest: ArtifactHeldSummary[],
  freeBytes: number | null,
  measuredAt: string | null,
): ArtifactUsageReport {
  const maxHeld = artifactMaxHeldBytes(repoRoot);
  const minFree = artifactMinFreeBytes(repoRoot);
  const heldOver = heldBytes > maxHeld;
  const lowDisk = minFree > 0 && freeBytes !== null && freeBytes < minFree;
  const bin = resolveBinName(repoRoot);
  const warnings: string[] = [];
  if (heldOver) {
    const list = largest
      .map(
        (item) =>
          `${item.name} (${gib(item.bytes)}${item.holds.length ? `, hold ${item.holds.map((hold) => hold.id).join(", ")}` : ""})`,
      )
      .join("; ");
    warnings.push(
      `Held artifacts use ${gib(heldBytes)}${measuredAt ? ` as of ${measuredAt}` : ""}, above the ${gib(maxHeld)} held budget (artifacts.max_held_bytes). Holds are never deleted automatically; release or prune the largest${list ? `: ${list}` : ""}. Remove a finished hold with \`${bin} artifacts unhold <name> --id <id>\`.`,
    );
  }
  if (lowDisk) {
    warnings.push(
      `Only ${gib(freeBytes!)} is free on the artifact store's disk, below the ${gib(minFree)} floor (artifacts.min_free_bytes). Free space with \`${bin} artifacts clean --yes\`, discard reviewed workspaces, or unhold finished work; \`${bin} artifacts create --big\` refuses until then.`,
    );
  }
  return {
    held_bytes: heldBytes,
    max_held_bytes: maxHeld,
    held_over_budget: heldOver,
    largest_holds: largest,
    free_bytes: freeBytes,
    min_free_bytes: minFree,
    low_disk: lowDisk,
    warnings,
  };
}

function writeUsageCache(repoRoot: string, cache: ArtifactUsageCache): void {
  try {
    const path = join(resolve(repoRoot), USAGE_CACHE);
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, { mode: stateFileMode() });
    renameSync(temp, path);
  } catch {
    // The cache only feeds warnings; a failed write must not fail the inventory.
  }
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** Sibling of the artifacts root so the stamp never appears in the inventory scan. */
const AUTO_CLEAN_STAMP = ".harnery/artifacts-auto-clean.json";

export interface ArtifactAutoCleanResult {
  ran: boolean;
  reason: "swept" | "partial" | "failed" | "disabled" | "fresh" | "no-root";
  deleted: number;
  bytes: number;
}

/**
 * Throttled expired-artifact sweep, fired at SessionStart and before new work.
 *
 * Retention was previously enforced only when someone remembered to run
 * `artifacts clean --yes`, so expired workspaces accumulated indefinitely on
 * busy hosts. This runs the exact same guarded deletion as `artifacts clean
 * --yes` (expired entries, plus oversize or over-budget entries idle past
 * `artifacts.idle_grace_hours`, each re-classified immediately before removal
 * and recorded in the deletion log; unmanaged and legacy directories are never
 * touched) at most once per
 * interval (default 1h after completion, 1m between partial/failed slices).
 * The owner-aware lock serializes callers; interrupted attempts can retry.
 * Disable with `artifacts.auto_clean: false` or
 * `HARNERY_ARTIFACT_AUTO_CLEAN=0`.
 */
export function autoCleanArtifacts(
  repoRoot: string,
  opts: { now?: Date; maxDeletes?: number; timeBudgetMs?: number } = {},
): ArtifactAutoCleanResult {
  if (!existsSync(artifactsRoot(repoRoot))) {
    return { ran: false, reason: "no-root", deleted: 0, bytes: 0 };
  }
  if (!artifactAutoCleanEnabled(repoRoot)) {
    return { ran: false, reason: "disabled", deleted: 0, bytes: 0 };
  }
  return withArtifactLock(repoRoot, () => autoCleanArtifactsUnlocked(repoRoot, opts));
}

function autoCleanArtifactsUnlocked(
  repoRoot: string,
  opts: { now?: Date; maxDeletes?: number; timeBudgetMs?: number },
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
    const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as {
      status?: string;
      last_completed_at?: string;
      retry_after?: string;
    };
    const last = Date.parse(stamp.last_completed_at ?? "");
    if (
      (stamp.status === "completed" &&
        Number.isFinite(last) &&
        now.getTime() - last < intervalMs) ||
      (["partial", "failed"].includes(stamp.status ?? "") &&
        Date.parse(stamp.retry_after ?? "") > now.getTime())
    ) {
      return { ran: false, reason: "fresh", deleted: 0, bytes: 0 };
    }
  } catch {
    // Missing or unreadable stamp: sweep now and write a fresh one.
  }
  const maxDeletes = opts.maxDeletes ?? 10;
  const timeBudgetMs = opts.timeBudgetMs ?? 5000;
  if (
    !Number.isSafeInteger(maxDeletes) ||
    maxDeletes < 1 ||
    !Number.isFinite(timeBudgetMs) ||
    timeBudgetMs < 0
  )
    throw new Error(
      "cleanup limits must allow at least one deletion and a nonnegative time budget",
    );
  const attempt = { last_attempt_at: now.toISOString() };
  const writeStamp = (state: object) => {
    const temp = `${stampPath}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temp, stampPath);
  };
  writeStamp({ ...attempt, status: "running" });
  try {
    const rows = cleanArtifactsUnlocked(repoRoot, { yes: true, now, maxDeletes, timeBudgetMs });
    const deletedRows = rows.filter((row) => row.action === "deleted");
    const deleted = deletedRows.length;
    const bytes = deletedRows.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
    const remaining = rows.filter((row) => row.action === "would-delete").length;
    const failures = rows
      .filter((row) => row.classification === "unknown")
      .map((row) => ({ name: row.name, reason: row.reason }));
    const status = failures.length ? "failed" : remaining ? "partial" : "completed";
    artifactUsageReport(repoRoot, rows, { now });
    writeStamp({
      ...attempt,
      status,
      deleted,
      bytes,
      remaining,
      failures,
      ...(status === "completed"
        ? { last_completed_at: now.toISOString() }
        : { retry_after: new Date(now.getTime() + 60_000).toISOString() }),
    });
    return { ran: true, reason: status === "completed" ? "swept" : status, deleted, bytes };
  } catch (error) {
    writeStamp({
      ...attempt,
      status: "failed",
      error: errorMessage("cleanup failed", error),
      retry_after: new Date(now.getTime() + 60_000).toISOString(),
    });
    throw error;
  }
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
  const usage = safeTreeUsage(path);
  const lastModifiedMs = safeTreeLastModified(path, now, manifest.activity);
  const retentionAnchorMs = Date.parse(manifest.retention.renewed_at ?? manifest.created_at);
  const retentionWindowMs = Date.parse(manifest.retention.expires_at) - retentionAnchorMs;
  const effectiveLastModifiedMs = Math.max(retentionAnchorMs, lastModifiedMs ?? 0);
  const holds = artifactHoldState(manifest, now);
  // A lapsed hold protected the files until its deadline, so ordinary expiry
  // and the size-rule idle clock both count from the latest lapse.
  const lapsedMs = Math.max(0, ...holds.lapsed.map((hold) => Date.parse(hold.expires_at!)));
  const effectiveExpiresAt = new Date(
    Math.max(effectiveLastModifiedMs + retentionWindowMs, lapsedMs),
  ).toISOString();
  const base = rowFor(path, name, repoRoot, "managed-current", "retention has not expired", usage);
  const releasedMs = Math.max(
    manifest.released_at ? Date.parse(manifest.released_at) : 0,
    lapsedMs,
  );
  Object.assign(base, {
    artifact_id: manifest.artifact_id,
    slug: manifest.slug,
    created_at: manifest.created_at,
    last_modified_at: new Date(effectiveLastModifiedMs).toISOString(),
    expires_at: effectiveExpiresAt,
    owner_instance_id: manifest.created_by?.instance_id ?? null,
    oversize_acknowledged: manifest.oversize_acknowledged === true,
    idle_since: new Date(Math.max(effectiveLastModifiedMs, releasedMs)).toISOString(),
  });

  if (holds.active.length > 0) {
    return {
      ...base,
      classification: "managed-held",
      reason: `held: ${holds.active.map((hold) => hold.id).join(", ")}`,
      action: "keep",
      warning: holdWarning(repoRoot, name, holds.active, now),
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
    const { state: live, heartbeatMs } = ownerLiveness(
      repoRoot,
      manifest.created_by.instance_id,
      now,
      freshnessSeconds,
    );
    // A stale heartbeat only starts the idle clock. The owner may be waiting
    // for a human reply, so size rules still wait out the grace from here.
    if (heartbeatMs !== null && heartbeatMs > Date.parse(base.idle_since!)) {
      base.idle_since = new Date(Math.min(heartbeatMs, now.getTime())).toISOString();
    }
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
  const lapsedNote = holds.lapsed.length
    ? `; hold ${holds.lapsed.map((hold) => `${hold.id} lapsed at ${hold.expires_at}`).join(", ")}`
    : "";
  return {
    ...base,
    classification: "managed-expired",
    reason: `retention expired at ${effectiveExpiresAt}${lapsedNote}`,
    action: "would-delete",
  };
}

/** Advice for held rows: an imminent lapse, or a hold that never expires. */
function holdWarning(
  repoRoot: string,
  name: string,
  active: ArtifactHold[],
  now: Date,
): string | null {
  const bin = resolveBinName(repoRoot);
  const notes: string[] = [];
  for (const hold of active) {
    if (hold.persistent) continue;
    const renew = `${bin} artifacts hold ${name} --id ${hold.id} --reason ${JSON.stringify(hold.reason)}`;
    if (!hold.expires_at) {
      notes.push(
        `hold ${hold.id} has no expiry because it predates hold expiry; re-holding with \`${renew}\` starts one, or unhold it when the work is done`,
      );
    } else if (Date.parse(hold.expires_at) - now.getTime() <= HOLD_LAPSE_WARNING_MS) {
      notes.push(`hold ${hold.id} lapses at ${hold.expires_at}; renew with \`${renew}\``);
    }
  }
  return notes.length ? notes.join("; ") : null;
}

/** When a size rule may first delete this unit, or null when it never may. */
function sizeEvictableAt(repoRoot: string, row: ArtifactInventoryEntry): number | null {
  if (!row.idle_since) return null;
  const idleSince = Date.parse(row.idle_since);
  if (!Number.isFinite(idleSince)) return null;
  return idleSince + artifactIdleGraceHours(repoRoot) * 60 * 60 * 1000;
}

function applyArtifactUnitBudget(
  repoRoot: string,
  row: ArtifactInventoryEntry,
  now: Date,
): ArtifactInventoryEntry {
  const maxUnitBytes = artifactMaxUnitBytes(repoRoot);
  if (
    !["managed-current", "managed-active"].includes(row.classification) ||
    row.bytes === null ||
    row.bytes <= maxUnitBytes ||
    row.oversize_acknowledged
  ) {
    return row;
  }
  const evictableAt = sizeEvictableAt(repoRoot, row);
  if (
    row.classification === "managed-current" &&
    evictableAt !== null &&
    now.getTime() >= evictableAt
  ) {
    return {
      ...row,
      classification: "managed-oversize",
      action: "would-delete",
      reason: `bundle uses ${row.bytes} bytes on disk, above the ${maxUnitBytes}-byte ceiling without --big, and has been idle for ${artifactIdleGraceHours(repoRoot)}h`,
    };
  }
  const when =
    row.classification === "managed-active" || evictableAt === null
      ? `${artifactIdleGraceHours(repoRoot)}h after its owner goes idle`
      : `after ${new Date(evictableAt).toISOString()} unless it changes first`;
  return {
    ...row,
    warning: `uses ${row.bytes} bytes on disk, above the ${maxUnitBytes}-byte per-workspace ceiling; cleanup will delete it ${when}. If it is meant to be this large, run ${resolveBinName(repoRoot)} artifacts allow-big ${row.name}; otherwise move rebuildable content out of the artifact store`,
  };
}

function applyArtifactBudgets(
  repoRoot: string,
  inputRows: ArtifactInventoryEntry[],
  now: Date,
): ArtifactInventoryEntry[] {
  const maxBytes = artifactMaxBytes(repoRoot);
  const rows = inputRows.map((row) => applyArtifactUnitBudget(repoRoot, { ...row }, now));

  // Held units can never be evicted, so counting them would push every other
  // unit out without bringing the store under budget.
  const managedBytes = rows.reduce(
    (sum, row) =>
      sum +
      (row.artifact_id && row.classification !== "managed-held" && row.bytes !== null
        ? row.bytes
        : 0),
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
    .filter((row) => {
      if (row.classification !== "managed-current" || row.action !== "keep" || row.bytes === null)
        return false;
      const evictableAt = sizeEvictableAt(repoRoot, row);
      return evictableAt !== null && now.getTime() >= evictableAt;
    })
    .sort((left, right) =>
      `${left.expires_at ?? ""}\0${left.created_at ?? ""}\0${left.name}`.localeCompare(
        `${right.expires_at ?? ""}\0${right.created_at ?? ""}\0${right.name}`,
      ),
    );
  for (const row of candidates) {
    if (retainedBytes <= maxBytes) break;
    row.classification = "managed-over-budget";
    row.reason = `repository artifact budget is ${maxBytes} bytes of disk use; earliest-expiring bundles idle for ${artifactIdleGraceHours(repoRoot)}h are removed first`;
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
  if (m.activity !== undefined && !validArtifactActivity(m.activity)) {
    return { ok: false, reason: "invalid activity checkpoint" };
  }
  return { ok: true, manifest: m as ArtifactManifestV2 };
}

function atomicWriteManifest(path: string, manifest: ArtifactManifestV2, now = new Date()): void {
  const target = join(path, ARTIFACT_MANIFEST);
  manifest.activity = readArtifactActivity(
    path,
    now,
    existsSync(target)
      ? manifest.activity
      : {
          last_changed_at: manifest.created_at,
          root_entries_sha256: artifactRootEntries(path),
        },
  );
  const tmp = `${target}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: stateFileMode(),
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
  opts: { yes?: boolean; now?: Date } = {},
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
            writeFileSync(preimagePath, preimage, { flag: "wx", mode: stateFileMode() });
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
          atomicWriteManifest(path, parsed.manifest, opts.now);
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

export interface ArtifactActivityRepairEntry {
  path: string;
  action: "keep" | "would-repair" | "repaired";
  reason: string;
  previous_expires_at?: string;
  repaired_expires_at?: string;
  receipt_path?: string;
}

/** Repair only a provable, untouched v1-to-v2 migration. Never delete payloads.
 * Old migrations saved the original manifest but not the original root stat.
 * The exact preimage and coincident root/manifest/receipt timestamps bound this
 * correction. Any later root change or metadata mutation requires manual review.
 */
export function repairArtifactActivity(
  repoRoot: string,
  opts: { yes?: boolean; now?: Date } = {},
): ArtifactActivityRepairEntry[] {
  const repair = (): ArtifactActivityRepairEntry[] => {
    const now = opts.now ?? new Date();
    assertValidDate(now, "now");
    const preimageRoot = join(resolve(repoRoot), ".harnery/artifact-migrations");
    const preimages = new Map<string, { value: unknown; path: string; mtime: number }[]>();
    if (existsSync(preimageRoot) && !lstatSync(preimageRoot).isSymbolicLink()) {
      for (const name of readdirSync(preimageRoot)) {
        if (!/^[a-f0-9]{64}\.v1\.json$/.test(name)) continue;
        const file = join(preimageRoot, name);
        try {
          const stat = lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) continue;
          const bytes = readFileSync(file, "utf8");
          if (`${createHash("sha256").update(bytes).digest("hex")}.v1.json` !== name) continue;
          const old = JSON.parse(bytes);
          if (
            old?.schema_version !== 1 ||
            Object.hasOwn(old, "holds") ||
            Object.hasOwn(old, "activity")
          )
            continue;
          const upgraded = { ...old, schema_version: ARTIFACT_SCHEMA_VERSION, holds: [] };
          const parsed = parseArtifactManifest(upgraded);
          if (!parsed.ok) continue;
          const items = preimages.get(parsed.manifest.artifact_id) ?? [];
          items.push({ value: upgraded, path: file, mtime: stat.mtimeMs });
          preimages.set(parsed.manifest.artifact_id, items);
        } catch {
          // Unverifiable preimages confer no repair authority.
        }
      }
    }
    const root = artifactsRoot(repoRoot);
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .sort()
      .map((name): ArtifactActivityRepairEntry => {
        const path = join(root, name);
        try {
          const parsed = readManifest(path);
          if (!parsed.ok) throw new Error(parsed.reason);
          const manifest = parsed.manifest;
          if (manifest.activity)
            return { path, action: "keep", reason: "activity already recorded" };
          const source = preimages
            .get(manifest.artifact_id)
            ?.find((item) => isDeepStrictEqual(item.value, manifest));
          if (!source) throw new Error("no exact migration preimage");
          if (containsTrackedPath(repoRoot, path))
            throw new Error("artifact contains tracked files");
          const target = join(path, ARTIFACT_MANIFEST);
          const before = readFileSync(target, "utf8");
          const unitStat = lstatSync(path);
          const manifestStat = lstatSync(target);
          if (
            unitStat.mtimeMs !== manifestStat.mtimeMs ||
            unitStat.ctimeMs !== manifestStat.ctimeMs ||
            manifestStat.mtimeMs !== manifestStat.ctimeMs ||
            manifestStat.mtimeMs < source.mtime ||
            manifestStat.mtimeMs - source.mtime > 5000
          )
            throw new Error("root or manifest changed outside the recorded migration");
          const anchor = manifest.retention.renewed_at ?? manifest.created_at;
          const oldActivity = readArtifactActivity(path, now);
          const activity = readArtifactActivity(path, now, {
            last_changed_at: anchor,
            root_entries_sha256: artifactRootEntries(path),
          });
          const windowMs = Date.parse(manifest.retention.expires_at) - Date.parse(anchor);
          const expiry = (changedAt: string) =>
            new Date(Math.max(Date.parse(anchor), Date.parse(changedAt)) + windowMs).toISOString();
          const row: ArtifactActivityRepairEntry = {
            path,
            action: opts.yes ? "repaired" : "would-repair",
            reason:
              "exact migration preimage; unchanged root; payload activity and retention preserved",
            previous_expires_at: expiry(oldActivity.last_changed_at),
            repaired_expires_at: expiry(activity.last_changed_at),
          };
          if (!opts.yes) return row;
          const receipt = join(
            preimageRoot,
            `${manifest.artifact_id}.${randomUUID()}.activity-repair.json`,
          );
          writeFileSync(
            receipt,
            `${JSON.stringify(
              {
                schema_version: 1,
                repaired_at: now.toISOString(),
                path: relative(repoRoot, path),
                preimage_path: relative(repoRoot, source.path),
                original_manifest: before,
                activity,
                previous_expires_at: row.previous_expires_at,
                repaired_expires_at: row.repaired_expires_at,
              },
              null,
              2,
            )}\n`,
            { flag: "wx", mode: stateFileMode() },
          );
          const current = lstatSync(path);
          if (
            readFileSync(target, "utf8") !== before ||
            current.mtimeMs !== unitStat.mtimeMs ||
            current.ctimeMs !== unitStat.ctimeMs
          )
            throw new Error("artifact changed before repair");
          atomicWriteManifest(path, { ...manifest, activity }, now);
          return { ...row, receipt_path: receipt };
        } catch (error) {
          return { path, action: "keep", reason: errorMessage("activity repair refused", error) };
        }
      });
  };
  return opts.yes ? withArtifactLock(repoRoot, repair) : repair();
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
    validIso(hold.set_at) &&
    (hold.expires_at === undefined || validIso(hold.expires_at)) &&
    (hold.persistent === undefined || hold.persistent === true) &&
    !(hold.persistent && hold.expires_at !== undefined)
  );
}

const HOLD_LAPSE_WARNING_MS = 48 * 60 * 60 * 1000;

/**
 * Split holds into those still in force and those that lapsed. A persistent
 * hold never lapses. A hold recorded before holds expired has no `expires_at`
 * and stays in force until its owner removes or renews it.
 */
export function artifactHoldState(
  manifest: Pick<ArtifactManifestV2, "holds">,
  now: Date = new Date(),
): { active: ArtifactHold[]; lapsed: ArtifactHold[] } {
  const active: ArtifactHold[] = [];
  const lapsed: ArtifactHold[] = [];
  for (const hold of manifest.holds) {
    if (hold.persistent || !hold.expires_at || Date.parse(hold.expires_at) > now.getTime())
      active.push(hold);
    else lapsed.push(hold);
  }
  return { active, lapsed };
}

function makeHold(
  input: ArtifactHoldInput,
  actor: ArtifactActor | undefined,
  now: Date,
  defaultDays: number,
): ArtifactHold {
  assertValidDate(now, "now");
  if (!validActor(actor)) throw new Error("a valid hold actor is required");
  if (!validHoldId(input.id)) throw new Error("invalid hold id");
  if (typeof input.reason !== "string" || !input.reason.trim())
    throw new Error("hold reason must not be empty");
  if (input.days !== undefined && input.minutes !== undefined)
    throw new Error("choose either hold days or hold minutes");
  if (input.persistent && (input.days !== undefined || input.minutes !== undefined))
    throw new Error("a persistent hold takes no duration");
  const hold: ArtifactHold = {
    id: input.id,
    reason: input.reason.trim(),
    set_by: { ...actor },
    set_at: now.toISOString(),
  };
  if (input.persistent) return { ...hold, persistent: true };
  const minutes =
    input.minutes !== undefined
      ? holdMinutes(input.minutes)
      : holdDaysValue(input.days ?? defaultDays) * 24 * 60;
  return { ...hold, expires_at: addMinutes(now, minutes).toISOString() };
}

function holdDaysValue(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 365)
    throw new Error("hold days must be between 1 and 365");
  return value;
}

function holdMinutes(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 365 * 24 * 60)
    throw new Error("hold minutes must be between 1 and 525600");
  return value;
}

function ownerLiveness(
  repoRoot: string,
  instanceId: string,
  now: Date,
  freshnessSeconds: number,
): { state: "live" | "stale" | "unknown"; heartbeatMs: number | null } {
  try {
    const row = readLiveCoordinationRow(repoRoot, instanceId);
    if (!row) return { state: "stale", heartbeatMs: null };
    const ts = Date.parse(row.last_heartbeat);
    if (!Number.isFinite(ts)) return { state: "unknown", heartbeatMs: null };
    return {
      state: now.getTime() - ts <= freshnessSeconds * 1000 ? "live" : "stale",
      heartbeatMs: ts,
    };
  } catch {
    return { state: "unknown", heartbeatMs: null };
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

interface TreeUsage {
  /** Allocated disk bytes, counting each hard-linked inode once. */
  disk: number;
  /** Sum of file lengths, as `ls -l` reports them. */
  apparent: number;
}

/** Disk bytes for one entry. Windows reports no block count, so length stands in. */
function allocatedBytes(st: Stats): number {
  return process.platform !== "win32" && Number.isFinite(st.blocks) ? st.blocks * 512 : st.size;
}

/**
 * Measure a tree without following symlinks. Size rules read `disk`: a sparse
 * image or a hard-linked environment would otherwise count many times its real
 * footprint and push healthy workspaces over a budget they do not exceed.
 */
function safeTreeUsage(path: string, seen = new Set<string>()): TreeUsage | null {
  try {
    const st = lstatSync(path);
    if (!st.isDirectory()) {
      if (!st.isFile() && !st.isSymbolicLink()) return { disk: 0, apparent: 0 };
      const key = `${st.dev}:${st.ino}`;
      if (st.nlink > 1 && seen.has(key)) return { disk: 0, apparent: st.size };
      if (st.nlink > 1) seen.add(key);
      return { disk: allocatedBytes(st), apparent: st.size };
    }
    const total: TreeUsage = { disk: allocatedBytes(st), apparent: st.size };
    for (const child of readdirSync(path)) {
      const usage = safeTreeUsage(join(path, child), seen);
      if (usage === null) return null;
      total.disk += usage.disk;
      total.apparent += usage.apparent;
    }
    return total;
  } catch {
    return null;
  }
}

function safeTreeSize(path: string): number | null {
  return safeTreeUsage(path)?.disk ?? null;
}

/**
 * Return the newest filesystem change in a managed tree without following
 * symlinks. A small future tolerance protects a write racing the inventory
 * scan; timestamps farther ahead are ignored as clock-skewed metadata.
 */
function safeTreeLastModified(path: string, now: Date, activity?: ArtifactActivity): number | null {
  try {
    return Date.parse(readArtifactActivity(path, now, activity).last_changed_at);
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
  usage: TreeUsage | null = safeTreeUsage(path),
): ArtifactInventoryEntry {
  return {
    name,
    path,
    relative_path: relative(repoRoot, path),
    classification,
    reason,
    action: classification === "managed-expired" ? "would-delete" : "keep",
    bytes: usage?.disk ?? null,
    apparent_bytes: usage?.apparent ?? null,
    artifact_id: null,
    slug: null,
    created_at: null,
    last_modified_at: null,
    expires_at: null,
    owner_instance_id: null,
    oversize_acknowledged: false,
    idle_since: null,
    warning: null,
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
