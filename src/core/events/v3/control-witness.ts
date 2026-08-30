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
  EVENT_V3_CONTROL_WITNESS_RELATIVE_PATH,
  type EventV3AuthorityStorageVersionV3,
  eventV3AuthorityStorageVersionV3,
  eventV3ControlWitnessPathV3,
} from "./reader.ts";

export { EVENT_V3_CONTROL_WITNESS_RELATIVE_PATH };

interface EventV3ControlWitnessPayload {
  format: "harnery-event-v3-control-witness";
  format_version: 1;
  genesis_id: `gex_${string}`;
  activation_id: `act_${string}`;
  genesis_event_id: `evt_${string}`;
  activation_event_id: `evt_${string}`;
  genesis_manifest_digest: `sha256:${string}`;
  activation_manifest_digest: `sha256:${string}`;
  candidate_manifest_digest: `sha256:${string}`;
  privacy_key_epoch: `pep_${string}`;
  root_id: `root_${string}`;
  storage: EventV3AuthorityStorageVersionV3;
}

interface EventV3ControlWitness {
  payload: EventV3ControlWitnessPayload;
  authentication: FingerprintV3;
}

export interface ActiveControlWitnessBindingV3 {
  genesis: CandidateGenesisManifestV3;
  activation: ActivationManifestV3;
  candidate_manifest_digest: `sha256:${string}`;
}

/** True only when one authenticated witness names this exact active control pair and storage. */
export function activeControlWitnessMatchesV3(
  coordRoot: string,
  binding: ActiveControlWitnessBindingV3,
): boolean {
  try {
    const before = eventV3AuthorityStorageVersionV3(coordRoot);
    const witness = readAuthenticatedWitnessV3(coordRoot);
    if (!witness) return false;
    const expected = witnessPayloadV3(binding, before);
    if (canonicalJsonV3(witness.payload) !== canonicalJsonV3(expected)) return false;
    const after = eventV3AuthorityStorageVersionV3(coordRoot);
    return sameStorageVersion(before, after);
  } catch {
    return false;
  }
}

/**
 * Publish a witness only when the storage validated by the caller is still current.
 * Failure is intentionally silent: the next read retains the canonical full-scan fallback.
 */
export function publishActiveControlWitnessV3(
  coordRoot: string,
  binding: ActiveControlWitnessBindingV3,
  validatedStorage: EventV3AuthorityStorageVersionV3,
): boolean {
  try {
    const current = eventV3AuthorityStorageVersionV3(coordRoot);
    if (!sameStorageVersion(validatedStorage, current)) return false;
    return publishWitnessV3(coordRoot, witnessPayloadV3(binding, current));
  } catch {
    return false;
  }
}

/**
 * Capture a previously authenticated witness before the append lease mutates storage.
 * The returned payload is safe to advance only while the caller continues to hold that lease.
 */
export function readAdvanceableControlWitnessV3(
  coordRoot: string,
): EventV3ControlWitnessPayload | undefined {
  try {
    const storage = eventV3AuthorityStorageVersionV3(coordRoot);
    const witness = readAuthenticatedWitnessV3(coordRoot);
    if (!witness || !sameStorageVersion(witness.payload.storage, storage)) return undefined;
    return witness.payload;
  } catch {
    return undefined;
  }
}

/** Advance a lease-held witness after durable appends without changing writer success semantics. */
export function advanceControlWitnessV3(
  coordRoot: string,
  prior: EventV3ControlWitnessPayload,
  currentGenesisId: string | undefined,
): boolean {
  try {
    if (currentGenesisId !== prior.genesis_id) return false;
    return publishWitnessV3(coordRoot, {
      ...prior,
      storage: eventV3AuthorityStorageVersionV3(coordRoot),
    });
  } catch {
    return false;
  }
}

function witnessPayloadV3(
  binding: ActiveControlWitnessBindingV3,
  storage: EventV3AuthorityStorageVersionV3,
): EventV3ControlWitnessPayload {
  const scope = binding.genesis.event.scope as { root_id: `root_${string}` };
  return {
    format: "harnery-event-v3-control-witness",
    format_version: 1,
    genesis_id: binding.genesis.event.payload.genesis_id as `gex_${string}`,
    activation_id: binding.activation.activation_id,
    genesis_event_id: binding.genesis.event.event_id as `evt_${string}`,
    activation_event_id: binding.activation.event.event_id as `evt_${string}`,
    genesis_manifest_digest: sha256V3(canonicalJsonV3(binding.genesis)),
    activation_manifest_digest: sha256V3(canonicalJsonV3(binding.activation)),
    candidate_manifest_digest: binding.candidate_manifest_digest,
    privacy_key_epoch: binding.genesis.profile.privacy_key_epoch,
    root_id: scope.root_id,
    storage,
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

function publishWitnessV3(coordRoot: string, payload: EventV3ControlWitnessPayload): boolean {
  const witness: EventV3ControlWitness = {
    payload,
    authentication: authenticatePayloadV3(coordRoot, payload),
  };
  const path = eventV3ControlWitnessPathV3(coordRoot);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${canonicalJsonV3(witness)}\n`, "utf8");
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
  const expectedPayloadKeys = [
    "activation_event_id",
    "activation_id",
    "activation_manifest_digest",
    "candidate_manifest_digest",
    "format",
    "format_version",
    "genesis_event_id",
    "genesis_id",
    "genesis_manifest_digest",
    "privacy_key_epoch",
    "root_id",
    "storage",
  ];
  if (Object.keys(payload).sort().join("\0") !== expectedPayloadKeys.sort().join("\0")) {
    throw new Error("control witness payload shape is invalid");
  }
  const storage = object(payload.storage);
  if (Object.keys(storage).sort().join("\0") !== "active_bytes\0fingerprint") {
    throw new Error("control witness storage shape is invalid");
  }
  if (
    payload.format !== "harnery-event-v3-control-witness" ||
    payload.format_version !== 1 ||
    !token(payload.genesis_id, "gex_") ||
    !token(payload.activation_id, "act_") ||
    !token(payload.genesis_event_id, "evt_") ||
    !token(payload.activation_event_id, "evt_") ||
    !digest(payload.genesis_manifest_digest) ||
    !digest(payload.activation_manifest_digest) ||
    !digest(payload.candidate_manifest_digest) ||
    !token(payload.privacy_key_epoch, "pep_") ||
    !token(payload.root_id, "root_") ||
    !digest(storage.fingerprint) ||
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
