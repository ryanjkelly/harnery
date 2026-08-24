import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fsyncParentDirectory } from "../../workflow/durable-record.ts";
import { acquireNoClobberLease } from "../../workflow/workspaces/leases.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import { ADAPTER_CAPABILITY_PROFILES_V3 } from "./capabilities.ts";
import {
  buildActivationManifestV3,
  buildCandidateGenesisManifestV3,
  type CandidateGenesisManifestV3,
  EVENT_V3_ACTIVATION_MANIFEST,
  EVENT_V3_GENESIS_MANIFEST,
  type EventV3ControlState,
  readEventV3ControlState,
} from "./control.ts";
import { repairEventV3ControlPair } from "./control-writer.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "./fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { currentHarneryRuntimeBuild, liveEventV3BuildId, livePlatformV3 } from "./runtime-build.ts";

export interface InitializeEventLedgerV3Input {
  coordRoot: string;
  harneryBuild: string;
  hostBuild: string;
  configDigest: `sha256:${string}`;
  approvalRecordId: string;
  forceNewEpoch?: boolean;
  resumeCandidate?: boolean;
  now?: () => Date;
}

export interface InitializeEventLedgerV3Result {
  state: "active";
  initialized: boolean;
  archived_epoch?: string;
  control: Extract<EventV3ControlState, { state: "active" }>;
}

export interface RefreshIncompatibleEventLedgerV3Result {
  state: "current" | "refreshed";
  archived_epoch?: string;
  control: Extract<EventV3ControlState, { state: "active" }>;
}

const BOOTSTRAP_LEASE_RETRIES = 12;
const BOOTSTRAP_LEASE_RETRY_MS = 25;
const BOOTSTRAP_LEASE_STALE_MS = 10_000;
const bootstrapSleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * Ensure programmatic Harnery entry points have the same universal V3
 * boundary as `harn init`. Only a genuinely absent control pair is created;
 * candidate, damaged, or incompatible state still fails closed.
 */
export function ensureEventLedgerV3(
  coordRoot: string,
  approvalRecordId = "harnery-runtime-v3-universal",
): Extract<EventV3ControlState, { state: "active" }> {
  const root = resolve(coordRoot);
  const current = readEventV3ControlState(root);
  if (current.state === "active") return current;
  if (current.state !== "closed") {
    throw new Error(`event_v3_control_unavailable:${current.state}`);
  }
  const configPath = join(root, ".harnery", "config.jsonc");
  return initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: repositoryBuild(rootOfHarnery()),
    hostBuild: repositoryBuild(root),
    configDigest: sha256V3(existsSync(configPath) ? readFileSync(configPath) : Buffer.from("{}\n")),
    approvalRecordId,
  }).control;
}

/**
 * Ensure a root has one current V3 epoch. An incompatible or explicitly
 * replaced epoch is moved intact to the V3 archive before the new control
 * pair is published. No historical ledger bytes are rewritten or deleted.
 */
export function initializeEventLedgerV3(
  input: InitializeEventLedgerV3Input,
): InitializeEventLedgerV3Result {
  return withBootstrapLease(input.coordRoot, () => initializeEventLedgerV3Locked(input));
}

/**
 * Replace only a runtime-incompatible epoch that the current code can name
 * exactly. Corruption and ambiguous control failures remain closed for the
 * explicit recovery command.
 */
