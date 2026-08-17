import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fsyncParentDirectory } from "../../workflow/durable-record.ts";
import { canonicalJsonV2, sha256V2 } from "./canonical.ts";
import { recoverEventV2Catalog } from "./catalog.ts";
import {
  type ActivationManifestV2,
  buildActivationManifestV2,
  buildCandidateGenesisManifestV2,
  type CandidateGenesisManifestV2,
  type CandidateProfileV2,
  type ControlProducerV2,
  candidateManifestDigestV2,
  readEventV2ControlState,
  repairEventV2ControlPair,
  validateActivationManifestV2,
  validateCandidateGenesisManifestV2,
} from "./control.ts";
import {
  type CutoverV2Step,
  createProjectionSnapshotV2,
  type ProjectionSnapshotEntryV2,
  projectionSnapshotDigestV2,
  rollbackV1LedgerV2,
  sealV1LedgerV2,
  type V1ProjectionSnapshotManifestV2,
  type V1RollbackRecordV2,
  type V1SealManifestV2,
  v1SealManifestDigestV2,
} from "./cutover.ts";
import { eventIdV2, genesisIdV2 } from "./ids.ts";
import { drainReadyEventsV2, EVENT_V2_LEDGER_RELATIVE_ROOT, eventV2Paths } from "./writer.ts";

const CANDIDATE_ARCHIVE_RELATIVE_ROOT = ".harnery/ledgers/v2-candidates" as const;
const V2_ARCHIVE_FENCE_KIND = "v2_archived_path_fence" as const;
const RECORD_LIMIT = 8 * 1024 * 1024;

export type CandidateProfileBaseV2 = Omit<
  CandidateProfileV2,
  "v1_terminal_digest" | "v1_terminal_bytes" | "v1_terminal_rows"
>;

export interface CandidateInstallPacketV2 {
  packet_version: 1;
  kind: "candidate_install";
  profile_base: CandidateProfileBaseV2;
  root_id: `root_${string}`;
  instance_id: `inst_${string}`;
  producer: ControlProducerV2;
  genesis_id: `gex_${string}`;
  event_id: `evt_${string}`;
}

export type EpochCutoverV2Step =
  | CutoverV2Step
  | "candidate_install_intent_committed"
  | "candidate_packet_finalized"
  | "projection_clear_intent_committed"
  | "projection_root_cleared"
  | "projection_clear_complete_committed"
  | "previous_v2_fence_released"
  | "genesis_manifest_installed"
  | "genesis_event_repaired"
  | "catalog_initialized"
  | "candidate_gate_open"
  | "activation_install_intent_committed"
  | "activation_manifest_installed"
  | "activation_event_repaired"
  | "activation_gate_open"
  | "v2_archive_manifest_committed"
  | "v2_rollback_intent_committed"
  | "v2_root_archived"
  | "v2_archive_fence_installed"
  | "v2_archive_verified"
  | "v2_archive_record_committed"
  | "advance_intent_committed"
  | "ready_spool_drained"
  | "intake_carried"
  | "advance_archive_manifest_committed"
  | "advance_root_archived"
  | "advance_terminal_facts_committed"
  | "advance_candidate_finalized"
  | "intake_restored"
  | "advance_complete_committed";

export interface InstallCandidateV2Input {
  coordRoot: string;
  artifactRoot: string;
  packet: CandidateInstallPacketV2;
  projectionPaths: readonly string[];
  now?: () => number;
  onStep?: (step: EpochCutoverV2Step, relativePath?: string) => void;
}

export interface InstallCandidateV2Result {
  state: "candidate";
  candidate: CandidateGenesisManifestV2;
  candidate_manifest_digest: `sha256:${string}`;
  snapshot: V1ProjectionSnapshotManifestV2;
  seal: V1SealManifestV2;
}

export interface InstallActivationV2Input {
  coordRoot: string;
  artifactRoot: string;
  activation: ActivationManifestV2;
  onStep?: (step: EpochCutoverV2Step, relativePath?: string) => void;
}

export interface InstallActivationV2Result {
  state: "active";
  candidate_manifest_digest: `sha256:${string}`;
  activation: ActivationManifestV2;
}

export interface V2ArchiveEntryV2 {
  relative_path: string;
  kind: "directory" | "file";
  mode: number;
  bytes?: number;
  digest?: `sha256:${string}`;
}

export interface V2EpochArchiveManifestV2 {
  manifest_version: 1;
  kind: "v2_epoch_archive";
  created_at: string;
  genesis_id: `gex_${string}`;
  candidate_manifest_digest: `sha256:${string}`;
  control_state: "candidate" | "active" | "repairable" | "invalid";
  entries: V2ArchiveEntryV2[];
  tree_digest: `sha256:${string}`;
  archive_relative_path: string;
}

export interface ArchiveEpochAndRollbackV2Input {
  coordRoot: string;
  artifactRoot: string;
  candidate: CandidateGenesisManifestV2;
  snapshot: V1ProjectionSnapshotManifestV2;
  seal: V1SealManifestV2;
  now?: () => number;
  onStep?: (step: EpochCutoverV2Step, relativePath?: string) => void;
}

export interface ArchiveEpochAndRollbackV2Result {
  state: "v1_restored";
  genesis_id: `gex_${string}`;
  archive_relative_path: string;
  tree_digest: `sha256:${string}`;
  rollback: V1RollbackRecordV2;
}

interface CandidateInstallIntentV2 {
  manifest_version: 1;
  kind: "candidate_install_intent";
  packet_digest: `sha256:${string}`;
  projection_paths: string[];
}

interface ActivationInstallIntentV2 {
  manifest_version: 1;
  kind: "activation_install_intent";
  activation_digest: `sha256:${string}`;
  candidate_manifest_digest: `sha256:${string}`;
  approval_record_id: string;
}

interface V2EpochRollbackIntentV2 {
  manifest_version: 1;
  kind: "v2_epoch_rollback_intent";
  genesis_id: `gex_${string}`;
  candidate_manifest_digest: `sha256:${string}`;
  snapshot_digest: `sha256:${string}`;
  v1_seal_digest: `sha256:${string}`;
  v2_tree_digest: `sha256:${string}`;
  source_relative_path: typeof EVENT_V2_LEDGER_RELATIVE_ROOT;
  archive_relative_path: string;
}

