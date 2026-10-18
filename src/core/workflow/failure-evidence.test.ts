import { describe, expect, test } from "bun:test";
import {
  canRetryFailedSpawn,
  failureEvidenceAllowsUncharged,
  observeSpawnFailure,
  resolveFailureEvidence,
  unknownFailureEvidence,
} from "./failure-evidence.ts";
import type { SpawnFailureEvidence } from "./types.ts";

describe("failure evidence authority", () => {
  test("status and absent output leave effects unknown and do not authorize retry", () => {
    const evidence = observeSpawnFailure({}, "", "stdout");
    expect(evidence.effect).toEqual({ state: "unknown" });
    expect(evidence.partial_output).toEqual({ state: "absent", source: "stdout" });
    expect(failureEvidenceAllowsUncharged(evidence)).toBe(false);
    expect(
      canRetryFailedSpawn({
        ok: false,
        text: "",
        durationMs: 1,
        class: "upstream",
        failureEvidence: evidence,
      }),
    ).toBe(false);
  });

  test("genuinely unstarted ENOENT stays uncharged and is not redispatched", () => {
    const evidence = observeSpawnFailure({ spawnErrno: "ENOENT", stdout: "" }, "", "stdout");
    expect(evidence.effect).toEqual({
      state: "none",
      source: "spawn_errno",
      reference: "ENOENT",
    });
    expect(failureEvidenceAllowsUncharged(evidence)).toBe(true);
    expect(
      canRetryFailedSpawn({
        ok: false,
        text: "",
        durationMs: 1,
        class: "environment",
        failureEvidence: evidence,
      }),
    ).toBe(false);
  });

  test("contradictory timeout or another output channel prevents an ENOENT no-effect claim", () => {
    for (const raw of [
      { spawnErrno: "ENOENT", timedOut: true },
      { spawnErrno: "ENOENT", stdout: "partial work" },
      { spawnErrno: "ENOENT", resultFileText: "partial work" },
    ]) {
      expect(observeSpawnFailure(raw, "", "stdout").effect.state).toBe("unknown");
    }
  });

  test("ordinary refusal prose is preserved output, not native refusal authority", () => {
    const evidence = observeSpawnFailure({}, "I cannot carry out this request.", "final_message");
    expect(evidence.refusal.state).toBe("unknown");
    expect(evidence.effect.state).toBe("unknown");
    expect(evidence.partial_output).toMatchObject({ state: "present", source: "final_message" });
    expect(failureEvidenceAllowsUncharged(evidence)).toBe(false);
  });

  test("partial or unknown output prevents free work even beside a no-effect claim", () => {
    for (const observed of [
      observeSpawnFailure({}, "Completed part of the request.", "final_message"),
      unknownFailureEvidence(),
    ]) {
      const evidence: SpawnFailureEvidence = {
        ...observed,
        effect: { state: "none", source: "adapter_evidence", reference: "fixture:no-effects" },
      };
      expect(failureEvidenceAllowsUncharged(evidence)).toBe(false);
      expect(
        canRetryFailedSpawn({ ok: false, text: "", durationMs: 1, failureEvidence: evidence }),
      ).toBe(false);
    }
  });

  test("a declared refusal dominates even contradictory positive no-effect evidence", () => {
    // A contract fixture, not a captured provider event.
    const evidence: SpawnFailureEvidence = {
      effect: { state: "none", source: "adapter_evidence", reference: "fixture:pre-dispatch" },
      refusal: { state: "refused", source: "vendor_envelope", reference: "fixture:refusal" },
      partial_output: { state: "unknown" },
    };
    expect(failureEvidenceAllowsUncharged(evidence)).toBe(false);
    expect(
      canRetryFailedSpawn({ ok: false, text: "", durationMs: 1, failureEvidence: evidence }),
    ).toBe(false);
  });

  test("positive evidence requires its declared source and reference", () => {
    const base = unknownFailureEvidence();
    for (const effect of [
      { state: "none" },
      { state: "none", source: "adapter_evidence" },
      { state: "none", source: "adapter_evidence", reference: " " },
      { state: "none", source: "spawn_errno", reference: "EACCES" },
      { state: "none", source: "http_status", reference: "503" },
    ]) {
      expect(() => resolveFailureEvidence({ ...base, effect })).toThrow(/invalid/);
    }
    expect(() =>
      resolveFailureEvidence({ ...base, refusal: { state: "refused", source: "vendor_envelope" } }),
    ).toThrow(/invalid/);
    expect(resolveFailureEvidence(undefined)).toEqual(base);
  });

  test("a documented custom-adapter positive signal remains eligible without inferring one", () => {
    // The fixture spawner explicitly supplies this contract; no built-in vendor
    // normalizer produces adapter_evidence from a status or an empty response.
    const evidence: SpawnFailureEvidence = {
      effect: { state: "none", source: "adapter_evidence", reference: "fixture:before-dispatch" },
      refusal: { state: "unknown" },
      partial_output: { state: "absent", source: "stdout" },
    };
    expect(failureEvidenceAllowsUncharged(evidence)).toBe(true);
    expect(
      canRetryFailedSpawn({
        ok: false,
        text: "",
        durationMs: 1,
        class: "upstream",
        failureEvidence: evidence,
      }),
    ).toBe(true);
  });
});
