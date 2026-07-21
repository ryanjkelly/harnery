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
  "interruption",
  "streaming",
  "steering",
  "resume",
  "images",
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
