/**
 * Durable record of what an installed vendor CLI was actually observed doing
 * (ADR 0038).
 *
 * The conformance bench proves Harnery's own planner and normalizer against a
 * committed fixture. That is an adapter check, not a vendor check
 * (ADR 0037). An attestation is the other half: one bounded live turn, its
 * observations, and the vendor version they were observed on.
 *
 * A record stores structural facts only. No prompt text, no completion text,
 * no host paths. It lives under the host's coordination directory and is never
 * published.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { monorepoRoot } from "../agents/coord-client.ts";
import { stableDigest } from "../workflow/durable-record.ts";
import type { AdapterId, AdapterProfile, CapabilitySupport } from "./types.ts";

export const ATTESTATION_SCHEMA_VERSION = 2;

/** Dimensions one minimal live turn can honestly establish. Everything else
 * needs a purpose-built scenario and stays outside the record rather than
 * being guessed at. */
export const ATTESTABLE_DIMENSIONS = [
  "invocation",
  "finalResult",
  "sessionId",
  "cost",
  "filesystemPolicyProjection",
] as const;

export type AttestableDimension = (typeof ATTESTABLE_DIMENSIONS)[number];

export interface AdapterAttestation {
  schema_version: number;
  adapter: AdapterId;
  /** What the vendor binary reported when this was recorded. Staleness is
   * keyed on this, so a vendor upgrade invalidates the record automatically. */
  binary_version: string;
  /** Digest of the capability declaration at record time, so an edited
   * declaration also invalidates the record. */
  profile_digest: string;
  /** The billing policy the probe ran under. A child launched with API keys
   * scrubbed can behave differently from one that can fall back to them, so an
   * observation only speaks for the mode it was made in. */
  subscription_only: boolean;
  observed_at: string;
  /** Only what the probe actually saw. A dimension absent from this map was
   * not observed, which is not the same as unsupported. */
  observations: Partial<Record<AttestableDimension, CapabilitySupport>>;
  /** Over every field above. A hand-edited record fails to load. */
  record_digest: string;
}

export interface AttestationStoreOptions {
  /** Test seam and alternate host. Defaults to the resolved coord root. */
  coordRoot?: string;
}

export function attestationsDir(opts: AttestationStoreOptions = {}): string {
  const root = opts.coordRoot ?? monorepoRoot();
  if (!root) throw new Error("Not in a coord-aware repo (coord root resolved to null).");
  return resolve(root, ".harnery", "adapters", "attestations");
}

/** Stable identity of a declaration, so editing a claim invalidates the
 * attestation that was recorded against the old one. */
export function profileDigest(profile: AdapterProfile): string {
  return stableDigest({
    id: profile.id,
    binary: profile.binary,
    capabilities: profile.capabilities,
  });
}

function digestOf(record: Omit<AdapterAttestation, "record_digest">): string {
  return stableDigest(record);
}

export function sealAttestation(
  record: Omit<AdapterAttestation, "record_digest">,
): AdapterAttestation {
  return { ...record, record_digest: digestOf(record) };
}

function attestationPath(adapter: AdapterId, opts: AttestationStoreOptions): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(adapter)) {
    throw new Error(`unsafe adapter id for an attestation path: ${adapter}`);
  }
  return resolve(attestationsDir(opts), `${adapter}.json`);
}

/** Replace-in-place write. Unlike a workflow record an attestation is meant to
 * be re-recorded, so this is a mutable atomic swap rather than an immutable
 * create. */
export function writeAttestation(
  record: AdapterAttestation,
  opts: AttestationStoreOptions = {},
): string {
  const path = attestationPath(record.adapter, opts);
  mkdirSync(attestationsDir(opts), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temp file may never have been created; the original error wins.
    }
    throw error;
  }
  return path;
}

/** Null for absent, unreadable, malformed, wrong-schema, or tampered records.
 * A record that fails its own digest is discarded rather than trusted, because
 * the whole point of the file is that it was not hand-written. */
export function readAttestation(
  adapter: AdapterId,
  opts: AttestationStoreOptions = {},
): AdapterAttestation | null {
  let raw: string;
  try {
    raw = readFileSync(attestationPath(adapter, opts), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateAttestation(parsed, adapter);
}

export function validateAttestation(
  value: unknown,
  adapter?: AdapterId,
): AdapterAttestation | null {
  if (!value || typeof value !== "object") return null;
  const record = value as AdapterAttestation;
  if (record.schema_version !== ATTESTATION_SCHEMA_VERSION) return null;
  if (typeof record.adapter !== "string" || (adapter && record.adapter !== adapter)) return null;
  if (typeof record.binary_version !== "string" || typeof record.profile_digest !== "string") {
    return null;
  }
  if (typeof record.observed_at !== "string" || typeof record.record_digest !== "string")
    return null;
  if (!record.observations || typeof record.observations !== "object") return null;

  const { record_digest, ...body } = record;
  if (digestOf(body) !== record_digest) return null;
  return record;
}

/** An attestation speaks only for the vendor version and declaration it was
 * recorded against. */
export function isAttestationCurrent(
  record: AdapterAttestation | null,
  binaryVersion: string | null,
  profile: AdapterProfile,
  subscriptionOnly?: boolean,
): record is AdapterAttestation {
  if (!record || !binaryVersion) return false;
  if (record.binary_version !== binaryVersion) return false;
  if (subscriptionOnly !== undefined && record.subscription_only !== subscriptionOnly) return false;
  return record.profile_digest === profileDigest(profile);
}

export function listAttestations(opts: AttestationStoreOptions = {}): AdapterAttestation[] {
  let names: string[];
  try {
    names = readdirSync(attestationsDir(opts));
  } catch {
    return [];
  }
  const records: AdapterAttestation[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readAttestation(name.slice(0, -".json".length), opts);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.adapter.localeCompare(b.adapter));
}

/** Both adapter-derived proof inputs, read once, for a workflow run
 * (ADR 0038). Callers inject the result so the engine performs no capability
 * lookups of its own. A adapter with no current attestation simply has no
 * citation; that absence is not a proof unknown. */
export function adapterProofInputs(
  profiles: readonly AdapterProfile[],
  opts: AttestationStoreOptions & {
    versionProbe: (binary: string) => string | null;
    /** Billing policy this run will use, so a record made under the other mode
     * is not cited as if it applied. */
    subscriptionOnly?: boolean;
  },
): {
  adapterEvidence: Record<string, { toolEvidence: AdapterProfile["capabilities"]["toolEvidence"] }>;
  adapterAttestations: Record<
    string,
    { binary_version: string; observed_at: string; record_digest: string }
  >;
} {
  const adapterEvidence: Record<
    string,
    { toolEvidence: AdapterProfile["capabilities"]["toolEvidence"] }
  > = {};
  const adapterAttestations: Record<
    string,
    { binary_version: string; observed_at: string; record_digest: string }
  > = {};

  for (const profile of profiles) {
    adapterEvidence[profile.id] = { toolEvidence: profile.capabilities.toolEvidence };
    let record: AdapterAttestation | null = null;
    try {
      record = readAttestation(profile.id, opts);
    } catch {
      // No coord root or unreadable store: run unattested rather than fail.
      continue;
    }
    if (
      !isAttestationCurrent(
        record,
        opts.versionProbe(profile.binary),
        profile,
        opts.subscriptionOnly,
      )
    ) {
      continue;
    }
    adapterAttestations[profile.id] = {
      binary_version: record.binary_version,
      observed_at: record.observed_at,
      record_digest: record.record_digest,
    };
  }
  return { adapterEvidence, adapterAttestations };
}
