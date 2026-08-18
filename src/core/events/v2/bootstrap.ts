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
import { dirname, join, resolve } from "node:path";
import { fsyncParentDirectory } from "../../workflow/durable-record.ts";
import { canonicalJsonV2, sha256V2 } from "./canonical.ts";
import { ADAPTER_CAPABILITY_PROFILES_V2 } from "./capabilities.ts";
import {
  buildActivationManifestV2,
  buildCandidateGenesisManifestV2,
  EVENT_V2_ACTIVATION_MANIFEST,
  EVENT_V2_GENESIS_MANIFEST,
  type EventV2ControlState,
  readEventV2ControlState,
  repairEventV2ControlPair,
} from "./control.ts";
import { loadOrCreateFingerprintKeyStoreV2 } from "./fingerprint-keys.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "./generated.ts";
import { liveEventV2BuildId, livePlatformV2 } from "./live-routing.ts";

export interface InitializeEventLedgerV2Input {
  coordRoot: string;
  harneryBuild: string;
  hostBuild: string;
  configDigest: `sha256:${string}`;
  approvalRecordId: string;
  forceNewEpoch?: boolean;
  now?: () => Date;
}

export interface InitializeEventLedgerV2Result {
  state: "active";
  initialized: boolean;
  archived_epoch?: string;
  control: Extract<EventV2ControlState, { state: "active" }>;
}

/**
 * Ensure programmatic Harnery entry points have the same universal V2
 * boundary as `harn init`. Only a genuinely absent control pair is created;
 * candidate, damaged, or incompatible state still fails closed.
 */
export function ensureEventLedgerV2(
  coordRoot: string,
  approvalRecordId = "harnery-runtime-v2-universal",
): Extract<EventV2ControlState, { state: "active" }> {
  const root = resolve(coordRoot);
  const current = readEventV2ControlState(root);
  if (current.state === "active") return current;
  if (current.state !== "closed") {
    throw new Error(`event_v2_control_unavailable:${current.state}`);
  }
  const configPath = join(root, ".harnery", "config.jsonc");
  return initializeEventLedgerV2({
    coordRoot: root,
    harneryBuild: repositoryBuild(rootOfHarnery()),
    hostBuild: repositoryBuild(root),
    configDigest: sha256V2(existsSync(configPath) ? readFileSync(configPath) : Buffer.from("{}\n")),
    approvalRecordId,
  }).control;
}

/**
 * Ensure a root has one current V2 epoch. An incompatible or explicitly
 * replaced epoch is moved intact to the V2 archive before the new control
 * pair is published. No historical ledger bytes are rewritten or deleted.
 */
export function initializeEventLedgerV2(
  input: InitializeEventLedgerV2Input,
): InitializeEventLedgerV2Result {
  const root = resolve(input.coordRoot);
  const current = readEventV2ControlState(root);
  if (!input.forceNewEpoch && current.state === "active") {
    return { state: "active", initialized: false, control: current };
  }
  if (!input.forceNewEpoch && current.state === "candidate") {
    throw new Error("event_v2_candidate_requires_explicit_activation_or_epoch_replacement");
  }

  const now = input.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const archivedEpoch = archiveCurrentEpoch(root, createdAt);
  const keys = loadOrCreateFingerprintKeyStoreV2(root, now);
  const harneryBuild = safeBuild(input.harneryBuild);
  const hostBuild = safeBuild(input.hostBuild);
  const producerId = "prd_harnery-init" as const;
  const bootId =
    `boot_${createHash("sha256").update(`${root}\0${createdAt}`).digest("hex")}` as const;
  const buildId = liveEventV2BuildId(harneryBuild);
  const rootId = `root_${createHash("sha256").update(root).digest("hex")}` as const;
  const instanceId =
    `inst_init_${createHash("sha256").update(`${root}\0${createdAt}`).digest("hex")}` as const;
  const capabilityDigests = Object.values(ADAPTER_CAPABILITY_PROFILES_V2)
    .map((profile) => sha256V2(canonicalJsonV2(profile)))
    .sort();
  const candidate = buildCandidateGenesisManifestV2({
    profile: {
      initial_schema_digest: EVENT_V2_SCHEMA_DIGEST,
      contract_source_digest: EVENT_V2_SCHEMA_DIGEST,
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
      platform: livePlatformV2(),
    },
  });
  publishControlFile(join(root, EVENT_V2_GENESIS_MANIFEST), candidate);
  const candidateState = repairEventV2ControlPair(root);
  if (candidateState.state !== "candidate") {
    throw new Error(`event_v2_candidate_initialization_failed:${candidateState.state}`);
  }
  const activation = buildActivationManifestV2({
    candidate,
    approval_record_id: input.approvalRecordId,
    activation_approved_at: createdAt,
    producer: {
      producer_id: producerId,
      boot_id: bootId,
      sequence: 2,
      build_id: buildId,
      platform: livePlatformV2(),
    },
  });
  publishControlFile(join(root, EVENT_V2_ACTIVATION_MANIFEST), activation);
  const active = repairEventV2ControlPair(root);
  if (active.state !== "active") {
    throw new Error(`event_v2_activation_failed:${active.state}`);
  }
  return {
    state: "active",
    initialized: true,
    ...(archivedEpoch ? { archived_epoch: archivedEpoch } : {}),
    control: active,
  };
}

function archiveCurrentEpoch(root: string, createdAt: string): string | undefined {
  const current = join(root, ".harnery", "ledgers", "v2");
  if (!existsSync(current)) return undefined;
  const archives = join(root, ".harnery", "ledgers", "v2-archives");
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
    writeFileSync(fd, `${canonicalJsonV2(value)}\n`, "utf8");
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
