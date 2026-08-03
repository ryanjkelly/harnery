/**
 * The opt-in live probe that produces an attestation (ADR 0038).
 *
 * One bounded turn per adapter, through the same `spawn` the workflow engine
 * uses, so what gets attested is the path production takes rather than a
 * parallel test rig.
 */

import type { SpawnResult } from "../workflow/types.ts";
import { probeFilesystemProjection } from "./attest-projection.ts";
import type { AdapterAttestation, AttestableDimension } from "./attestation.ts";
import {
  ATTESTATION_SCHEMA_VERSION,
  profileDigest,
  sealAttestation,
  writeAttestation,
} from "./attestation.ts";
import { probeBinaryVersion } from "./bench.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { AdapterId, CapabilitySupport } from "./types.ts";

/** Fixed and content-free, so nothing user-supplied can reach the record and
 * the turn stays as cheap as a turn can be. */
export const ATTESTATION_PROMPT = "Reply with the single word: ok";

export const DEFAULT_ATTESTATION_TIMEOUT_MS = 120_000;

/** Vendor failures arrive as whole console transcripts, banner and prompt echo
 * included. Reports are bounded evidence, so the reason is collapsed to one
 * short line and the echoed prompt is removed. */
const MAX_NOTE_REASON_CHARS = 200;

/** Keep the TAIL, not the head. A CLI prints its banner, config, and startup
 * warnings first and the reason it actually failed last, so truncating from the
 * front reliably preserves the noise and discards the answer. Learned the hard
 * way: a head-truncated note once surfaced a cosmetic startup warning while
 * hiding the real "out of credits" failure on the final line. */
function boundedReason(reason: string | undefined): string {
  if (!reason) return "no error reported";
  const collapsed = reason.split(ATTESTATION_PROMPT).join("<prompt>").replace(/\s+/g, " ").trim();
  if (!collapsed) return "no error reported";
  return collapsed.length > MAX_NOTE_REASON_CHARS
    ? `…${collapsed.slice(-MAX_NOTE_REASON_CHARS)}`
    : collapsed;
}

export type AttestationOutcome = "recorded" | "skipped" | "unreachable" | "failed";

export interface AdapterAttestationResult {
  adapter: AdapterId;
  outcome: AttestationOutcome;
  binaryVersion?: string;
  observations?: Partial<Record<AttestableDimension, CapabilitySupport>>;
  durationMs?: number;
  note: string;
}

export interface AdapterAttestationReport {
  generatedAt: string;
  adapters: AdapterId[];
  results: AdapterAttestationResult[];
  recorded: number;
  /** True when at least one selected adapter could not be attested, so a
   * caller can tell a partial sweep from a complete one. */
  incomplete: boolean;
}

export interface RunAdapterAttestationOptions {
  adapters?: readonly string[];
  timeoutMs?: number;
  cwd?: string;
  coordRoot?: string;
  /** Scrub API-key vars from the child so it can only use its stored login,
   * matching `workflow run --subscription-only`. The observation is recorded
   * against this mode, because a child that may fall back to an API key can
   * behave differently from one that may not. */
  subscriptionOnly?: boolean;
  /** Test seam and alternate host probe. A null version means unavailable. */
  versionProbe?: (binary: string) => string | null;
  /** Test seam. Defaults to the adapter's production spawner. */
  spawn?: (adapter: AdapterId, prompt: string, timeoutMs: number) => Promise<SpawnResult>;
  /** Test seam. Defaults to writing under the coord root. */
  persist?: (record: AdapterAttestation) => void;
  /**
   * Also probe `filesystemPolicyProjection` (ADR 0041). Off by default because
   * it costs two extra turns per capable adapter, against one for everything
   * else: the observation needs a control run to be readable at all.
   */
  projection?: boolean;
  /** Test seam for the projection probe. */
  probeProjection?: typeof probeFilesystemProjection;
  now?: () => Date;
}

export async function runAdapterAttestation(
  registry: AdapterRegistry,
  opts: RunAdapterAttestationOptions = {},
): Promise<AdapterAttestationReport> {
  const ids = opts.adapters?.length ? [...opts.adapters] : registry.ids();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ATTESTATION_TIMEOUT_MS;
  const cwd = opts.cwd ?? process.cwd();
  const subscriptionOnly = opts.subscriptionOnly === true;
  const versionProbe = opts.versionProbe ?? probeBinaryVersion;
  const now = opts.now ?? (() => new Date());
  const results: AdapterAttestationResult[] = [];

  for (const id of ids) {
    const adapter = registry.require(id);
    const binaryVersion = versionProbe(adapter.profile.binary);
    if (!binaryVersion) {
      results.push({
        adapter: id,
        outcome: "skipped",
        note: `${adapter.profile.binary} not found on PATH`,
      });
      continue;
    }

    let result: SpawnResult;
    try {
      result = opts.spawn
        ? await opts.spawn(id, ATTESTATION_PROMPT, timeoutMs)
        : await adapter.spawn({
            prompt: ATTESTATION_PROMPT,
            timeoutMs,
            maxTurns: 1,
            cwd,
            subscriptionOnly,
          });
    } catch (error) {
      results.push({
        adapter: id,
        outcome: "failed",
        binaryVersion,
        note: `probe threw: ${boundedReason((error as Error).message)}`,
      });
      continue;
    }

    // Prerequisite rule: an unreachable subject cannot evidence anything, so a
    // failed turn records nothing at all rather than a page of `unsupported`.
    if (!result.ok) {
      results.push({
        adapter: id,
        outcome: "unreachable",
        binaryVersion,
        durationMs: result.durationMs,
        note: `the probe turn did not complete (${boundedReason(result.error)}); nothing recorded`,
      });
      continue;
    }

    const observations: Partial<Record<AttestableDimension, CapabilitySupport>> = {
      invocation: "supported",
      finalResult: result.text.trim().length > 0 ? "supported" : "unsupported",
      sessionId: result.sessionId ? "supported" : "unsupported",
      cost: result.costUsd !== undefined ? "supported" : "unsupported",
    };

    let projectionNote = "";
    if (opts.projection) {
      const probe = opts.probeProjection ?? probeFilesystemProjection;
      const outcome = await probe(adapter, { timeoutMs, subscriptionOnly });
      // An inconclusive probe records nothing for the dimension, leaving the
      // declaration to stand on its own rather than dressing a non-observation
      // as an observation.
      if (outcome.observation !== "inconclusive") {
        observations.filesystemPolicyProjection = outcome.observation;
      }
      projectionNote = `; projection ${outcome.observation}: ${outcome.detail}`;
    }

    const record = sealAttestation({
      schema_version: ATTESTATION_SCHEMA_VERSION,
      adapter: id,
      binary_version: binaryVersion,
      profile_digest: profileDigest(adapter.profile),
      subscription_only: subscriptionOnly,
      observed_at: now().toISOString(),
      observations,
    });

    if (opts.persist) opts.persist(record);
    else writeAttestation(record, { coordRoot: opts.coordRoot });

    results.push({
      adapter: id,
      outcome: "recorded",
      binaryVersion,
      observations,
      durationMs: result.durationMs,
      note: `observed on ${binaryVersion}${projectionNote}`,
    });
  }

  return {
    generatedAt: now().toISOString(),
    adapters: ids,
    results,
    recorded: results.filter((row) => row.outcome === "recorded").length,
    incomplete: results.some((row) => row.outcome !== "recorded"),
  };
}
