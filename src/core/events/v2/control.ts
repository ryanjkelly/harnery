import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJsonV2, sha256V2 } from "./canonical.ts";
import type { EventV2 } from "./contract.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "./generated.ts";
import { type ReadLedgerV2Result, readActiveLedgerV2, readLedgerV2 } from "./reader.ts";
import { validateEventV2 } from "./validate.ts";
import { eventV2Paths, writeEventV2 } from "./writer.ts";

export const EVENT_V2_GENESIS_MANIFEST = ".harnery/ledgers/v2/genesis.json" as const;
export const EVENT_V2_ACTIVATION_MANIFEST = ".harnery/ledgers/v2/activation.json" as const;

type GenesisEventV2 = Extract<EventV2, { event_type: "ledger.genesis" }>;
type ActivationEventV2 = Extract<EventV2, { event_type: "ledger.activated" }>;

export interface CandidateProfileV2 {
  initial_schema_digest: `sha256:${string}`;
  harnery_commit: string;
  host_repository_commit: string;
  producer_build_ids: string[];
  adapter_capability_profile_digests: string[];
  config_digest: `sha256:${string}`;
  canonicalizer_version: "harnery-jcs-nfc-v1";
  fingerprint_version: string;
  privacy_key_epoch: `pep_${string}`;
  v1_terminal_digest: `sha256:${string}`;
  v1_terminal_bytes: number;
  v1_terminal_rows: number;
  candidate_created_at: string;
}

export interface CandidateGenesisManifestV2 {
  manifest_version: 1;
  kind: "candidate_genesis";
  profile: CandidateProfileV2;
  event: GenesisEventV2;
}

export interface ActivationManifestV2 {
  manifest_version: 1;
  kind: "activation";
  activation_id: `act_${string}`;
  genesis_id: `gex_${string}`;
  candidate_manifest_digest: `sha256:${string}`;
  approval_record_id: string;
  activation_approved_at: string;
  event: ActivationEventV2;
}

export type EventV2ControlState =
  | { state: "closed"; reason: "no_candidate" }
  | {
      state: "repairable";
      reason: "genesis_event_missing" | "activation_event_missing";
      genesis: CandidateGenesisManifestV2;
      activation?: ActivationManifestV2;
    }
  | {
      state: "candidate";
      genesis: CandidateGenesisManifestV2;
      candidate_manifest_digest: `sha256:${string}`;
    }
  | {
      state: "active";
      genesis: CandidateGenesisManifestV2;
      activation: ActivationManifestV2;
      candidate_manifest_digest: `sha256:${string}`;
    }
  | { state: "invalid"; reason: string };

export type EventV2WriteMode = "candidate" | "active";

/**
 * Resolve the session/evidence gate from exact control-file and ledger-event pairs.
 * This function never repairs or creates state. Any ambiguity keeps the gate closed.
 */
