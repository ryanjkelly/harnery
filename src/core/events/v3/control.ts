import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildEventV3 } from "./builder.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import type { EventV3 } from "./contract.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { activationIdV3, eventIdV3, genesisIdV3 } from "./ids.ts";
import { type ReadLedgerV3Result, readLedgerV3 } from "./reader.ts";
import { validateEventV3 } from "./validate.ts";

export const EVENT_V3_GENESIS_MANIFEST = ".harnery/ledgers/v3/genesis.json" as const;
export const EVENT_V3_ACTIVATION_MANIFEST = ".harnery/ledgers/v3/activation.json" as const;

type GenesisEventV3 = Extract<EventV3, { event_type: "ledger.genesis" }>;
type ActivationEventV3 = Extract<EventV3, { event_type: "ledger.activated" }>;

export interface CandidateProfileV3 {
  initial_schema_digest: `sha256:${string}`;
  contract_source_digest: `sha256:${string}`;
  harnery_commit: string;
  host_repository_commit: string;
  producer_build_ids: string[];
  adapter_capability_profile_digests: string[];
  config_digest: `sha256:${string}`;
  canonicalizer_version: "harnery-jcs-nfc-v1";
  fingerprint_version: string;
  privacy_key_epoch: `pep_${string}`;
  candidate_created_at: string;
}

export interface CandidateGenesisManifestV3 {
  manifest_version: 1;
  kind: "candidate_genesis";
  profile: CandidateProfileV3;
  event: GenesisEventV3;
}

export interface ActivationManifestV3 {
  manifest_version: 1;
  kind: "activation";
  activation_id: `act_${string}`;
  genesis_id: `gex_${string}`;
  candidate_manifest_digest: `sha256:${string}`;
  approval_record_id: string;
  activation_approved_at: string;
  event: ActivationEventV3;
}

export interface ControlProducerV3 {
  producer_id: `prd_${string}`;
  boot_id: `boot_${string}`;
  sequence: number;
  build_id: `build_${string}`;
  platform: "linux" | "windows" | "macos" | "unknown";
  bridge?: "codex-wsl";
}

export interface BuildCandidateGenesisManifestV3Input {
  profile: CandidateProfileV3;
  root_id: `root_${string}`;
  instance_id: `inst_${string}`;
  producer: ControlProducerV3;
  genesis_id?: `gex_${string}`;
  event_id?: `evt_${string}`;
}

export interface BuildActivationManifestV3Input {
  candidate: CandidateGenesisManifestV3;
  approval_record_id: string;
  activation_approved_at: string;
  producer: ControlProducerV3;
  activation_id?: `act_${string}`;
  event_id?: `evt_${string}`;
}

export type ControlManifestValidationV3<T> = { ok: true; value: T } | { ok: false; reason: string };

export type EventV3ControlState =
  | { state: "closed"; reason: "no_candidate" }
  | {
      state: "repairable";
      reason: "genesis_event_missing" | "activation_event_missing";
      genesis: CandidateGenesisManifestV3;
      activation?: ActivationManifestV3;
    }
  | {
      state: "candidate";
      genesis: CandidateGenesisManifestV3;
      candidate_manifest_digest: `sha256:${string}`;
    }
  | {
      state: "active";
      genesis: CandidateGenesisManifestV3;
      activation: ActivationManifestV3;
      candidate_manifest_digest: `sha256:${string}`;
    }
  | { state: "invalid"; reason: string };

export type EventV3WriteMode = "candidate" | "active";