interface ProjectionClearIntentV2 {
  manifest_version: 1;
  kind: "v1_projection_clear_intent";
  snapshot_digest: `sha256:${string}`;
  roots: string[];
}

interface ProjectionClearCompleteV2 {
  manifest_version: 1;
  kind: "v1_projection_clear_complete";
  snapshot_digest: `sha256:${string}`;
  roots: string[];
}

export function buildCandidateInstallPacketV2(input: {
  profile_base: CandidateProfileBaseV2;
  root_id: `root_${string}`;
  instance_id: `inst_${string}`;
  producer: ControlProducerV2;
  genesis_id?: `gex_${string}`;
  event_id?: `evt_${string}`;
}): CandidateInstallPacketV2 {
  return validateCandidateInstallPacketV2({
    packet_version: 1,
    kind: "candidate_install",
    profile_base: input.profile_base,
    root_id: input.root_id,
    instance_id: input.instance_id,
    producer: input.producer,
    genesis_id: input.genesis_id ?? genesisIdV2(),
    event_id: input.event_id ?? eventIdV2(),
  });
}

export function validateCandidateInstallPacketV2(value: unknown): CandidateInstallPacketV2 {
  if (!isObject(value) || !exactKeys(value, packetKeys())) {
    throw new Error("candidate_install_packet_shape_invalid");
  }
  if (value.packet_version !== 1 || value.kind !== "candidate_install") {
    throw new Error("candidate_install_packet_version_invalid");
  }
  if (!isObject(value.profile_base) || !exactKeys(value.profile_base, profileBaseKeys())) {
    throw new Error("candidate_install_profile_base_shape_invalid");
  }
  const packet = value as unknown as CandidateInstallPacketV2;
  const probe = buildCandidateGenesisManifestV2({
    profile: {
      ...packet.profile_base,
      v1_terminal_digest: sha256V2("candidate-install-validation"),
      v1_terminal_bytes: 0,
      v1_terminal_rows: 0,
    },
    root_id: packet.root_id,
    instance_id: packet.instance_id,
    producer: packet.producer,
    genesis_id: packet.genesis_id,
    event_id: packet.event_id,
  });
  const {
    v1_terminal_digest: _terminalDigest,
    v1_terminal_bytes: _terminalBytes,
    v1_terminal_rows: _terminalRows,
    ...profileBase
  } = probe.profile;
  return {
    packet_version: 1,
    kind: "candidate_install",
    profile_base: profileBase,
    root_id: packet.root_id,
    instance_id: packet.instance_id,
    producer: packet.producer,
    genesis_id: packet.genesis_id,
    event_id: packet.event_id,
  };
}

/** Snapshot and seal V1, then install and repair one exact candidate packet. */
export function installCandidateV2(input: InstallCandidateV2Input): InstallCandidateV2Result {
  const coordRoot = resolve(input.coordRoot);
  const artifactRoot = assertArtifactRoot(coordRoot, input.artifactRoot);
  const packet = validateCandidateInstallPacketV2(input.packet);
  const projectionPaths = [...new Set(input.projectionPaths)].sort();
  assertDisposableProjectionPaths(projectionPaths);
  const intent: CandidateInstallIntentV2 = {
    manifest_version: 1,
    kind: "candidate_install_intent",
    packet_digest: sha256V2(canonicalJsonV2(packet)),
    projection_paths: projectionPaths,
  };
  writeImmutableCanonicalJson(join(artifactRoot, "candidate-install-intent.json"), intent);
  input.onStep?.("candidate_install_intent_committed");

  const snapshot = createProjectionSnapshotV2({
    coordRoot,
    artifactRoot,
    projectionPaths,
    now: input.now,
    onStep: input.onStep,
  });
  const seal = sealV1LedgerV2({
    coordRoot,
    artifactRoot,
    snapshot,
    now: input.now,
    onStep: input.onStep,
  });
  const candidatePath = join(artifactRoot, "candidate.json");
  const existingCandidate = readOptionalCanonicalJson<CandidateGenesisManifestV2>(candidatePath);
  const candidate = existingCandidate
    ? validatedFinalCandidate(existingCandidate, packet, seal)
    : buildCandidateGenesisManifestV2({
        profile: {
          ...packet.profile_base,
          v1_terminal_digest: seal.terminal_digest,
          v1_terminal_bytes: seal.terminal_bytes,
          v1_terminal_rows: seal.terminal_rows,
        },
        root_id: packet.root_id,
        instance_id: packet.instance_id,
        producer: packet.producer,
        genesis_id: packet.genesis_id,
        event_id: packet.event_id,
      });
  if (!existingCandidate) {
    writeImmutableCanonicalJson(candidatePath, candidate);
    input.onStep?.("candidate_packet_finalized");
  }

  const stateBefore = readEventV2ControlState(coordRoot);
  if (stateBefore.state === "active") throw new Error("candidate_already_activated");
  if (
    stateBefore.state === "candidate" &&
    canonicalJsonV2(stateBefore.genesis) !== canonicalJsonV2(candidate)
  ) {
    throw new Error("installed_candidate_conflict");
  }
  if (stateBefore.state === "invalid")
    throw new Error(`candidate_gate_invalid:${stateBefore.reason}`);
  clearDisposableProjectionPaths(
    coordRoot,
    artifactRoot,
    snapshot,
    stateBefore.state === "candidate",
    input.onStep,
  );
  releaseVerifiedV2ArchiveFence(coordRoot);
  input.onStep?.("previous_v2_fence_released", EVENT_V2_LEDGER_RELATIVE_ROOT);
  const genesisPath = join(coordRoot, EVENT_V2_LEDGER_RELATIVE_ROOT, "genesis.json");
  writeImmutableCanonicalJson(genesisPath, candidate);
  input.onStep?.("genesis_manifest_installed", EVENT_V2_LEDGER_RELATIVE_ROOT);
  const repaired = repairEventV2ControlPair(coordRoot);
  input.onStep?.("genesis_event_repaired");
  if (repaired.state !== "candidate") {
    throw new Error(`candidate_gate_not_open:${repaired.state}`);
  }
  if (canonicalJsonV2(repaired.genesis) !== canonicalJsonV2(candidate)) {
    throw new Error("candidate_gate_manifest_mismatch");
  }
  recoverEventV2Catalog(coordRoot);
  input.onStep?.("catalog_initialized");
  input.onStep?.("candidate_gate_open");
  return {
    state: "candidate",
    candidate,
    candidate_manifest_digest: candidateManifestDigestV2(candidate),
    snapshot,
    seal,
  };
}