export function readEventV2ControlState(coordRoot: string): EventV2ControlState {
  const genesisPath = join(coordRoot, EVENT_V2_GENESIS_MANIFEST);
  const activationPath = join(coordRoot, EVENT_V2_ACTIVATION_MANIFEST);
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
  const candidateDigest = candidateManifestDigestV2(genesis);
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

export function eventV2WriteGateOpen(coordRoot: string, mode: EventV2WriteMode): boolean {
  const control = readEventV2ControlState(coordRoot);
  return mode === "candidate" ? control.state === "candidate" : control.state === "active";
}

/** Repair only a manifest-first crash by appending the exact pre-minted event. */
export function repairEventV2ControlPair(coordRoot: string): EventV2ControlState {
  const control = readEventV2ControlState(coordRoot);
  if (control.state !== "repairable") return control;
  const event =
    control.reason === "genesis_event_missing" ? control.genesis.event : control.activation?.event;
  if (!event) return { state: "invalid", reason: "repair_event_unavailable" };
  const result = writeEventV2(coordRoot, event);
  if (result.state !== "committed") {
    return { state: "invalid", reason: "control_event_repair_not_committed" };
  }
  return readEventV2ControlState(coordRoot);
}

export function candidateProfileDigestV2(profile: CandidateProfileV2): `sha256:${string}` {
  return sha256V2(canonicalJsonV2(profile));
}

export function candidateManifestDigestV2(
  manifest: CandidateGenesisManifestV2,
): `sha256:${string}` {
  return sha256V2(canonicalJsonV2(manifest));
}

function readGenesisManifest(path: string): ParseResult<CandidateGenesisManifestV2> {
  const parsed = readJsonObject(path);
  if (!parsed.ok) return parsed;
  if (!exactKeys(parsed.value, ["event", "kind", "manifest_version", "profile"])) {
    return fail("genesis_manifest_shape_invalid");
  }
  if (parsed.value.manifest_version !== 1 || parsed.value.kind !== "candidate_genesis") {
    return fail("genesis_manifest_version_invalid");
  }
  const profile = parseCandidateProfile(parsed.value.profile);
  if (!profile.ok) return profile;
  const validation = validateEventV2(parsed.value.event);
  if (!validation.ok || validation.event?.event_type !== "ledger.genesis") {
    return fail("genesis_event_invalid");
  }
  const event = validation.event as GenesisEventV2;
  if (
    event.contract.schema_digest !== EVENT_V2_SCHEMA_DIGEST ||
    event.payload.genesis_profile_digest !== candidateProfileDigestV2(profile.value) ||
    event.payload.generated_schema_digest !== profile.value.initial_schema_digest ||
    event.payload.v1_terminal_segment_digest !== profile.value.v1_terminal_digest ||
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
  genesis: CandidateGenesisManifestV2,
  candidateDigest: `sha256:${string}`,
): ParseResult<ActivationManifestV2> {
  const parsed = readJsonObject(path);
  if (!parsed.ok) return parsed;
  if (
    !exactKeys(parsed.value, [
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
  if (parsed.value.manifest_version !== 1 || parsed.value.kind !== "activation") {
    return fail("activation_manifest_version_invalid");
  }
  const activationId =
    typeof parsed.value.activation_id === "string" &&
    /^act_[0-9a-f-]{36}$/.test(parsed.value.activation_id)
      ? parsed.value.activation_id
      : undefined;
  const genesisId = safeString(parsed.value.genesis_id, "gex_");
  const approvalRecordId = safeToken(parsed.value.approval_record_id);
  const approvedAt = safeTimestamp(parsed.value.activation_approved_at);
  if (!activationId || !genesisId || !approvalRecordId || !approvedAt) {
    return fail("activation_manifest_fields_invalid");
  }
  if (parsed.value.candidate_manifest_digest !== candidateDigest) {
    return fail("activation_candidate_digest_mismatch");
  }
  const validation = validateEventV2(parsed.value.event);
  if (!validation.ok || validation.event?.event_type !== "ledger.activated") {
    return fail("activation_event_invalid");
  }
  const event = validation.event as ActivationEventV2;
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

function parseCandidateProfile(value: unknown): ParseResult<CandidateProfileV2> {
  if (!isObject(value)) return fail("genesis_profile_invalid");
  const keys = [
    "adapter_capability_profile_digests",
    "candidate_created_at",
    "canonicalizer_version",
    "config_digest",
    "fingerprint_version",
    "harnery_commit",
    "host_repository_commit",
    "initial_schema_digest",
    "privacy_key_epoch",
    "producer_build_ids",
    "v1_terminal_bytes",
    "v1_terminal_digest",
    "v1_terminal_rows",
  ];
  if (!exactKeys(value, keys)) return fail("genesis_profile_shape_invalid");
  if (
    !isSha256(value.initial_schema_digest) ||
    !isSha256(value.config_digest) ||
    !isSha256(value.v1_terminal_digest) ||
    value.canonicalizer_version !== "harnery-jcs-nfc-v1" ||
    !safeString(value.privacy_key_epoch, "pep_") ||
    !safeToken(value.harnery_commit) ||
    !safeToken(value.host_repository_commit) ||
    !safeToken(value.fingerprint_version) ||
    !safeTimestamp(value.candidate_created_at) ||
    !safeTokenArray(value.producer_build_ids) ||
    !sha256Array(value.adapter_capability_profile_digests) ||
    !nonNegativeInteger(value.v1_terminal_bytes) ||
    !nonNegativeInteger(value.v1_terminal_rows)
  ) {
    return fail("genesis_profile_fields_invalid");
  }
  return { ok: true, value: value as unknown as CandidateProfileV2 };
}

function exactEventPair(events: EventV2[], expected: EventV2): "exact" | "missing" | "conflict" {
  const matches = events.filter((event) => event.event_id === expected.event_id);
  if (matches.length === 0) return "missing";
  const expectedRow = canonicalJsonV2(expected);
  return matches.every((event) => canonicalJsonV2(event) === expectedRow) ? "exact" : "conflict";
}

function readControlLedger(coordRoot: string): ReadLedgerV2Result {
  const paths = eventV2Paths(coordRoot);
  if (existsSync(paths.catalog)) return readLedgerV2(coordRoot);
  if (existsSync(paths.segments) && readdirSync(paths.segments).length > 0) {
    return {
      events: [],
      diagnostics: [{ code: "catalog_invalid", byte_offset: 0 }],
      complete: false,
      bytes: 0,
    };
  }
  return readActiveLedgerV2(coordRoot);
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

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

function safeTokenArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 64 &&
    new Set(value).size === value.length &&
    value.every((item) => safeToken(item) !== undefined)
  );
}

function sha256Array(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 64 &&
    new Set(value).size === value.length &&
    value.every(isSha256)
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