/** Build a complete immutable candidate packet without writing it or opening a gate. */
export function buildCandidateGenesisManifestV3(
  input: BuildCandidateGenesisManifestV3Input,
): CandidateGenesisManifestV3 {
  const profile: CandidateProfileV3 = {
    ...input.profile,
    producer_build_ids: [...input.profile.producer_build_ids].sort(),
    adapter_capability_profile_digests: [
      ...input.profile.adapter_capability_profile_digests,
    ].sort(),
  };
  const event = buildEventV3("ledger.genesis", {
    event_id: input.event_id,
    producer: { ...input.producer, component: "recovery" },
    scope: { root_id: input.root_id, instance_id: input.instance_id },
    links: { caused_by: [] },
    provenance: controlProvenance("cutover.genesis", input.instance_id),
    observed_at: profile.candidate_created_at,
    recorded_at: profile.candidate_created_at,
    payload: {
      genesis_id: input.genesis_id ?? genesisIdV3(),
      genesis_profile_digest: candidateProfileDigestV3(profile),
      contract_digest: profile.contract_source_digest,
      generated_schema_digest: profile.initial_schema_digest,
      canonicalizer: profile.canonicalizer_version,
      privacy_epoch_id: profile.privacy_key_epoch,
      candidate_created_at: profile.candidate_created_at,
    },
  });
  const manifest: CandidateGenesisManifestV3 = {
    manifest_version: 1,
    kind: "candidate_genesis",
    profile,
    event,
  };
  const validated = validateCandidateGenesisManifestV3(manifest);
  if (!validated.ok) throw new Error(`candidate_genesis_invalid:${validated.reason}`);
  return validated.value;
}

/** Build an approval-bound activation packet without writing it or opening a gate. */
export function buildActivationManifestV3(
  input: BuildActivationManifestV3Input,
): ActivationManifestV3 {
  const candidate = validateCandidateGenesisManifestV3(input.candidate);
  if (!candidate.ok) throw new Error(`candidate_genesis_invalid:${candidate.reason}`);
  const eventId = input.event_id ?? eventIdV3();
  const activationId = input.activation_id ?? activationIdV3();
  const candidateDigest = candidateManifestDigestV3(candidate.value);
  const genesisId = candidate.value.event.payload.genesis_id as `gex_${string}`;
  const scope = candidate.value.event.scope as {
    root_id: `root_${string}`;
    instance_id: `inst_${string}`;
  };
  const event = buildEventV3("ledger.activated", {
    event_id: eventId,
    producer: { ...input.producer, component: "recovery" },
    scope,
    links: { caused_by: [candidate.value.event.event_id] },
    provenance: controlProvenance("cutover.activation", scope.instance_id),
    observed_at: input.activation_approved_at,
    recorded_at: input.activation_approved_at,
    payload: {
      activation_id: activationId,
      genesis_id: genesisId,
      candidate_digest: candidateDigest,
      approval_record_id: input.approval_record_id,
      eligible_after_event_id: eventId,
      activated_at: input.activation_approved_at,
    },
  });
  const manifest: ActivationManifestV3 = {
    manifest_version: 1,
    kind: "activation",
    activation_id: activationId,
    genesis_id: genesisId,
    candidate_manifest_digest: candidateDigest,
    approval_record_id: input.approval_record_id,
    activation_approved_at: input.activation_approved_at,
    event,
  };
  const validated = validateActivationManifestV3(manifest, candidate.value);
  if (!validated.ok) throw new Error(`activation_invalid:${validated.reason}`);
  return validated.value;
}

/** Validate an in-memory candidate with the same strict rules as the live gate. */
export function validateCandidateGenesisManifestV3(
  value: unknown,
): ControlManifestValidationV3<CandidateGenesisManifestV3> {
  return parseGenesisManifestValue(value);
}

/** Validate an in-memory activation against one exact candidate packet. */
export function validateActivationManifestV3(
  value: unknown,
  candidate: CandidateGenesisManifestV3,
): ControlManifestValidationV3<ActivationManifestV3> {
  const validatedCandidate = validateCandidateGenesisManifestV3(candidate);
  if (!validatedCandidate.ok) return fail(`candidate_${validatedCandidate.reason}`);
  return parseActivationManifestValue(
    value,
    validatedCandidate.value,
    candidateManifestDigestV3(validatedCandidate.value),
  );
}

/**
 * Resolve the session/evidence gate from exact control-file and ledger-event pairs.
 * This function never repairs or creates state. Any ambiguity keeps the gate closed.
 */
/**
 * The live epoch's genesis id from the immutable manifest, or undefined when
 * no valid genesis is published. This is the cheap epoch-identity read the
 * writer fence uses: one small canonical file, never the event history.
 */
export function liveGenesisIdV3(coordRoot: string): `gex_${string}` | undefined {
  return genesisIdFromManifestV3(join(coordRoot, EVENT_V3_GENESIS_MANIFEST));
}

