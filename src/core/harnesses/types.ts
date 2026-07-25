import type { Spawner, SpawnRequest, SpawnResult } from "../workflow/types.ts";

/** Open harness identifier. Built-ins are registered at runtime rather than
 * repeated through closed unions in every consumer. */
export type HarnessId = string;

export type CapabilitySupport = "supported" | "partial" | "unsupported" | "unknown";

export const HARNESS_CAPABILITY_DIMENSIONS = [
  "invocation",
  "modelSelection",
  "effortSelection",
  "maxTurns",
  "finalResult",
  "sessionId",
  "cost",
  "toolEvidence",
  "policyMapping",
  "filesystemPolicyProjection",
  "interruption",
  "streaming",
  "steering",
  "resume",
  "images",
  "contextTelemetry",
  "preCompactionSignal",
  "postCompactionSignal",
  "compaction",
] as const;

export type HarnessCapabilityDimension = (typeof HARNESS_CAPABILITY_DIMENSIONS)[number];

export interface CapabilityClaim {
  support: CapabilitySupport;
  /** Operational qualification. Required for partial/unknown claims and useful
   * whenever "supported" has a narrower meaning than the vendor CLI itself. */
  note?: string;
}

export type HarnessCapabilities = Record<HarnessCapabilityDimension, CapabilityClaim>;

/** What one harness can represent of a filesystem-policy projection
 * (ADR 0039). `null` means the harness does not distinguish that, which is a
 * fact about the harness rather than something to paper over: a projection the
 * adapter would silently drop must be refused instead. */
export interface HarnessSandboxProjection {
  /** Native representation per canonical mode, or null when unrepresentable. */
  modes: Record<"read-only" | "workspace-write", string | null>;
  /** Whether the harness accepts an explicit writable-root set. */
  writableRoots: boolean;
}

export interface HarnessProfile {
  id: HarnessId;
  displayName: string;
  binary: string;
  installHint: string;
  loginHint: string;
  apiKeyEnv: string;
  integrationMode: "cli-subprocess";
  authModel: "own-auth";
  modelFamily: "claude" | "gpt" | "multi";
  effortValues: readonly string[];
  capabilities: HarnessCapabilities;
  /** The last real vendor CLI contract used to validate this declaration. */
  verified?: { date: string; version: string };
  /** How this adapter projects host filesystem policy into the vendor's own
   * sandbox (ADR 0039). Absent means it cannot project any of it. */
  sandboxProjection?: HarnessSandboxProjection;
}

/** Fully planned child invocation. `resultFile` is used by adapters such as
 * Codex that deliver the authoritative final answer out-of-band. */
export interface HarnessInvocation {
  argv: string[];
  resultFile?: string;
}

/** Vendor subprocess material passed through an adapter's normalizer. */
export interface HarnessRawResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  resultFileText?: string;
  /** The host killed this child for exceeding its timeout. A vendor CLI that
   * handles the signal cleanly still exits 0, so exit code alone cannot tell a
   * kill from a finish; without this a timed-out child reads as a success with
   * an empty answer. */
  timedOut?: boolean;
  /** The `code` from a spawn-level failure, e.g. "ENOENT" when the vendor
   * binary is absent. Adapters spawn the binary directly, so a missing binary
   * surfaces here; a normalizer can then classify it as an environment failure
   * (run never started) rather than a work failure. Absent on ordinary exit. */
  spawnErrno?: string;
}

export interface HarnessBenchFixture {
  raw: HarnessRawResult;
  expected: Pick<SpawnResult, "ok" | "text"> & {
    sessionId?: string;
    costUsd?: number;
  };
}

/** One registered executable adapter. The same planner and normalizer power
 * production workflow runs and the offline conformance bench, preventing the
 * bench from testing a parallel mock implementation. */
export interface HarnessAdapter {
  profile: HarnessProfile;
  spawn: Spawner;
  buildInvocation: (request: SpawnRequest, resultFile?: string) => HarnessInvocation;
  normalizeResult: (raw: HarnessRawResult) => SpawnResult;
  fixture: HarnessBenchFixture;
}
