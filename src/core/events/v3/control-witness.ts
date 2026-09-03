import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fsyncParentDirectory } from "../../workflow/durable-record.ts";
import { canonicalJsonV3, type FingerprintV3, fingerprintV3, sha256V3 } from "./canonical.ts";
import type { ActivationManifestV3, CandidateGenesisManifestV3 } from "./control.ts";
import { fingerprintContextV3 } from "./fingerprint-keys.ts";
import {
  advanceEventV3AppendValidationCheckpointV3,
  EVENT_V3_CONTROL_CHECKPOINT_RELATIVE_PATH,
  EVENT_V3_CONTROL_WITNESS_RELATIVE_PATH,
  type EventV3AppendValidationCheckpointV3,
  type EventV3AuthorityStorageVersionV3,
  eventV3AuthorityStorageVersionV3,
  eventV3ControlCheckpointPathV3,
  eventV3ControlWitnessPathV3,
  parseEventV3AppendValidationCheckpointV3,
} from "./reader.ts";

export { EVENT_V3_CONTROL_CHECKPOINT_RELATIVE_PATH, EVENT_V3_CONTROL_WITNESS_RELATIVE_PATH };

/**
 * A witness answers one question cheaply: does an authenticated record already
 * name this exact control pair over this exact storage? Both control states get
 * one, because a hook must never pay a whole-history parse for either.
 *
 * `control_state` is the discriminator, and it is authenticated with the rest of
 * the payload. A candidate witness therefore cannot be replayed as an active
 * one, and an active witness cannot survive its activation being removed.
 */
export type EventV3ControlWitnessControlStateV3 = "active" | "candidate";

interface EventV3ControlWitnessPayloadCommonV3 {
  format: "harnery-event-v3-control-witness";
  format_version: 2;
  genesis_id: `gex_${string}`;
  genesis_event_id: `evt_${string}`;
  genesis_manifest_digest: `sha256:${string}`;
  candidate_manifest_digest: `sha256:${string}`;
  privacy_key_epoch: `pep_${string}`;
  root_id: `root_${string}`;
  storage: EventV3AuthorityStorageVersionV3;
  checkpoint_digest: `sha256:${string}`;
}

interface EventV3ActiveControlWitnessPayloadV3 extends EventV3ControlWitnessPayloadCommonV3 {
  control_state: "active";
  activation_id: `act_${string}`;
  activation_event_id: `evt_${string}`;
  activation_manifest_digest: `sha256:${string}`;
}

interface EventV3CandidateControlWitnessPayloadV3 extends EventV3ControlWitnessPayloadCommonV3 {
  control_state: "candidate";
}

type EventV3ControlWitnessPayload =
  | EventV3ActiveControlWitnessPayloadV3
  | EventV3CandidateControlWitnessPayloadV3;

interface EventV3ControlWitness {
  payload: EventV3ControlWitnessPayload;
  authentication: FingerprintV3;
}

export interface ActiveControlWitnessBindingV3 {
  genesis: CandidateGenesisManifestV3;
  activation: ActivationManifestV3;
  candidate_manifest_digest: `sha256:${string}`;
}

/** The candidate equivalent: a validated genesis with no activation yet. */
export interface CandidateControlWitnessBindingV3 {
  genesis: CandidateGenesisManifestV3;
  candidate_manifest_digest: `sha256:${string}`;
}

/** True only when one authenticated witness names this exact active control pair and storage. */
export function activeControlWitnessMatchesV3(
  coordRoot: string,
  binding: ActiveControlWitnessBindingV3,
): boolean {
  return witnessMatchesV3(coordRoot, "active", (storage, checkpointDigest) =>
    activeWitnessPayloadV3(binding, storage, checkpointDigest),
  );
}

/**
 * True only when one authenticated witness names this exact candidate control
 * pair and storage.
 *
 * A candidate epoch is not a degraded active one: its gate is narrower, but a
 * hook still has to resolve it, and paying a whole-history parse for that
 * answer is what made a stranded epoch cost seconds and hundreds of megabytes
 * per process. The tamper coverage is the active witness's, unchanged: the
 * authenticated payload names the storage version, so a corrupt append, a
 * same-size rewrite, a changed sealed segment, and a replaced inode all miss
 * and fall back to canonical validation. Because `control_state` is inside the
 * authenticated payload, an active witness can never answer here and a
 * candidate witness can never answer the active gate.
 */