/** Same read for a caller that already holds the manifest path (the writer's drain). */
export function genesisIdFromManifestV3(genesisPath: string): `gex_${string}` | undefined {
  if (!existsSync(genesisPath)) return undefined;
  const genesis = readGenesisManifest(genesisPath);
  if (!genesis.ok) return undefined;
  const genesisId = genesis.value.event.payload.genesis_id;
  return typeof genesisId === "string" && genesisId.startsWith("gex_")
    ? (genesisId as `gex_${string}`)
    : undefined;
}

export function readEventV3ControlState(coordRoot: string): EventV3ControlState {
  const genesisPath = join(coordRoot, EVENT_V3_GENESIS_MANIFEST);
  const activationPath = join(coordRoot, EVENT_V3_ACTIVATION_MANIFEST);
  const hasGenesis = existsSync(genesisPath);
  const hasActivation = existsSync(activationPath);
  if (!hasGenesis && !hasActivation) {
    const ledger = readControlLedger(coordRoot);
    const hasUnboundControlEvent = ledger.events.some(
      ({ event }) =>
        event.event_type === "ledger.genesis" || event.event_type === "ledger.activated",
    );
    if (hasUnboundControlEvent) {
      return { state: "invalid", reason: "control_event_without_manifest" };
    }
    return { state: "closed", reason: "no_candidate" };
  }
  if (!hasGenesis) return { state: "invalid", reason: "activation_without_genesis_manifest" };

  const genesisResult = readGenesisManifest(genesisPath);
  if (!genesisResult.ok) return { state: "invalid", reason: genesisResult.reason };
  const genesis = genesisResult.value;
  const candidateDigest = candidateManifestDigestV3(genesis);
  const ledger = readControlLedger(coordRoot);
  if (!ledger.complete) {
    return { state: "invalid", reason: "ledger_integrity_failure" };
  }
  const genesisPair = exactEventPair(
    ledger.events.map((entry) => entry.event),
    genesis.event,
  );
  if (genesisPair === "conflict") return { state: "invalid", reason: "genesis_event_mismatch" };
  if (genesisPair === "missing") {
    return hasActivation
      ? { state: "invalid", reason: "activation_before_genesis_event" }
      : { state: "repairable", reason: "genesis_event_missing", genesis };
  }
  if (!hasActivation) {
    if (ledger.events.some(({ event }) => event.event_type === "ledger.activated")) {
      return { state: "invalid", reason: "activation_event_without_manifest" };
    }
    return { state: "candidate", genesis, candidate_manifest_digest: candidateDigest };
  }

  const activationResult = readActivationManifest(activationPath, genesis, candidateDigest);
  if (!activationResult.ok) return { state: "invalid", reason: activationResult.reason };
  const activation = activationResult.value;
  const activationPair = exactEventPair(
    ledger.events.map((entry) => entry.event),
    activation.event,
  );
  if (activationPair === "conflict") {
    return { state: "invalid", reason: "activation_event_mismatch" };
  }
  if (activationPair === "missing") {
    return {
      state: "repairable",
      reason: "activation_event_missing",
      genesis,
      activation,
    };
  }
  return {
    state: "active",
    genesis,
    activation,
    candidate_manifest_digest: candidateDigest,
  };
}

export function eventV3WriteGateOpen(coordRoot: string, mode: EventV3WriteMode): boolean {
  const control = readEventV3ControlState(coordRoot);
  return mode === "candidate" ? control.state === "candidate" : control.state === "active";
}

export function candidateProfileDigestV3(profile: CandidateProfileV3): `sha256:${string}` {
  return sha256V3(canonicalJsonV3(profile));
}

export function candidateManifestDigestV3(
  manifest: CandidateGenesisManifestV3,
): `sha256:${string}` {
  return sha256V3(canonicalJsonV3(manifest));
}

function readGenesisManifest(path: string): ParseResult<CandidateGenesisManifestV3> {
  const parsed = readJsonObject(path);
  if (!parsed.ok) return parsed;
  return parseGenesisManifestValue(parsed.value);
}