/** Install an already approval-bound activation packet and repair its exact event. */
export function installActivationV2(input: InstallActivationV2Input): InstallActivationV2Result {
  const coordRoot = resolve(input.coordRoot);
  const artifactRoot = assertArtifactRoot(coordRoot, input.artifactRoot);
  let state = readEventV2ControlState(coordRoot);
  if (state.state === "repairable" && state.reason === "genesis_event_missing") {
    state = repairEventV2ControlPair(coordRoot);
  }
  if (state.state !== "candidate" && state.state !== "active" && state.state !== "repairable") {
    throw new Error(`activation_requires_candidate:${state.state}`);
  }
  const validated = validateActivationManifestV2(input.activation, state.genesis);
  if (!validated.ok) throw new Error(`activation_invalid:${validated.reason}`);
  const activation = validated.value;
  const installedActivation =
    state.state === "active"
      ? state.activation
      : state.state === "repairable" && state.reason === "activation_event_missing"
        ? state.activation
        : undefined;
  if (state.state === "repairable" && !installedActivation) {
    throw new Error("repairable_activation_packet_missing");
  }
  if (installedActivation && canonicalJsonV2(installedActivation) !== canonicalJsonV2(activation)) {
    throw new Error("installed_activation_conflict");
  }
  const intent: ActivationInstallIntentV2 = {
    manifest_version: 1,
    kind: "activation_install_intent",
    activation_digest: sha256V2(canonicalJsonV2(activation)),
    candidate_manifest_digest: candidateManifestDigestV2(state.genesis),
    approval_record_id: activation.approval_record_id,
  };
  writeImmutableCanonicalJson(join(artifactRoot, "activation-install-intent.json"), intent);
  input.onStep?.("activation_install_intent_committed");
  writeImmutableCanonicalJson(join(artifactRoot, "approved-activation.json"), activation);
  if (state.state !== "repairable") {
    writeImmutableCanonicalJson(
      join(coordRoot, EVENT_V2_LEDGER_RELATIVE_ROOT, "activation.json"),
      activation,
    );
    input.onStep?.("activation_manifest_installed", EVENT_V2_LEDGER_RELATIVE_ROOT);
  }
  const repaired = repairEventV2ControlPair(coordRoot);
  input.onStep?.("activation_event_repaired");
  if (repaired.state !== "active") throw new Error(`activation_gate_not_open:${repaired.state}`);
  if (canonicalJsonV2(repaired.activation) !== canonicalJsonV2(activation)) {
    throw new Error("activation_gate_manifest_mismatch");
  }
  input.onStep?.("activation_gate_open");
  return {
    state: "active",
    candidate_manifest_digest: repaired.candidate_manifest_digest,
    activation,
  };
}

function validatedFinalCandidate(
  value: CandidateGenesisManifestV2,
  packet: CandidateInstallPacketV2,
  seal: V1SealManifestV2,
): CandidateGenesisManifestV2 {
  const validated = validateCandidateGenesisManifestV2(value);
  if (!validated.ok) throw new Error(`final_candidate_invalid:${validated.reason}`);
  const candidate = validated.value;
  const expectedProfile = {
    ...packet.profile_base,
    v1_terminal_digest: seal.terminal_digest,
    v1_terminal_bytes: seal.terminal_bytes,
    v1_terminal_rows: seal.terminal_rows,
  };
  if (
    canonicalJsonV2(candidate.profile) !== canonicalJsonV2(expectedProfile) ||
    candidate.event.event_id !== packet.event_id ||
    candidate.event.payload.genesis_id !== packet.genesis_id ||
    candidate.event.scope.root_id !== packet.root_id ||
    candidate.event.scope.instance_id !== packet.instance_id ||
    canonicalJsonV2(candidate.event.producer) !==
      canonicalJsonV2({ ...packet.producer, component: "recovery" })
  ) {
    throw new Error("final_candidate_install_binding_mismatch");
  }
  return candidate;
}

/** Archive every V2 byte under its genesis ID, fence stale writers, and restore V1. */
export function archiveEpochAndRollbackV2(
  input: ArchiveEpochAndRollbackV2Input,
): ArchiveEpochAndRollbackV2Result {
  const coordRoot = resolve(input.coordRoot);
  const artifactRoot = assertArtifactRoot(coordRoot, input.artifactRoot);
  const candidateValidation = validateCandidateGenesisManifestV2(input.candidate);
  if (!candidateValidation.ok) throw new Error(`candidate_invalid:${candidateValidation.reason}`);
  const candidate = candidateValidation.value;
  const candidateDigest = candidateManifestDigestV2(candidate);
  const genesisId = candidate.event.payload.genesis_id as `gex_${string}`;
  const source = join(coordRoot, EVENT_V2_LEDGER_RELATIVE_ROOT);
  const archiveRelativePath = `${CANDIDATE_ARCHIVE_RELATIVE_ROOT}/${genesisId}`;
  const archive = join(coordRoot, archiveRelativePath);

  const archiveManifestPath = join(artifactRoot, "v2-epoch-manifest.json");
  let archiveManifest = readOptionalCanonicalJson<V2EpochArchiveManifestV2>(archiveManifestPath);
  if (!archiveManifest) {
    const control = readEventV2ControlState(coordRoot);
    if (control.state === "closed") {
      throw new Error(`v2_archive_requires_open_epoch:${control.state}`);
    }
    const installedGenesis =
      control.state === "invalid" ? readInstalledCandidateForRollback(coordRoot) : control.genesis;
    if (canonicalJsonV2(installedGenesis) !== canonicalJsonV2(candidate)) {
      throw new Error("v2_archive_candidate_mismatch");
    }
    const entries = collectTree(source);
    archiveManifest = {
      manifest_version: 1,
      kind: "v2_epoch_archive",
      created_at: new Date((input.now ?? Date.now)()).toISOString(),
      genesis_id: genesisId,
      candidate_manifest_digest: candidateDigest,
      control_state: control.state,
      entries,
      tree_digest: sha256V2(canonicalJsonV2(entries)),
      archive_relative_path: archiveRelativePath,
    };
    writeImmutableCanonicalJson(archiveManifestPath, archiveManifest);
    input.onStep?.("v2_archive_manifest_committed");
  }
  validateArchiveManifest(archiveManifest, candidate, archiveRelativePath);
  const intent: V2EpochRollbackIntentV2 = {
    manifest_version: 1,
    kind: "v2_epoch_rollback_intent",
    genesis_id: genesisId,
    candidate_manifest_digest: candidateDigest,
    snapshot_digest: projectionSnapshotDigestV2(input.snapshot),
    v1_seal_digest: v1SealManifestDigestV2(input.seal),
    v2_tree_digest: archiveManifest.tree_digest,
    source_relative_path: EVENT_V2_LEDGER_RELATIVE_ROOT,
    archive_relative_path: archiveRelativePath,
  };
  writeImmutableCanonicalJson(join(artifactRoot, "v2-rollback-intent.json"), intent);
  input.onStep?.("v2_rollback_intent_committed");

  if (existsSync(source) && lstatSync(source).isDirectory()) {
    if (existsSync(archive)) throw new Error("v2_archive_destination_collision");
    assertTreeMatches(source, archiveManifest);
    mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
    renameSync(source, archive);
    fsyncParentDirectory(source);
    fsyncParentDirectory(archive);
    input.onStep?.("v2_root_archived", archiveRelativePath);
  }
  installV2ArchiveFence(source, archiveManifest);
  input.onStep?.("v2_archive_fence_installed", EVENT_V2_LEDGER_RELATIVE_ROOT);
  assertTreeMatches(archive, archiveManifest);
  input.onStep?.("v2_archive_verified", archiveRelativePath);
  writeImmutableCanonicalJson(join(artifactRoot, "v2-archive-complete.json"), {
    manifest_version: 1,
    kind: "v2_archive_complete",
    genesis_id: genesisId,
    archive_relative_path: archiveRelativePath,
    tree_digest: archiveManifest.tree_digest,
  });
  input.onStep?.("v2_archive_record_committed", archiveRelativePath);

  const rollback = rollbackV1LedgerV2({
    coordRoot,
    artifactRoot,
    snapshot: input.snapshot,
    seal: input.seal,
    now: input.now,
    onStep: input.onStep,
  });
  assertTreeMatches(archive, archiveManifest);
  return {
    state: "v1_restored",
    genesis_id: genesisId,
    archive_relative_path: archiveRelativePath,
    tree_digest: archiveManifest.tree_digest,
    rollback,
  };
}

