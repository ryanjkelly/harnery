export const POLICY_SCHEMA_VERSION = 1 as const;

export type PolicyVerdict = "allow" | "ask" | "deny";
export type PolicyPhase = "dispatch" | "external_mutation";
export type PolicyIsolation = "shared" | "worktree" | "sandbox" | "remote";
export type PolicyNetworkAccess = "enabled" | "disabled" | "unknown";

/** Host-owned policy document. Workflow metadata cannot supply this value. */
export interface PolicySpec {
  schema_version?: typeof POLICY_SCHEMA_VERSION;
  name?: string;
  max_cost_usd?: number;
  /** Applied when a cost ceiling exists but the host cannot price a dispatch. */
  unknown_cost?: Exclude<PolicyVerdict, "allow">;
  allowed_harnesses?: readonly string[];
  allowed_models?: readonly string[];
  /** Absolute paths, or paths relative to the policy file. */
  allowed_paths?: readonly string[];
  network?: PolicyVerdict;
  external_actions?: PolicyVerdict;
  /** Allowed host-declared execution boundaries. No strength ordering is inferred. */
  allowed_isolation?: readonly PolicyIsolation[];
}

export interface NormalizedPolicy {
  schema_version: typeof POLICY_SCHEMA_VERSION;
  name: string;
  max_cost_usd?: number;
  unknown_cost: Exclude<PolicyVerdict, "allow">;
  allowed_harnesses?: readonly string[];
  allowed_models?: readonly string[];
  allowed_paths?: readonly string[];
  network: PolicyVerdict;
  external_actions: PolicyVerdict;
  allowed_isolation?: readonly PolicyIsolation[];
}

export interface PolicyRequest {
  phase: PolicyPhase;
  action: string;
  path?: string;
  harness?: string;
  model?: string;
  effort?: string;
  max_attempts?: number;
  max_turns?: number;
  timeout_ms?: number;
  /** Prompt size for host estimation. Prompt content is never included. */
  prompt_bytes?: number;
  isolation: PolicyIsolation;
  network_access: PolicyNetworkAccess;
  service?: string;
  target?: string;
  current_cost_usd?: number;
  projected_cost_usd?: number | null;
}

export type PolicyRequestSummary = PolicyRequest;

export interface PolicyRuleResult {
  code: string;
  verdict: PolicyVerdict;
  reason: string;
}

export interface PolicyEvaluation {
  verdict: PolicyVerdict;
  reason: string;
  rules: PolicyRuleResult[];
}

export interface PolicyAskResolution {
  verdict: "allow" | "deny";
  reason?: string;
}

export type PolicyAskResolver = (
  request: Readonly<PolicyRequestSummary>,
  evaluation: Readonly<PolicyEvaluation>,
) => Promise<PolicyAskResolution> | PolicyAskResolution;

export interface PolicyDecision {
  id: string;
  checked_at: string;
  policy: string;
  phase: PolicyPhase;
  initial_verdict: PolicyVerdict;
  verdict: "allow" | "deny";
  resolved_by: "policy" | "host" | "fail_closed";
  reason: string;
  rule_codes: string[];
  request: PolicyRequestSummary;
}

export interface ExternalMutationRequest {
  /** Short verb phrase, for example "publish release" or "write report". */
  action: string;
  path?: string;
  network?: boolean;
  service?: string;
  /** Bounded destination descriptor. Do not include credentials or payloads. */
  target?: string;
}

export type DispatchCostEstimator = (
  request: Readonly<PolicyRequestSummary>,
) => Promise<number | null> | number | null;
