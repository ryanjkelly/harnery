/**
 * The opt-in live probe that produces an attestation (ADR 0038).
 *
 * One bounded turn per harness, through the same `spawn` the workflow engine
 * uses, so what gets attested is the path production takes rather than a
 * parallel test rig.
 */

import type { SpawnResult } from "../workflow/types.ts";
import { probeFilesystemProjection } from "./attest-projection.ts";
import type { AttestableDimension, HarnessAttestation } from "./attestation.ts";
import {
  ATTESTATION_SCHEMA_VERSION,
  profileDigest,
  sealAttestation,
  writeAttestation,
} from "./attestation.ts";
import { probeBinaryVersion } from "./bench.ts";
import type { HarnessRegistry } from "./registry.ts";
import type { CapabilitySupport, HarnessId } from "./types.ts";

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

export interface HarnessAttestationResult {
  harness: HarnessId;
  outcome: AttestationOutcome;
  binaryVersion?: string;
  observations?: Partial<Record<AttestableDimension, CapabilitySupport>>;
  durationMs?: number;
  note: string;
}

export interface HarnessAttestationReport {
  generatedAt: string;
  harnesses: HarnessId[];
  results: HarnessAttestationResult[];
  recorded: number;
  /** True when at least one selected harness could not be attested, so a
   * caller can tell a partial sweep from a complete one. */
  incomplete: boolean;
}

export interface RunHarnessAttestationOptions {
  harnesses?: readonly string[];
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
  spawn?: (harness: HarnessId, prompt: string, timeoutMs: number) => Promise<SpawnResult>;
  /** Test seam. Defaults to writing under the coord root. */
  persist?: (record: HarnessAttestation) => void;
  /**
   * Also probe `filesystemPolicyProjection` (ADR 0041). Off by default because
   * it costs two extra turns per capable harness, against one for everything
   * else: the observation needs a control run to be readable at all.
   */
  projection?: boolean;
  /** Test seam for the projection probe. */
  probeProjection?: typeof probeFilesystemProjection;
  now?: () => Date;
}

export async function runHarnessAttestation(
  registry: HarnessRegistry,
  opts: RunHarnessAttestationOptions = {},
): Promise<HarnessAttestationReport> {
  const ids = opts.harnesses?.length ? [...opts.harnesses] : registry.ids();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ATTESTATION_TIMEOUT_MS;
  const cwd = opts.cwd ?? process.cwd();
  const subscriptionOnly = opts.subscriptionOnly === true;
  const versionProbe = opts.versionProbe ?? probeBinaryVersion;
  const now = opts.now ?? (() => new Date());
  const results: HarnessAttestationResult[] = [];

  for (const id of ids) {
    const adapter = registry.require(id);
    const binaryVersion = versionProbe(adapter.profile.binary);
    if (!binaryVersion) {
      results.push({
        harness: id,
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
        harness: id,
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
        harness: id,
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
      harness: id,
      binary_version: binaryVersion,
      profile_digest: profileDigest(adapter.profile),
      subscription_only: subscriptionOnly,
      observed_at: now().toISOString(),
      observations,
    });

    if (opts.persist) opts.persist(record);
    else writeAttestation(record, { coordRoot: opts.coordRoot });

    results.push({
      harness: id,
      outcome: "recorded",
      binaryVersion,
      observations,
      durationMs: result.durationMs,
      note: `observed on ${binaryVersion}${projectionNote}`,
    });
  }

  return {
    generatedAt: now().toISOString(),
    harnesses: ids,
    results,
    recorded: results.filter((row) => row.outcome === "recorded").length,
    incomplete: results.some((row) => row.outcome !== "recorded"),
  };
}