export interface AdvanceEpochV2Input {
  coordRoot: string;
  artifactRoot: string;
  packet: CandidateInstallPacketV2;
  approvalRecordId: string;
  approvedAt?: string;
  now?: () => number;
  onStep?: (step: EpochCutoverV2Step, relativePath?: string) => void;
}

export interface AdvanceEpochV2Result {
  state: "active";
  prior_genesis_id: `gex_${string}`;
  genesis_id: `gex_${string}`;
  candidate_manifest_digest: `sha256:${string}`;
  activation_id: `act_${string}`;
  archive_relative_path: string;
  tree_digest: `sha256:${string}`;
  drained_ready_rows: number;
  carried_intake_rows: number;
  archived_intake_rows: number;
}

interface EpochAdvanceIntentV2 {
  manifest_version: 1;
  kind: "v2_epoch_advance_intent";
  prior_genesis_id: `gex_${string}`;
  packet_digest: `sha256:${string}`;
  approval_record_id: string;
}

interface EpochAdvanceArchiveManifestV2 {
  manifest_version: 1;
  kind: "v2_epoch_advance_archive";
  created_at: string;
  prior_genesis_id: `gex_${string}`;
  entries: V2ArchiveEntryV2[];
  tree_digest: `sha256:${string}`;
  archive_relative_path: string;
}

interface EpochAdvanceTerminalFactsV2 {
  manifest_version: 1;
  kind: "v2_epoch_advance_terminal";
  prior_genesis_id: `gex_${string}`;
  terminal_digest: `sha256:${string}`;
  terminal_bytes: number;
  terminal_rows: number;
}

interface EpochAdvanceCompleteV2 {
  manifest_version: 1;
  kind: "v2_epoch_advance_complete";
  prior_genesis_id: `gex_${string}`;
  genesis_id: `gex_${string}`;
  candidate_manifest_digest: `sha256:${string}`;
  activation_id: `act_${string}`;
  archive_relative_path: string;
  tree_digest: `sha256:${string}`;
}

/**
 * Advance the live V2 ledger to a fresh epoch under a new schema digest
 * (ADR 0078): quiesce the ready spool, carry undrained intake rows across,
 * archive every byte of the prior epoch read-only under its genesis ID, then
 * install and activate one exact new candidate whose terminal-segment anchor
 * is the archived epoch's active ledger file. Idempotent and crash-resumable
 * through the same immutable artifact records the install flow uses.
 */
