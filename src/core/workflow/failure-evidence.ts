import { createHash } from "node:crypto";
import type { AdapterRawResult } from "../adapters/types.ts";
import type { SpawnFailureEvidence, SpawnOutputSource, SpawnResult } from "./types.ts";

export function unknownFailureEvidence(): SpawnFailureEvidence {
  return {
    effect: { state: "unknown" },
    refusal: { state: "unknown" },
    partial_output: { state: "unknown" },
  };
}

/** Built-in subprocess adapters observe output and process-start failures.
 * Their current vendor envelopes do not prove effects or native refusal.
 * In particular, blank output and 429/5xx statuses leave both unknown. */
export function observeSpawnFailure(
  raw: Pick<AdapterRawResult, "spawnErrno" | "timedOut"> &
    Partial<Pick<AdapterRawResult, "stdout" | "resultFileText">>,
  text: string,
  source: SpawnOutputSource,
): SpawnFailureEvidence {
  const bytes = Buffer.byteLength(text);
  return {
    effect:
      raw.spawnErrno === "ENOENT" &&
      !raw.timedOut &&
      bytes === 0 &&
      !raw.stdout?.trim() &&
      !raw.resultFileText?.trim()
        ? { state: "none", source: "spawn_errno", reference: "ENOENT" }
        : { state: "unknown" },
    refusal: { state: "unknown" },
    partial_output:
      bytes > 0
        ? {
            state: "present",
            source,
            bytes,
            sha256: createHash("sha256").update(text).digest("hex"),
          }
        : { state: "absent", source },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function reference(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

function validEffect(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.state === "unknown") return keys(value, ["state"]);
  if (!keys(value, ["state", "source", "reference"])) return false;
  if (value.state === "none" && value.source === "spawn_errno") {
    return value.reference === "ENOENT";
  }
  return (
    (value.state === "none" || value.state === "observed") &&
    value.source === "adapter_evidence" &&
    reference(value.reference)
  );
}

function validRefusal(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.state === "unknown") return keys(value, ["state"]);
  return (
    keys(value, ["state", "source", "reference"]) &&
    value.state === "refused" &&
    value.source === "vendor_envelope" &&
    reference(value.reference)
  );
}

function validOutput(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.state === "unknown") return keys(value, ["state"]);
  if (
    value.source !== "final_message" &&
    value.source !== "vendor_envelope" &&
    value.source !== "stdout"
  ) {
    return false;
  }
  if (value.state === "absent") return keys(value, ["state", "source"]);
  return (
    value.state === "present" &&
    keys(value, ["state", "source", "bytes", "sha256"]) &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) > 0 &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  );
}

export function isSpawnFailureEvidence(value: unknown): value is SpawnFailureEvidence {
  return (
    record(value) &&
    keys(value, ["effect", "refusal", "partial_output"]) &&
    validEffect(value.effect) &&
    validRefusal(value.refusal) &&
    validOutput(value.partial_output)
  );
}

/** Missing observations are unknown; malformed positive claims are rejected.
 * This is also used when reading persisted workflow proof. */
export function resolveFailureEvidence(value: unknown): SpawnFailureEvidence {
  if (value === undefined) return unknownFailureEvidence();
  if (!isSpawnFailureEvidence(value)) throw new Error("invalid spawn failure evidence");
  return value;
}

export function failureEvidenceAllowsUncharged(value: unknown): boolean {
  const evidence = resolveFailureEvidence(value);
  return (
    evidence.effect.state === "none" &&
    evidence.refusal.state !== "refused" &&
    evidence.partial_output.state === "absent"
  );
}

/** A provider retry requires positive no-effect evidence. A missing binary is
 * known not to have started, but retrying that unchanged environment cannot help. */
export function canRetryFailedSpawn(result: SpawnResult): boolean {
  return (
    !result.ok &&
    result.class !== "environment" &&
    failureEvidenceAllowsUncharged(result.failureEvidence)
  );
}
