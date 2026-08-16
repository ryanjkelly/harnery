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
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fsyncParentDirectory } from "../../workflow/durable-record.ts";
import { canonicalJsonV2, sha256V2 } from "./canonical.ts";
import {
  type ActivationManifestV2,
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
  projectionSnapshotDigestV2,
  rollbackV1LedgerV2,
  sealV1LedgerV2,
  type V1ProjectionSnapshotManifestV2,
  type V1RollbackRecordV2,
  type V1SealManifestV2,
  v1SealManifestDigestV2,
} from "./cutover.ts";
import { eventIdV2, genesisIdV2 } from "./ids.ts";
import { EVENT_V2_LEDGER_RELATIVE_ROOT } from "./writer.ts";

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
  | "genesis_manifest_installed"
  | "genesis_event_repaired"
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
  | "v2_archive_record_committed";

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
  control_state: "candidate" | "active";
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
    if (control.state !== "candidate" && control.state !== "active") {
      throw new Error(`v2_archive_requires_open_epoch:${control.state}`);
    }
    if (canonicalJsonV2(control.genesis) !== canonicalJsonV2(candidate)) {
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

function assertTreeMatches(root: string, manifest: V2EpochArchiveManifestV2): void {
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
    (manifest.control_state !== "candidate" && manifest.control_state !== "active") ||
    sha256V2(canonicalJsonV2(manifest.entries)) !== manifest.tree_digest
  ) {
    throw new Error("v2_archive_manifest_invalid");
  }
}

function installV2ArchiveFence(source: string, manifest: V2EpochArchiveManifestV2): void {
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