export function advanceEpochV2(input: AdvanceEpochV2Input): AdvanceEpochV2Result {
  const coordRoot = resolve(input.coordRoot);
  const artifactRoot = assertArtifactRoot(coordRoot, input.artifactRoot);
  const packet = validateCandidateInstallPacketV2(input.packet);
  const packetDigest = sha256V2(canonicalJsonV2(packet));
  const source = join(coordRoot, EVENT_V2_LEDGER_RELATIVE_ROOT);
  const carriedIntakeRoot = join(artifactRoot, "carried-intake");

  const completePath = join(artifactRoot, "advance-complete.json");
  const alreadyComplete = readOptionalCanonicalJson<EpochAdvanceCompleteV2>(completePath);
  if (alreadyComplete) {
    if (
      alreadyComplete.kind !== "v2_epoch_advance_complete" ||
      alreadyComplete.genesis_id !== packet.genesis_id
    ) {
      throw new Error("advance_complete_record_conflict");
    }
    restoreCarriedIntake(carriedIntakeRoot, coordRoot, input.onStep);
    return {
      state: "active",
      prior_genesis_id: alreadyComplete.prior_genesis_id,
      genesis_id: alreadyComplete.genesis_id,
      candidate_manifest_digest: alreadyComplete.candidate_manifest_digest,
      activation_id: alreadyComplete.activation_id,
      archive_relative_path: alreadyComplete.archive_relative_path,
      tree_digest: alreadyComplete.tree_digest,
      drained_ready_rows: 0,
      carried_intake_rows: 0,
      archived_intake_rows: 0,
    };
  }

  // Phase 1: quiesce, carry, and archive the live epoch (skipped on resume).
  let drainedReadyRows = 0;
  let carriedIntakeRows = 0;
  const archiveManifestPath = join(artifactRoot, "advance-archive-manifest.json");
  let archiveManifest =
    readOptionalCanonicalJson<EpochAdvanceArchiveManifestV2>(archiveManifestPath);
  const liveEpochPresent =
    existsSync(source) &&
    lstatSync(source).isDirectory() &&
    existsSync(join(source, "genesis.json"));
  const liveGenesisId = liveEpochPresent
    ? readPriorGenesisIdLoose(join(source, "genesis.json"))
    : undefined;
  // A live root already carrying the packet's genesis is a resumed advance
  // that crashed after its genesis install, not a fresh epoch to archive.
  const resumingInstalledEpoch =
    liveGenesisId === packet.genesis_id && archiveManifest !== undefined;
  if (liveEpochPresent && liveGenesisId && !resumingInstalledEpoch) {
    const priorGenesisId = liveGenesisId;
    if (priorGenesisId === packet.genesis_id) {
      throw new Error("advance_packet_reuses_prior_genesis_id");
    }
    const intent: EpochAdvanceIntentV2 = {
      manifest_version: 1,
      kind: "v2_epoch_advance_intent",
      prior_genesis_id: priorGenesisId,
      packet_digest: packetDigest,
      approval_record_id: input.approvalRecordId,
    };
    writeImmutableCanonicalJson(join(artifactRoot, "advance-intent.json"), intent);
    input.onStep?.("advance_intent_committed");

    drainedReadyRows = drainReadyEventsV2(coordRoot);
    const spool = eventV2Paths(coordRoot).spool;
    const undrained = readdirSync(spool).filter(
      (name) => name.endsWith(".ready") || name.endsWith(".committed"),
    );
    if (undrained.length > 0) {
      throw new Error(`advance_requires_drained_spool:${undrained.length}`);
    }
    input.onStep?.("ready_spool_drained");

    const intakeDir = join(source, "intake");
    if (existsSync(intakeDir) && !existsSync(carriedIntakeRoot)) {
      carriedIntakeRows = countFilesRecursively(intakeDir);
      if (carriedIntakeRows > 0) {
        mkdirSync(dirname(carriedIntakeRoot), { recursive: true, mode: 0o700 });
        renameSync(intakeDir, carriedIntakeRoot);
        fsyncParentDirectory(carriedIntakeRoot);
        fsyncParentDirectory(intakeDir);
        input.onStep?.("intake_carried");
      }
    }

    if (!archiveManifest) {
      const entries = collectTree(source);
      archiveManifest = {
        manifest_version: 1,
        kind: "v2_epoch_advance_archive",
        created_at: new Date((input.now ?? Date.now)()).toISOString(),
        prior_genesis_id: priorGenesisId,
        entries,
        tree_digest: sha256V2(canonicalJsonV2(entries)),
        archive_relative_path: `${CANDIDATE_ARCHIVE_RELATIVE_ROOT}/${priorGenesisId}`,
      };
      writeImmutableCanonicalJson(archiveManifestPath, archiveManifest);
      input.onStep?.("advance_archive_manifest_committed");
    }
    if (archiveManifest.prior_genesis_id !== priorGenesisId) {
      throw new Error("advance_archive_manifest_conflict");
    }
    const archive = join(coordRoot, archiveManifest.archive_relative_path);
    if (existsSync(archive)) throw new Error("advance_archive_destination_collision");
    assertTreeMatches(source, archiveManifest);
    mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
    renameSync(source, archive);
    fsyncParentDirectory(source);
    fsyncParentDirectory(archive);
    input.onStep?.("advance_root_archived", archiveManifest.archive_relative_path);
    installV2ArchiveFence(source, {
      genesis_id: archiveManifest.prior_genesis_id,
      archive_relative_path: archiveManifest.archive_relative_path,
      tree_digest: archiveManifest.tree_digest,
    });
    input.onStep?.("v2_archive_fence_installed", EVENT_V2_LEDGER_RELATIVE_ROOT);
    assertTreeMatches(archive, archiveManifest);
    input.onStep?.("v2_archive_verified", archiveManifest.archive_relative_path);
  } else if (!archiveManifest) {
    throw new Error("advance_requires_live_epoch");
  }

  const archivedIntakeRows = archiveManifest.entries.filter(
    (entry) => entry.kind === "file" && entry.relative_path.startsWith("intake/"),
  ).length;

  // Phase 2: derive terminal facts from the archived epoch and install the
  // new candidate and activation through the standard control gates.
  const archivePath = join(coordRoot, archiveManifest.archive_relative_path);
  const terminalFactsPath = join(artifactRoot, "advance-terminal-facts.json");
  let terminalFacts = readOptionalCanonicalJson<EpochAdvanceTerminalFactsV2>(terminalFactsPath);
  if (!terminalFacts) {
    const facts = inspectTerminatedNdjson(join(archivePath, "active.ndjson"));
    terminalFacts = {
      manifest_version: 1,
      kind: "v2_epoch_advance_terminal",
      prior_genesis_id: archiveManifest.prior_genesis_id,
      terminal_digest: facts.digest,
      terminal_bytes: facts.bytes,
      terminal_rows: facts.rows,
    };
    writeImmutableCanonicalJson(terminalFactsPath, terminalFacts);
    input.onStep?.("advance_terminal_facts_committed");
  }

  releaseVerifiedV2ArchiveFence(coordRoot);
  input.onStep?.("previous_v2_fence_released", EVENT_V2_LEDGER_RELATIVE_ROOT);

  const candidatePath = join(artifactRoot, "advance-candidate.json");
  const existingCandidate = readOptionalCanonicalJson<CandidateGenesisManifestV2>(candidatePath);
  const candidate =
    existingCandidate ??
    buildCandidateGenesisManifestV2({
      profile: {
        ...packet.profile_base,
        v1_terminal_digest: terminalFacts.terminal_digest,
        v1_terminal_bytes: terminalFacts.terminal_bytes,
        v1_terminal_rows: terminalFacts.terminal_rows,
      },
      root_id: packet.root_id,
      instance_id: packet.instance_id,
      producer: packet.producer,
      genesis_id: packet.genesis_id,
      event_id: packet.event_id,
    });
  if (existingCandidate) {
    const validated = validateCandidateGenesisManifestV2(existingCandidate);
    if (!validated.ok || existingCandidate.event.payload.genesis_id !== packet.genesis_id) {
      throw new Error("advance_candidate_record_conflict");
    }
  } else {
    writeImmutableCanonicalJson(candidatePath, candidate);
    input.onStep?.("advance_candidate_finalized");
  }

  const genesisPath = join(source, "genesis.json");
  writeImmutableCanonicalJson(genesisPath, candidate);
  input.onStep?.("genesis_manifest_installed", EVENT_V2_LEDGER_RELATIVE_ROOT);
  const repaired = repairEventV2ControlPair(coordRoot);
  input.onStep?.("genesis_event_repaired");
  if (repaired.state !== "candidate" && repaired.state !== "active") {
    throw new Error(`advance_candidate_gate_not_open:${repaired.state}`);
  }
  if (canonicalJsonV2(repaired.genesis) !== canonicalJsonV2(candidate)) {
    throw new Error("advance_candidate_gate_manifest_mismatch");
  }
  recoverEventV2Catalog(coordRoot);
  input.onStep?.("catalog_initialized");

  const activationPath = join(artifactRoot, "advance-activation.json");
  let activation = readOptionalCanonicalJson<ActivationManifestV2>(activationPath);
  if (!activation) {
    activation = buildActivationManifestV2({
      candidate,
      approval_record_id: input.approvalRecordId,
      activation_approved_at: input.approvedAt ?? new Date((input.now ?? Date.now)()).toISOString(),
      producer: { ...packet.producer, sequence: packet.producer.sequence + 1 },
    });
    writeImmutableCanonicalJson(activationPath, activation);
  }
  const activated = installActivationV2({
    coordRoot,
    artifactRoot,
    activation,
    onStep: input.onStep,
  });

  restoreCarriedIntake(carriedIntakeRoot, coordRoot, input.onStep);

  const complete: EpochAdvanceCompleteV2 = {
    manifest_version: 1,
    kind: "v2_epoch_advance_complete",
    prior_genesis_id: archiveManifest.prior_genesis_id,
    genesis_id: packet.genesis_id,
    candidate_manifest_digest: activated.candidate_manifest_digest,
    activation_id: activated.activation.activation_id,
    archive_relative_path: archiveManifest.archive_relative_path,
    tree_digest: archiveManifest.tree_digest,
  };
  writeImmutableCanonicalJson(completePath, complete);
  input.onStep?.("advance_complete_committed");

  return {
    state: "active",
    prior_genesis_id: complete.prior_genesis_id,
    genesis_id: complete.genesis_id,
    candidate_manifest_digest: complete.candidate_manifest_digest,
    activation_id: complete.activation_id,
    archive_relative_path: complete.archive_relative_path,
    tree_digest: complete.tree_digest,
    drained_ready_rows: drainedReadyRows,
    carried_intake_rows: carriedIntakeRows,
    archived_intake_rows: archivedIntakeRows,
  };
}

