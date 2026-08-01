import type { Spawner, SpawnRequest, SpawnResult } from "../workflow/types.ts";

/** Open adapter identifier. Built-ins are registered at runtime rather than
 * repeated through closed unions in every consumer. */
export type AdapterId = string;

export type CapabilitySupport = "supported" | "partial" | "unsupported" | "unknown";

export const ADAPTER_CAPABILITY_DIMENSIONS = [
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

export type AdapterCapabilityDimension = (typeof ADAPTER_CAPABILITY_DIMENSIONS)[number];

export interface CapabilityClaim {
  support: CapabilitySupport;
  /** Operational qualification. Required for partial/unknown claims and useful
   * whenever "supported" has a narrower meaning than the vendor CLI itself. */
  note?: string;
}

export type AdapterCapabilities = Record<AdapterCapabilityDimension, CapabilityClaim>;

/** What one adapter can represent of a filesystem-policy projection
 * (ADR 0039). `null` means the adapter does not distinguish that, which is a
 * fact about the adapter rather than something to paper over: a projection the
 * adapter would silently drop must be refused instead. */
export interface AdapterSandboxProjection {
  /** Native representation per canonical mode, or null when unrepresentable. */
  modes: Record<"read-only" | "workspace-write", string | null>;
  /** Whether the adapter accepts an explicit writable-root set. */
  writableRoots: boolean;
}

export interface AdapterProfile {
  id: AdapterId;
  displayName: string;
  binary: string;
  installHint: string;
  loginHint: string;
  apiKeyEnv: string;
  integrationMode: "cli-subprocess";
  authModel: "own-auth";
  modelFamily: "claude" | "gpt" | "multi";
  effortValues: readonly string[];
  capabilities: AdapterCapabilities;
  /** The last real vendor CLI contract used to validate this declaration. */
  verified?: { date: string; version: string };
  /** How this adapter projects host filesystem policy into the vendor's own
   * sandbox (ADR 0039). Absent means it cannot project any of it. */
  sandboxProjection?: AdapterSandboxProjection;
}

/** Fully planned child invocation. `resultFile` is used by adapters such as
 * Codex that deliver the authoritative final answer out-of-band. */
export interface AdapterInvocation {
  argv: string[];
  resultFile?: string;
}

/** Vendor subprocess material passed through an adapter's normalizer. */
export interface AdapterRawResult {
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

export interface AdapterBenchFixture {
  raw: AdapterRawResult;
  expected: Pick<SpawnResult, "ok" | "text"> & {
    sessionId?: string;
    costUsd?: number;
  };
}

/** One registered executable adapter. The same planner and normalizer power
 * production workflow runs and the offline conformance bench, preventing the
 * bench from testing a parallel mock implementation. */
export interface Adapter {
  profile: AdapterProfile;
  spawn: Spawner;
  buildInvocation: (request: SpawnRequest, resultFile?: string) => AdapterInvocation;
  normalizeResult: (raw: AdapterRawResult) => SpawnResult;
  fixture: AdapterBenchFixture;
}