export function candidateControlWitnessMatchesV3(
  coordRoot: string,
  binding: CandidateControlWitnessBindingV3,
): boolean {
  return witnessMatchesV3(coordRoot, "candidate", (storage, checkpointDigest) =>
    candidateWitnessPayloadV3(binding, storage, checkpointDigest),
  );
}

/**
 * Publish a witness only when the storage validated by the caller is still current.
 * Failure is intentionally silent: the next read retains the canonical full-scan fallback.
 */
export function publishActiveControlWitnessV3(
  coordRoot: string,
  binding: ActiveControlWitnessBindingV3,
  validatedStorage: EventV3AuthorityStorageVersionV3,
  checkpoint: EventV3AppendValidationCheckpointV3,
): boolean {
  return publishControlWitnessV3(
    coordRoot,
    validatedStorage,
    checkpoint,
    (storage, checkpointDigest) => activeWitnessPayloadV3(binding, storage, checkpointDigest),
  );
}

/**
 * The candidate equivalent, published on the same terms: only when the storage
 * the caller validated is still current, and silently skipped otherwise so the
 * next read keeps the canonical full-scan fallback.
 */
export function publishCandidateControlWitnessV3(
  coordRoot: string,
  binding: CandidateControlWitnessBindingV3,
  validatedStorage: EventV3AuthorityStorageVersionV3,
  checkpoint: EventV3AppendValidationCheckpointV3,
): boolean {
  return publishControlWitnessV3(
    coordRoot,
    validatedStorage,
    checkpoint,
    (storage, checkpointDigest) => candidateWitnessPayloadV3(binding, storage, checkpointDigest),
  );
}

/**
 * Capture a previously authenticated witness before the append lease mutates storage.
 * The returned payload is safe to advance only while the caller continues to hold that lease.
 */