/**
 * The prior epoch may predate this build's contract, so only the genesis ID is
 * read, without digest or canonical validation. Every byte is preserved by the
 * archive regardless.
 */
function readPriorGenesisIdLoose(path: string): `gex_${string}` {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("advance_prior_genesis_unreadable");
  }
  const genesisId = (parsed as { event?: { payload?: { genesis_id?: unknown } } })?.event?.payload
    ?.genesis_id;
  if (typeof genesisId !== "string" || !/^gex_[0-9a-f-]{36}$/.test(genesisId)) {
    throw new Error("advance_prior_genesis_id_invalid");
  }
  return genesisId as `gex_${string}`;
}

function restoreCarriedIntake(
  carriedIntakeRoot: string,
  coordRoot: string,
  onStep?: AdvanceEpochV2Input["onStep"],
): void {
  if (!existsSync(carriedIntakeRoot)) return;
  const destination = join(coordRoot, EVENT_V2_LEDGER_RELATIVE_ROOT, "intake");
  let moved = 0;
  const moveTree = (fromDir: string, toDir: string): void => {
    mkdirSync(toDir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(fromDir).sort()) {
      const from = join(fromDir, name);
      const to = join(toDir, name);
      const stat = lstatSync(from);
      if (stat.isSymbolicLink()) throw new Error(`carried_intake_symlink_forbidden:${name}`);
      if (stat.isDirectory()) {
        moveTree(from, to);
        rmdirIfEmpty(from);
        continue;
      }
      if (!stat.isFile()) throw new Error(`carried_intake_entry_unsupported:${name}`);
      if (existsSync(to)) throw new Error(`carried_intake_destination_collision:${name}`);
      renameSync(from, to);
      moved += 1;
    }
  };
  moveTree(carriedIntakeRoot, destination);
  fsyncParentDirectory(destination);
  rmdirIfEmpty(carriedIntakeRoot);
  if (moved > 0) onStep?.("intake_restored");
}

function rmdirIfEmpty(path: string): void {
  try {
    if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
  } catch {
    // Leftover empty carried-intake directories are harmless artifacts.
  }
}

function countFilesRecursively(root: string): number {
  let count = 0;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) count += countFilesRecursively(path);
    else if (stat.isFile()) count += 1;
  }
  return count;
}

/** Hash, size, and row-count a terminated NDJSON ledger file without loading it whole. */
function inspectTerminatedNdjson(path: string): {
  bytes: number;
  rows: number;
  digest: `sha256:${string}`;
} {
  if (!existsSync(path)) throw new Error("advance_terminal_ledger_missing");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("advance_terminal_ledger_unsafe");
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let rows = 0;
  let bytes = 0;
  let lastByte: number | undefined;
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (read === 0) break;
      const slice = chunk.subarray(0, read);
      hash.update(slice);
      bytes += read;
      lastByte = slice.at(-1);
      for (const byte of slice) if (byte === 0x0a) rows += 1;
    }
  } finally {
    closeSync(fd);
  }
  if (bytes > 0 && lastByte !== 0x0a) throw new Error("advance_terminal_ledger_unterminated");
  return { bytes, rows, digest: `sha256:${hash.digest("hex")}` };
}