function parseGenesisManifestValue(value: unknown): ParseResult<CandidateGenesisManifestV3> {
  if (!isObject(value)) return fail("genesis_manifest_not_object");
  if (!exactKeys(value, ["event", "kind", "manifest_version", "profile"])) {
    return fail("genesis_manifest_shape_invalid");
  }
  if (value.manifest_version !== 1 || value.kind !== "candidate_genesis") {
    return fail("genesis_manifest_version_invalid");
  }
  const profile = parseCandidateProfile(value.profile);
  if (!profile.ok) return profile;
  const validation = validateEventV3(value.event);
  if (!validation.ok || validation.event?.event_type !== "ledger.genesis") {
    return fail("genesis_event_invalid");
  }
  const event = validation.event as GenesisEventV3;
  if (event.producer.sequence !== 1) {
    return fail("genesis_producer_sequence_invalid");
  }
  if (
    event.contract.schema_digest !== EVENT_V3_SCHEMA_DIGEST ||
    event.payload.genesis_profile_digest !== candidateProfileDigestV3(profile.value) ||
    event.payload.contract_digest !== profile.value.contract_source_digest ||
    event.payload.generated_schema_digest !== profile.value.initial_schema_digest ||
    event.payload.canonicalizer !== profile.value.canonicalizer_version ||
    event.payload.privacy_epoch_id !== profile.value.privacy_key_epoch ||
    event.payload.candidate_created_at !== profile.value.candidate_created_at
  ) {
    return fail("genesis_profile_binding_mismatch");
  }
  return {
    ok: true,
    value: { manifest_version: 1, kind: "candidate_genesis", profile: profile.value, event },
  };
}

function readActivationManifest(
  path: string,
  genesis: CandidateGenesisManifestV3,
  candidateDigest: `sha256:${string}`,
): ParseResult<ActivationManifestV3> {
  const parsed = readJsonObject(path);
  if (!parsed.ok) return parsed;
  return parseActivationManifestValue(parsed.value, genesis, candidateDigest);
}

function parseActivationManifestValue(
  value: unknown,
  genesis: CandidateGenesisManifestV3,
  candidateDigest: `sha256:${string}`,
): ParseResult<ActivationManifestV3> {
  if (!isObject(value)) return fail("activation_manifest_not_object");
  if (
    !exactKeys(value, [
      "activation_approved_at",
      "activation_id",
      "approval_record_id",
      "candidate_manifest_digest",
      "event",
      "genesis_id",
      "kind",
      "manifest_version",
    ])
  ) {
    return fail("activation_manifest_shape_invalid");
  }
  if (value.manifest_version !== 1 || value.kind !== "activation") {
    return fail("activation_manifest_version_invalid");
  }
  const activationId =
    typeof value.activation_id === "string" && /^act_[0-9a-f-]{36}$/.test(value.activation_id)
      ? value.activation_id
      : undefined;
  const genesisId = safeString(value.genesis_id, "gex_");
  const approvalRecordId = safeToken(value.approval_record_id);
  const approvedAt = safeTimestamp(value.activation_approved_at);
  if (!activationId || !genesisId || !approvalRecordId || !approvedAt) {
    return fail("activation_manifest_fields_invalid");
  }
  if (value.candidate_manifest_digest !== candidateDigest) {
    return fail("activation_candidate_digest_mismatch");
  }
  const validation = validateEventV3(value.event);
  if (!validation.ok || validation.event?.event_type !== "ledger.activated") {
    return fail("activation_event_invalid");
  }
  const event = validation.event as ActivationEventV3;
  if (!activationProducerSequenceValid(genesis.event, event)) {
    return fail("activation_producer_sequence_invalid");
  }
  if (
    genesisId !== genesis.event.payload.genesis_id ||
    event.payload.activation_id !== activationId ||
    event.payload.genesis_id !== genesisId ||
    event.payload.candidate_digest !== candidateDigest ||
    event.payload.approval_record_id !== approvalRecordId ||
    event.payload.activated_at !== approvedAt
  ) {
    return fail("activation_profile_binding_mismatch");
  }
  return {
    ok: true,
    value: {
      manifest_version: 1,
      kind: "activation",
      activation_id: activationId as `act_${string}`,
      genesis_id: genesisId as `gex_${string}`,
      candidate_manifest_digest: candidateDigest,
      approval_record_id: approvalRecordId,
      activation_approved_at: approvedAt,
      event,
    },
  };
}