export function refreshIncompatibleEventLedgerV3(
  coordRoot: string,
): RefreshIncompatibleEventLedgerV3Result {
  const root = resolve(coordRoot);
  return withBootstrapLease(root, () => {
    const current = readEventV3ControlState(root);
    if (current.state === "active" && runtimeCapabilityProfileCurrent(current)) {
      return { state: "current", control: current };
    }
    const refreshable =
      (current.state === "invalid" && current.reason === "genesis_schema_digest_incompatible") ||
      ((current.state === "candidate" || current.state === "active") &&
        !runtimeCapabilityProfileCurrent(current));
    if (!refreshable) {
      const reason = "reason" in current ? `${current.state}:${current.reason}` : current.state;
      throw new Error(`event_v3_runtime_refresh_refused:${reason}`);
    }
    const configPath = join(root, ".harnery", "config.jsonc");
    const initialized = initializeEventLedgerV3Locked({
      coordRoot: root,
      harneryBuild: currentHarneryRuntimeBuild(),
      hostBuild: repositoryBuild(root),
      configDigest: sha256V3(
        existsSync(configPath) ? readFileSync(configPath) : Buffer.from("{}\n"),
      ),
      approvalRecordId: "harnery-runtime-v3-auto-refresh",
      forceNewEpoch: true,
    });
    return {
      state: "refreshed",
      ...(initialized.archived_epoch ? { archived_epoch: initialized.archived_epoch } : {}),
      control: initialized.control,
    };
  });
}

function initializeEventLedgerV3Locked(
  input: InitializeEventLedgerV3Input,
): InitializeEventLedgerV3Result {
  const root = resolve(input.coordRoot);
  let current = readEventV3ControlState(root);
  if (input.resumeCandidate && current.state === "repairable") {
    current = repairEventV3ControlPair(root);
  }
  if (!input.forceNewEpoch && current.state === "active") {
    return { state: "active", initialized: false, control: current };
  }
  if (!input.forceNewEpoch && input.resumeCandidate && current.state === "candidate") {
    return activateCandidateEpoch(root, current.genesis, input.approvalRecordId);
  }
  if (!input.forceNewEpoch && current.state === "candidate") {
    throw new Error("event_v3_candidate_requires_explicit_activation_or_epoch_replacement");
  }

  const now = input.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const archivedEpoch = archiveCurrentEpoch(root, createdAt);
  const keys = loadOrCreateFingerprintKeyStoreV3(root, now);
  const harneryBuild = safeBuild(input.harneryBuild);
  const hostBuild = safeBuild(input.hostBuild);
  const producerId = "prd_harnery-init" as const;
  const bootId =
    `boot_${createHash("sha256").update(`${root}\0${createdAt}`).digest("hex")}` as const;
  const buildId = liveEventV3BuildId(harneryBuild);
  const rootId = `root_${createHash("sha256").update(root).digest("hex")}` as const;
  const instanceId =
    `inst_init_${createHash("sha256").update(`${root}\0${createdAt}`).digest("hex")}` as const;
  const capabilityDigests = Object.values(ADAPTER_CAPABILITY_PROFILES_V3)
    .map((profile) => sha256V3(canonicalJsonV3(profile)))
    .sort();
  const candidate = buildCandidateGenesisManifestV3({
    profile: {
      initial_schema_digest: EVENT_V3_SCHEMA_DIGEST,
      contract_source_digest: EVENT_V3_SCHEMA_DIGEST,
      harnery_commit: harneryBuild,
      host_repository_commit: hostBuild,
      producer_build_ids: [buildId],
      adapter_capability_profile_digests: capabilityDigests,
      config_digest: input.configDigest,
      canonicalizer_version: "harnery-jcs-nfc-v1",
      fingerprint_version: "hmac-sha256-v1",
      privacy_key_epoch: keys.active_epoch_id,
      candidate_created_at: createdAt,
    },
    root_id: rootId,
    instance_id: instanceId,
    producer: {
      producer_id: producerId,
      boot_id: bootId,
      sequence: 1,
      build_id: buildId,
      platform: livePlatformV3(),
    },
  });
  publishControlFile(join(root, EVENT_V3_GENESIS_MANIFEST), candidate);
  const candidateState = repairEventV3ControlPair(root);
  if (candidateState.state !== "candidate") {
    throw new Error(`event_v3_candidate_initialization_failed:${candidateState.state}`);
  }
  const activated = activateCandidateEpoch(root, candidate, input.approvalRecordId);
  return {
    ...activated,
    ...(archivedEpoch ? { archived_epoch: archivedEpoch } : {}),
  };
}