function clearDisposableProjectionPaths(
  coordRoot: string,
  artifactRoot: string,
  snapshot: V1ProjectionSnapshotManifestV2,
  gateAlreadyOpen: boolean,
  onStep?: InstallCandidateV2Input["onStep"],
): void {
  const snapshotDigest = projectionSnapshotDigestV2(snapshot);
  const roots = [...snapshot.roots].sort();
  assertDisposableProjectionPaths(roots);
  const intent: ProjectionClearIntentV2 = {
    manifest_version: 1,
    kind: "v1_projection_clear_intent",
    snapshot_digest: snapshotDigest,
    roots,
  };
  writeImmutableCanonicalJson(join(artifactRoot, "projection-clear-intent.json"), intent);
  onStep?.("projection_clear_intent_committed");
  const clearedRoot = join(
    artifactRoot,
    "cleared-projections",
    snapshotDigest.slice("sha256:".length),
  );
  const completePath = join(artifactRoot, "projection-clear-complete.json");
  const completed = readOptionalCanonicalJson<ProjectionClearCompleteV2>(completePath);
  if (
    completed &&
    canonicalJsonV2(completed) !== canonicalJsonV2({ ...intent, kind: completed.kind })
  ) {
    throw new Error("projection_clear_complete_conflict");
  }

  for (const root of roots) {
    const source = resolveInside(coordRoot, root);
    const destination = resolveInside(clearedRoot, root);
    if (existsSync(destination)) {
      assertProjectionRootMatches(clearedRoot, root, snapshot);
      if (existsSync(source) && !gateAlreadyOpen) {
        throw new Error(`projection_recreated_before_candidate:${root}`);
      }
      continue;
    }
    if (gateAlreadyOpen) throw new Error(`cleared_projection_artifact_missing:${root}`);
    if (!existsSync(source)) throw new Error(`projection_clear_source_missing:${root}`);
    assertProjectionRootMatches(coordRoot, root, snapshot);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    renameSync(source, destination);
    fsyncParentDirectory(source);
    fsyncParentDirectory(destination);
    assertProjectionRootMatches(clearedRoot, root, snapshot);
    onStep?.("projection_root_cleared", root);
  }

  if (!gateAlreadyOpen) {
    for (const root of roots) {
      if (existsSync(resolveInside(coordRoot, root))) {
        throw new Error(`projection_recreated_before_candidate:${root}`);
      }
    }
  }
  const complete: ProjectionClearCompleteV2 = {
    manifest_version: 1,
    kind: "v1_projection_clear_complete",
    snapshot_digest: snapshotDigest,
    roots,
  };
  writeImmutableCanonicalJson(completePath, complete);
  onStep?.("projection_clear_complete_committed");
}

function assertProjectionRootMatches(
  baseRoot: string,
  root: string,
  snapshot: V1ProjectionSnapshotManifestV2,
): void {
  const expected = snapshot.entries
    .filter((entry) => entry.relative_path === root || entry.relative_path.startsWith(`${root}/`))
    .sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  const actual = collectProjectionEntries(baseRoot, root);
  if (canonicalJsonV2(actual) !== canonicalJsonV2(expected)) {
    throw new Error(`projection_clear_snapshot_mismatch:${root}`);
  }
}