/** Mirror the reader's sequence key: a continuing boot advances, while a new boot starts at one. */
function activationProducerSequenceValid(
  genesis: GenesisEventV3,
  activation: ActivationEventV3,
): boolean {
  const sameBoot =
    activation.producer.producer_id === genesis.producer.producer_id &&
    activation.producer.boot_id === genesis.producer.boot_id;
  return sameBoot
    ? activation.producer.sequence === genesis.producer.sequence + 1
    : activation.producer.sequence === 1;
}

function parseCandidateProfile(value: unknown): ParseResult<CandidateProfileV3> {
  if (!isObject(value)) return fail("genesis_profile_invalid");
  const keys = [
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
  if (!exactKeys(value, keys)) return fail("genesis_profile_shape_invalid");
  if (
    isSha256(value.initial_schema_digest) &&
    value.initial_schema_digest !== EVENT_V3_SCHEMA_DIGEST
  ) {
    return fail("genesis_schema_digest_incompatible");
  }
  if (
    !isSha256(value.initial_schema_digest) ||
    !isSha256(value.contract_source_digest) ||
    !isSha256(value.config_digest) ||
    value.canonicalizer_version !== "harnery-jcs-nfc-v1" ||
    !safeString(value.privacy_key_epoch, "pep_") ||
    !safeToken(value.harnery_commit) ||
    !safeToken(value.host_repository_commit) ||
    !safeToken(value.fingerprint_version) ||
    !safeTimestamp(value.candidate_created_at) ||
    !sortedSafeTokenArray(value.producer_build_ids) ||
    !sortedSha256Array(value.adapter_capability_profile_digests)
  ) {
    return fail("genesis_profile_fields_invalid");
  }
  return { ok: true, value: value as unknown as CandidateProfileV3 };
}

function exactEventPair(events: EventV3[], expected: EventV3): "exact" | "missing" | "conflict" {
  const matches = events.filter((event) => event.event_id === expected.event_id);
  if (matches.length === 0) return "missing";
  const expectedRow = canonicalJsonV3(expected);
  return matches.every((event) => canonicalJsonV3(event) === expectedRow) ? "exact" : "conflict";
}

function readControlLedger(coordRoot: string): ReadLedgerV3Result {
  const ledger = readLedgerV3(coordRoot);
  // An immutable manifest is published before its pre-minted control event.
  // During that repairable window an empty physical ledger necessarily reports
  // missing_genesis; the control pair owns that one diagnostic and repairs it.
  const diagnostics = ledger.diagnostics.filter(({ code }) => code !== "missing_genesis");
  return { ...ledger, diagnostics, complete: diagnostics.length === 0 };
}

type ParseResult<T> = ControlManifestValidationV3<T>;

function controlProvenance(sourceEvent: string, subjectInstanceId: `inst_${string}`) {
  return {
    source_event: sourceEvent,
    attestation: "operator" as const,
    confidence: "exact" as const,
    attribution: {
      method: "explicit_argument" as const,
      state: "verified" as const,
      subject_instance_id: subjectInstanceId,
    },
  };
}

function readJsonObject(path: string): ParseResult<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(value) ? { ok: true, value } : fail("control_manifest_not_object");
  } catch {
    return fail("control_manifest_unreadable");
  }
}

function fail<T>(reason: string): ParseResult<T> {
  return { ok: false, reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(value)
    ? value
    : undefined;
}

function safeString(value: unknown, prefix: string): string | undefined {
  return typeof value === "string" && value.startsWith(prefix) && value.length <= 128
    ? value
    : undefined;
}

function safeTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    ? value
    : undefined;
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function sortedSafeTokenArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 64 &&
    value.every((item, index) => index === 0 || value[index - 1]! < item) &&
    value.every((item) => safeToken(item) !== undefined)
  );
}

function sortedSha256Array(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 64 &&
    value.every((item, index) => index === 0 || value[index - 1]! < item) &&
    value.every(isSha256)
  );
}