export function readAdvanceableControlWitnessV3(coordRoot: string):
  | {
      payload: EventV3ControlWitnessPayload;
      checkpoint: EventV3AppendValidationCheckpointV3;
    }
  | undefined {
  try {
    const storage = eventV3AuthorityStorageVersionV3(coordRoot);
    const witness = readAuthenticatedWitnessV3(coordRoot);
    if (!witness || !sameStorageVersion(witness.payload.storage, storage)) return undefined;
    const checkpoint = readAuthenticatedCheckpointV3(coordRoot, witness.payload.checkpoint_digest);
    return checkpoint && checkpoint.validated_active_bytes === storage.active_bytes
      ? { payload: witness.payload, checkpoint }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Advance a lease-held witness after durable appends without changing writer success semantics. */
export function advanceControlWitnessV3(
  coordRoot: string,
  prior: {
    payload: EventV3ControlWitnessPayload;
    checkpoint: EventV3AppendValidationCheckpointV3;
  },
  currentGenesisId: string | undefined,
): boolean {
  try {
    if (currentGenesisId !== prior.payload.genesis_id) return false;
    const storageBeforeValidation = eventV3AuthorityStorageVersionV3(coordRoot);
    const checkpoint = advanceEventV3AppendValidationCheckpointV3(coordRoot, prior.checkpoint);
    if (!checkpoint) return false;
    const storage = eventV3AuthorityStorageVersionV3(coordRoot);
    if (
      storageBeforeValidation.fingerprint !== storage.fingerprint ||
      prior.payload.storage.stable_fingerprint !== storage.stable_fingerprint ||
      checkpoint.validated_active_bytes !== storage.active_bytes
    ) {
      return false;
    }
    return publishWitnessV3(
      coordRoot,
      {
        ...prior.payload,
        storage,
        checkpoint_digest: checkpointDigestV3(checkpoint),
      },
      checkpoint,
    );
  } catch {
    return false;
  }
}

type WitnessPayloadBuilderV3 = (
  storage: EventV3AuthorityStorageVersionV3,
  checkpointDigest: `sha256:${string}`,
) => EventV3ControlWitnessPayload;

/**
 * One matcher for both control states. The witness on disk must authenticate,
 * carry the requested `control_state`, and canonicalize identically to the
 * payload this exact binding would produce over the storage observed both
 * before and after the read.
 */
function witnessMatchesV3(
  coordRoot: string,
  controlState: EventV3ControlWitnessControlStateV3,
  build: WitnessPayloadBuilderV3,
): boolean {
  try {
    const before = eventV3AuthorityStorageVersionV3(coordRoot);
    const witness = readAuthenticatedWitnessV3(coordRoot);
    if (!witness || witness.payload.control_state !== controlState) return false;
    const expected = build(before, witness.payload.checkpoint_digest);
    if (canonicalJsonV3(witness.payload) !== canonicalJsonV3(expected)) return false;
    const after = eventV3AuthorityStorageVersionV3(coordRoot);
    return sameStorageVersion(before, after);
  } catch {
    return false;
  }
}

function publishControlWitnessV3(
  coordRoot: string,
  validatedStorage: EventV3AuthorityStorageVersionV3,
  checkpoint: EventV3AppendValidationCheckpointV3,
  build: WitnessPayloadBuilderV3,
): boolean {
  try {
    const current = eventV3AuthorityStorageVersionV3(coordRoot);
    if (!sameStorageVersion(validatedStorage, current)) return false;
    return publishWitnessV3(coordRoot, build(current, checkpointDigestV3(checkpoint)), checkpoint);
  } catch {
    return false;
  }
}

function activeWitnessPayloadV3(
  binding: ActiveControlWitnessBindingV3,
  storage: EventV3AuthorityStorageVersionV3,
  checkpointDigest: `sha256:${string}`,
): EventV3ActiveControlWitnessPayloadV3 {
  return {
    ...commonWitnessPayloadV3(binding, storage, checkpointDigest),
    control_state: "active",
    activation_id: binding.activation.activation_id,
    activation_event_id: binding.activation.event.event_id as `evt_${string}`,
    activation_manifest_digest: sha256V3(canonicalJsonV3(binding.activation)),
  };
}

function candidateWitnessPayloadV3(
  binding: CandidateControlWitnessBindingV3,
  storage: EventV3AuthorityStorageVersionV3,
  checkpointDigest: `sha256:${string}`,
): EventV3CandidateControlWitnessPayloadV3 {
  return {
    ...commonWitnessPayloadV3(binding, storage, checkpointDigest),
    control_state: "candidate",
  };
}

function commonWitnessPayloadV3(
  binding: CandidateControlWitnessBindingV3,
  storage: EventV3AuthorityStorageVersionV3,
  checkpointDigest: `sha256:${string}`,
): EventV3ControlWitnessPayloadCommonV3 {
  const scope = binding.genesis.event.scope as { root_id: `root_${string}` };
  return {
    format: "harnery-event-v3-control-witness",
    format_version: 2,
    genesis_id: binding.genesis.event.payload.genesis_id as `gex_${string}`,
    genesis_event_id: binding.genesis.event.event_id as `evt_${string}`,
    genesis_manifest_digest: sha256V3(canonicalJsonV3(binding.genesis)),
    candidate_manifest_digest: binding.candidate_manifest_digest,
    privacy_key_epoch: binding.genesis.profile.privacy_key_epoch,
    root_id: scope.root_id,
    storage,
    checkpoint_digest: checkpointDigest,
  };
}

function readAuthenticatedWitnessV3(coordRoot: string): EventV3ControlWitness | undefined {
  const path = eventV3ControlWitnessPathV3(coordRoot);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  const value: unknown = JSON.parse(raw);
  const witness = parseWitnessV3(value);
  if (`${canonicalJsonV3(witness)}\n` !== raw) return undefined;
  const expected = authenticatePayloadV3(coordRoot, witness.payload);
  return canonicalJsonV3(witness.authentication) === canonicalJsonV3(expected)
    ? witness
    : undefined;
}

function publishWitnessV3(
  coordRoot: string,
  payload: EventV3ControlWitnessPayload,
  checkpoint: EventV3AppendValidationCheckpointV3,
): boolean {
  if (!publishCanonicalFileV3(eventV3ControlCheckpointPathV3(coordRoot), checkpoint)) return false;
  const witness: EventV3ControlWitness = {
    payload,
    authentication: authenticatePayloadV3(coordRoot, payload),
  };
  return publishCanonicalFileV3(eventV3ControlWitnessPathV3(coordRoot), witness);
}

function publishCanonicalFileV3(path: string, value: unknown): boolean {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${canonicalJsonV3(value)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    fsyncParentDirectory(path);
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readAuthenticatedCheckpointV3(
  coordRoot: string,
  expectedDigest: `sha256:${string}`,
): EventV3AppendValidationCheckpointV3 | undefined {
  try {
    const raw = readFileSync(eventV3ControlCheckpointPathV3(coordRoot), "utf8");
    const value: unknown = JSON.parse(raw);
    if (
      `${canonicalJsonV3(value)}\n` !== raw ||
      sha256V3(canonicalJsonV3(value)) !== expectedDigest
    ) {
      return undefined;
    }
    return parseEventV3AppendValidationCheckpointV3(value);
  } catch {
    return undefined;
  }
}

function checkpointDigestV3(checkpoint: EventV3AppendValidationCheckpointV3): `sha256:${string}` {
  return sha256V3(canonicalJsonV3(checkpoint));
}

function authenticatePayloadV3(
  coordRoot: string,
  payload: EventV3ControlWitnessPayload,
): FingerprintV3 {
  const context = fingerprintContextV3(
    coordRoot,
    payload.root_id,
    undefined,
    payload.privacy_key_epoch,
  );
  return fingerprintV3(context, "control-state-witness", payload, "root");
}

function parseWitnessV3(value: unknown): EventV3ControlWitness {
  const envelope = object(value);
  if (Object.keys(envelope).sort().join("\0") !== "authentication\0payload") {
    throw new Error("control witness envelope is invalid");
  }
  const payload = object(envelope.payload);
  const controlState = payload.control_state;
  if (controlState !== "active" && controlState !== "candidate") {
    throw new Error("control witness control state is invalid");
  }
  const commonPayloadKeys = [
    "candidate_manifest_digest",
    "checkpoint_digest",
    "control_state",
    "format",
    "format_version",
    "genesis_event_id",
    "genesis_id",
    "genesis_manifest_digest",
    "privacy_key_epoch",
    "root_id",
    "storage",
  ];
  const expectedPayloadKeys =
    controlState === "active"
      ? [...commonPayloadKeys, "activation_event_id", "activation_id", "activation_manifest_digest"]
      : commonPayloadKeys;
  if (Object.keys(payload).sort().join("\0") !== expectedPayloadKeys.sort().join("\0")) {
    throw new Error("control witness payload shape is invalid");
  }
  const storage = object(payload.storage);
  if (Object.keys(storage).sort().join("\0") !== "active_bytes\0fingerprint\0stable_fingerprint") {
    throw new Error("control witness storage shape is invalid");
  }
  if (
    payload.format !== "harnery-event-v3-control-witness" ||
    payload.format_version !== 2 ||
    !token(payload.genesis_id, "gex_") ||
    !token(payload.genesis_event_id, "evt_") ||
    (controlState === "active" &&
      (!token(payload.activation_id, "act_") ||
        !token(payload.activation_event_id, "evt_") ||
        !digest(payload.activation_manifest_digest))) ||
    !digest(payload.genesis_manifest_digest) ||
    !digest(payload.candidate_manifest_digest) ||
    !digest(payload.checkpoint_digest) ||
    !token(payload.privacy_key_epoch, "pep_") ||
    !token(payload.root_id, "root_") ||
    !digest(storage.fingerprint) ||
    !digest(storage.stable_fingerprint) ||
    !Number.isSafeInteger(storage.active_bytes) ||
    (storage.active_bytes as number) < 0
  ) {
    throw new Error("control witness payload is invalid");
  }
  const authentication = object(envelope.authentication);
  return {
    payload: payload as unknown as EventV3ControlWitnessPayload,
    authentication: authentication as unknown as FingerprintV3,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("control witness value is not an object");
  }
  return value as Record<string, unknown>;
}

function token(value: unknown, prefix: string): value is string {
  return (
    typeof value === "string" && value.startsWith(prefix) && /^[a-zA-Z0-9._-]{1,160}$/.test(value)
  );
}

function digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function sameStorageVersion(
  left: EventV3AuthorityStorageVersionV3,
  right: EventV3AuthorityStorageVersionV3,
): boolean {
  return left.fingerprint === right.fingerprint && left.active_bytes === right.active_bytes;
}