function runtimeCapabilityProfileCurrent(
  control: Extract<EventV3ControlState, { state: "candidate" | "active" }>,
): boolean {
  const expected = Object.values(ADAPTER_CAPABILITY_PROFILES_V3).map((profile) =>
    sha256V3(canonicalJsonV3(profile)),
  );
  const approved = control.genesis.profile.adapter_capability_profile_digests;
  const expectedDigests = new Set<string>(expected);
  return control.state === "candidate"
    ? approved.some((digest) => expectedDigests.has(digest))
    : expected.every((digest) => approved.includes(digest));
}

function withBootstrapLease<T>(coordRoot: string, operation: () => T): T {
  const root = resolve(coordRoot);
  const authority = createHash("sha256").update(root).digest("hex");
  let lease: ReturnType<typeof acquireNoClobberLease> | undefined;
  for (let attempt = 0; attempt < BOOTSTRAP_LEASE_RETRIES; attempt += 1) {
    try {
      lease = acquireNoClobberLease({
        path: join(root, ".harnery", "private", "event-v3-bootstrap-lease"),
        scope: "event-v3-bootstrap",
        authoritySha256: authority,
        staleAfterMs: BOOTSTRAP_LEASE_STALE_MS,
        validateStaleOwner: (owner) => owner.host === hostname() && !pidIsAlive(owner.pid),
      });
      break;
    } catch (error) {
      if (attempt === BOOTSTRAP_LEASE_RETRIES - 1) throw error;
      Atomics.wait(bootstrapSleepCell, 0, 0, BOOTSTRAP_LEASE_RETRY_MS);
    }
  }
  if (!lease) throw new Error("event_v3_bootstrap_lease_busy");
  try {
    return operation();
  } finally {
    lease.release();
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function activateCandidateEpoch(
  root: string,
  candidate: CandidateGenesisManifestV3,
  approvalRecordId: string,
): InitializeEventLedgerV3Result {
  const producer = candidate.event.producer;
  const activation = buildActivationManifestV3({
    candidate,
    approval_record_id: approvalRecordId,
    activation_approved_at: candidate.profile.candidate_created_at,
    producer: {
      producer_id: producer.producer_id as `prd_${string}`,
      boot_id: producer.boot_id as `boot_${string}`,
      sequence: producer.sequence + 1,
      build_id: producer.build_id as `build_${string}`,
      platform: producer.platform,
      ...(producer.bridge ? { bridge: producer.bridge } : {}),
    },
  });
  publishControlFile(join(root, EVENT_V3_ACTIVATION_MANIFEST), activation);
  const active = repairEventV3ControlPair(root);
  if (active.state !== "active") {
    throw new Error(`event_v3_activation_failed:${active.state}`);
  }
  return { state: "active", initialized: true, control: active };
}

function archiveCurrentEpoch(root: string, createdAt: string): string | undefined {
  const current = join(root, ".harnery", "ledgers", "v3");
  if (!existsSync(current)) return undefined;
  const archives = join(root, ".harnery", "ledgers", "v3-archives");
  mkdirSync(archives, { recursive: true, mode: 0o700 });
  const stamp = createdAt.replace(/[^0-9]/g, "");
  let target = join(archives, `epoch-${stamp}`);
  let suffix = 0;
  while (existsSync(target)) target = join(archives, `epoch-${stamp}-${++suffix}`);
  renameSync(current, target);
  fsyncParentDirectory(target);
  return target;
}

function publishControlFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp.${process.pid}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, `${canonicalJsonV3(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  fsyncParentDirectory(path);
}

function safeBuild(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (/^[a-zA-Z0-9._-]{1,120}$/.test(normalized)) return normalized;
  return createHash("sha256")
    .update(normalized || "unknown")
    .digest("hex");
}

function rootOfHarnery(): string {
  return resolve(import.meta.dir, "../../../..");
}

function repositoryBuild(root: string): string {
  const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const commit = result.status === 0 ? result.stdout.trim() : "";
  if (/^[0-9a-f]{40,64}$/.test(commit)) return commit;
  return createHash("sha256").update(resolve(root)).digest("hex");
}