function collectProjectionEntries(
  baseRoot: string,
  relativePath: string,
): ProjectionSnapshotEntryV2[] {
  const path = resolveInside(baseRoot, relativePath);
  if (!existsSync(path)) throw new Error(`projection_clear_path_missing:${relativePath}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`projection_clear_symlink_forbidden:${relativePath}`);
  if (stat.isFile()) {
    const facts = inspectStableFile(path);
    return [
      {
        relative_path: relativePath,
        kind: "file",
        mode: stat.mode & 0o777,
        bytes: facts.bytes,
        digest: facts.digest,
      },
    ];
  }
  if (!stat.isDirectory()) throw new Error(`projection_clear_path_unsupported:${relativePath}`);
  const entries: ProjectionSnapshotEntryV2[] = [
    { relative_path: relativePath, kind: "directory", mode: stat.mode & 0o777 },
  ];
  for (const name of readdirSync(path).sort()) {
    entries.push(...collectProjectionEntries(baseRoot, `${relativePath}/${name}`));
  }
  return entries.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
}

function assertDisposableProjectionPaths(paths: readonly string[]): void {
  const allowed = new Set([
    ".harnery/.events-cursor",
    ".harnery/.identity-index.json",
    ".harnery/active",
    ".harnery/guard",
    ".harnery/pid-map",
  ]);
  if (paths.length === 0) throw new Error("candidate_projection_paths_required");
  for (const path of paths) {
    if (!allowed.has(path)) throw new Error(`durable_projection_clear_forbidden:${path}`);
  }
}

function collectTree(root: string): V2ArchiveEntryV2[] {
  if (!existsSync(root)) throw new Error("v2_epoch_root_missing");
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("v2_epoch_root_unsafe");
  const entries: V2ArchiveEntryV2[] = [];
  collectTreeDirectory(root, "", entries);
  return entries.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
}

function collectTreeDirectory(
  root: string,
  relativePath: string,
  entries: V2ArchiveEntryV2[],
): void {
  const directory = relativePath ? join(root, relativePath) : root;
  for (const name of readdirSync(directory).sort()) {
    const childRelative = relativePath ? `${relativePath}/${name}` : name;
    const child = join(root, childRelative);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error(`v2_archive_symlink_forbidden:${childRelative}`);
    if (stat.isDirectory()) {
      entries.push({ relative_path: childRelative, kind: "directory", mode: stat.mode & 0o777 });
      collectTreeDirectory(root, childRelative, entries);
      continue;
    }
    if (!stat.isFile()) throw new Error(`v2_archive_entry_unsupported:${childRelative}`);
    const facts = inspectStableFile(child);
    entries.push({
      relative_path: childRelative,
      kind: "file",
      mode: stat.mode & 0o777,
      bytes: facts.bytes,
      digest: facts.digest,
    });
  }
}

function assertTreeMatches(
  root: string,
  manifest: Pick<V2EpochArchiveManifestV2, "entries" | "tree_digest">,
): void {
  const actual = collectTree(root);
  if (
    canonicalJsonV2(actual) !== canonicalJsonV2(manifest.entries) ||
    sha256V2(canonicalJsonV2(actual)) !== manifest.tree_digest
  ) {
    throw new Error("v2_archive_tree_changed");
  }
}

function validateArchiveManifest(
  manifest: V2EpochArchiveManifestV2,
  candidate: CandidateGenesisManifestV2,
  archiveRelativePath: string,
): void {
  if (
    manifest.manifest_version !== 1 ||
    manifest.kind !== "v2_epoch_archive" ||
    manifest.genesis_id !== candidate.event.payload.genesis_id ||
    manifest.candidate_manifest_digest !== candidateManifestDigestV2(candidate) ||
    manifest.archive_relative_path !== archiveRelativePath ||
    !["candidate", "active", "repairable", "invalid"].includes(manifest.control_state) ||
    sha256V2(canonicalJsonV2(manifest.entries)) !== manifest.tree_digest
  ) {
    throw new Error("v2_archive_manifest_invalid");
  }
}

function readInstalledCandidateForRollback(coordRoot: string): CandidateGenesisManifestV2 {
  const path = join(coordRoot, EVENT_V2_LEDGER_RELATIVE_ROOT, "genesis.json");
  const candidate = readCanonicalJson<CandidateGenesisManifestV2>(path);
  const validated = validateCandidateGenesisManifestV2(candidate);
  if (!validated.ok) throw new Error(`installed_candidate_invalid:${validated.reason}`);
  return validated.value;
}

function installV2ArchiveFence(
  source: string,
  manifest: Pick<V2EpochArchiveManifestV2, "genesis_id" | "archive_relative_path" | "tree_digest">,
): void {
  const fence = {
    manifest_version: 1,
    kind: V2_ARCHIVE_FENCE_KIND,
    genesis_id: manifest.genesis_id,
    archive_relative_path: manifest.archive_relative_path,
    tree_digest: manifest.tree_digest,
  };
  if (existsSync(source)) {
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("v2_archive_fence_path_unsafe");
    const existing = readCanonicalJson<Record<string, unknown>>(source);
    if (canonicalJsonV2(existing) !== canonicalJsonV2(fence)) {
      throw new Error("v2_archive_fence_mismatch");
    }
    return;
  }
  writeImmutableCanonicalJson(source, fence);
  chmodSync(source, 0o400);
  fsyncParentDirectory(source);
}

function releaseVerifiedV2ArchiveFence(coordRoot: string): void {
  const source = join(coordRoot, EVENT_V2_LEDGER_RELATIVE_ROOT);
  if (!existsSync(source)) return;
  const stat = lstatSync(source);
  if (stat.isDirectory() && !stat.isSymbolicLink()) return;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("previous_v2_fence_path_unsafe");
  }
  const fence = readCanonicalJson<Record<string, unknown>>(source);
  const keys = Object.keys(fence).sort();
  const expectedKeys = [
    "archive_relative_path",
    "genesis_id",
    "kind",
    "manifest_version",
    "tree_digest",
  ];
  if (
    canonicalJsonV2(keys) !== canonicalJsonV2(expectedKeys) ||
    fence.manifest_version !== 1 ||
    fence.kind !== V2_ARCHIVE_FENCE_KIND ||
    typeof fence.genesis_id !== "string" ||
    !/^gex_[0-9a-f-]{36}$/.test(fence.genesis_id) ||
    fence.archive_relative_path !== `${CANDIDATE_ARCHIVE_RELATIVE_ROOT}/${fence.genesis_id}` ||
    typeof fence.tree_digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(fence.tree_digest)
  ) {
    throw new Error("previous_v2_fence_invalid");
  }
  const archive = join(coordRoot, fence.archive_relative_path);
  const entries = collectTree(archive);
  if (sha256V2(canonicalJsonV2(entries)) !== fence.tree_digest) {
    throw new Error("previous_v2_archive_changed");
  }
  chmodSync(source, 0o600);
  unlinkSync(source);
  fsyncParentDirectory(source);
}

function assertArtifactRoot(coordRoot: string, value: string): string {
  const artifactRoot = resolve(value);
  const liveV2 = resolve(coordRoot, EVENT_V2_LEDGER_RELATIVE_ROOT);
  if (inside(liveV2, artifactRoot) || artifactRoot === resolve(coordRoot)) {
    throw new Error("cutover_artifact_root_forbidden");
  }
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  return artifactRoot;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resolveInside(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error(`absolute_path_forbidden:${relativePath}`);
  const candidate = resolve(root, relativePath);
  if (!inside(resolve(root), candidate) || candidate === resolve(root)) {
    throw new Error(`path_outside_root:${relativePath}`);
  }
  return candidate;
}

function packetKeys(): string[] {
  return [
    "event_id",
    "genesis_id",
    "instance_id",
    "kind",
    "packet_version",
    "producer",
    "profile_base",
    "root_id",
  ];
}

function profileBaseKeys(): string[] {
  return [
    "adapter_capability_profile_digests",
    "candidate_created_at",
    "canonicalizer_version",
    "config_digest",
    "contract_source_digest",
    "fingerprint_version",
    "harnery_commit",
    "host_repository_commit",
    "initial_schema_digest",
    "privacy_key_epoch",
    "producer_build_ids",
  ];
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function inspectStableFile(path: string): { bytes: number; digest: `sha256:${string}` } {
  const beforePath = lstatSync(path);
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    throw new Error(`v2_archive_file_unsafe:${path}`);
  }
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    const before = fstatSync(fd);
    if (before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      throw new Error(`v2_archive_file_replaced:${path}`);
    }
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
      bytes += count;
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== after.size) {
      throw new Error(`v2_archive_file_changed:${path}`);
    }
    return { bytes, digest: `sha256:${hash.digest("hex")}` };
  } finally {
    closeSync(fd);
  }
}

function writeImmutableCanonicalJson(path: string, value: unknown): void {
  const body = `${canonicalJsonV2(value)}\n`;
  if (Buffer.byteLength(body) > RECORD_LIMIT) throw new Error("cutover_install_record_too_large");
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== body) throw new Error(`immutable_record_conflict:${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temporary, path);
    fsyncParentDirectory(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readFileSync(path, "utf8") !== body) throw new Error(`immutable_record_conflict:${path}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readCanonicalJson<T>(path: string): T {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > RECORD_LIMIT) {
    throw new Error(`cutover_install_record_invalid:${path}`);
  }
  const body = readFileSync(path, "utf8");
  const value = JSON.parse(body) as T;
  if (`${canonicalJsonV2(value)}\n` !== body) throw new Error(`record_not_canonical:${path}`);
  return value;
}

function readOptionalCanonicalJson<T>(path: string): T | undefined {
  return existsSync(path) ? readCanonicalJson<T>(path) : undefined;
}
