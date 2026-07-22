import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  NormalizedPolicy,
  PolicyEvaluation,
  PolicyIsolation,
  PolicyRequest,
  PolicyRequestSummary,
  PolicyRuleResult,
  PolicySpec,
  PolicyVerdict,
} from "./types.ts";
import { POLICY_SCHEMA_VERSION } from "./types.ts";

const VERDICTS = ["allow", "ask", "deny"] as const;
const ISOLATIONS = ["shared", "worktree", "sandbox", "remote"] as const;
const MAX_NAME = 200;
const MAX_FIELD = 500;
const MAX_LIST = 100;
const POLICY_FIELDS = new Set([
  "schema_version",
  "name",
  "max_cost_usd",
  "unknown_cost",
  "allowed_harnesses",
  "allowed_models",
  "allowed_paths",
  "network",
  "external_actions",
  "allowed_isolation",
]);

export class PolicyDeniedError extends Error {
  readonly decisionId: string;

  constructor(message: string, decisionId: string) {
    super(message);
    this.name = "PolicyDeniedError";
    this.decisionId = decisionId;
  }
}

export function normalizePolicy(
  input: PolicySpec,
  options: { baseDir?: string } = {},
): Readonly<NormalizedPolicy> {
  if (!isRecord(input)) throw new Error("policy must be an object");
  const unknownFields = Object.keys(input).filter((field) => !POLICY_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`policy contains unknown field(s): ${unknownFields.sort().join(", ")}`);
  }
  const schemaVersion = input.schema_version ?? POLICY_SCHEMA_VERSION;
  if (schemaVersion !== POLICY_SCHEMA_VERSION) {
    throw new Error(`unsupported policy schema_version ${JSON.stringify(schemaVersion)}`);
  }
  const baseDir = resolve(options.baseDir ?? process.cwd());
  const normalized: NormalizedPolicy = {
    schema_version: POLICY_SCHEMA_VERSION,
    name: boundedString(input.name ?? "workflow policy", "policy name", MAX_NAME),
    max_cost_usd: optionalMoney(input.max_cost_usd, "max_cost_usd"),
    unknown_cost: enumValue(input.unknown_cost ?? "deny", ["ask", "deny"], "unknown_cost"),
    allowed_harnesses: optionalStringList(input.allowed_harnesses, "allowed_harnesses"),
    allowed_models: optionalStringList(input.allowed_models, "allowed_models"),
    allowed_paths: optionalPathList(input.allowed_paths, baseDir),
    network: enumValue(input.network ?? "deny", VERDICTS, "network"),
    external_actions: enumValue(input.external_actions ?? "deny", VERDICTS, "external_actions"),
    allowed_isolation: optionalEnumList(input.allowed_isolation, ISOLATIONS, "allowed_isolation"),
  };
  return deepFreeze(normalized);
}

export function policyDigest(policy: NormalizedPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

export function evaluatePolicy(
  policy: Readonly<NormalizedPolicy>,
  rawRequest: PolicyRequest,
): PolicyEvaluation {
  const request = summarizePolicyRequest(rawRequest);
  const rules: PolicyRuleResult[] = [];
  const add = (code: string, verdict: PolicyVerdict, reason: string): void => {
    rules.push({ code, verdict, reason });
  };

  if (policy.allowed_harnesses && request.phase === "dispatch") {
    if (!request.harness || !policy.allowed_harnesses.includes(request.harness)) {
      add(
        "harness_not_allowed",
        "deny",
        `harness ${JSON.stringify(request.harness ?? "unknown")} is not allowed`,
      );
    }
  }
  if (policy.allowed_models && request.phase === "dispatch") {
    if (!request.model || !policy.allowed_models.includes(request.model)) {
      add(
        "model_not_allowed",
        "deny",
        `model ${JSON.stringify(request.model ?? "unknown")} is not allowed`,
      );
    }
  }
  if (policy.allowed_paths) {
    if (!request.path || !policy.allowed_paths.some((root) => contains(root, request.path!))) {
      add(
        "path_not_allowed",
        "deny",
        `path ${JSON.stringify(request.path ?? "unknown")} is outside the allowed roots`,
      );
    }
  }
  if (policy.allowed_isolation && !policy.allowed_isolation.includes(request.isolation)) {
    add(
      "isolation_not_allowed",
      "deny",
      `isolation ${JSON.stringify(request.isolation)} is not allowed`,
    );
  }
  if (request.network_access !== "disabled" && policy.network !== "allow") {
    add(
      request.network_access === "unknown" ? "network_unknown" : "network_restricted",
      policy.network,
      request.network_access === "unknown"
        ? "network access is unknown"
        : "network access requires policy authorization",
    );
  }
  if (request.phase === "external_mutation" && policy.external_actions !== "allow") {
    add(
      "external_action_restricted",
      policy.external_actions,
      "external mutation requires policy authorization",
    );
  }
  if (policy.max_cost_usd !== undefined && request.phase === "dispatch") {
    const current = request.current_cost_usd ?? 0;
    if (current >= policy.max_cost_usd) {
      add(
        "cost_budget_exhausted",
        "deny",
        `run cost $${current.toFixed(4)} has reached the $${policy.max_cost_usd.toFixed(4)} ceiling`,
      );
    } else if (request.projected_cost_usd === null || request.projected_cost_usd === undefined) {
      add(
        "dispatch_cost_unknown",
        policy.unknown_cost,
        `dispatch cost is unknown under a $${policy.max_cost_usd.toFixed(4)} ceiling`,
      );
    } else if (current + request.projected_cost_usd > policy.max_cost_usd) {
      add(
        "cost_budget_exceeded",
        "deny",
        `projected run cost $${(current + request.projected_cost_usd).toFixed(4)} exceeds the $${policy.max_cost_usd.toFixed(4)} ceiling`,
      );
    }
  }

  if (rules.length === 0) {
    rules.push({ code: "policy_allow", verdict: "allow", reason: "all configured rules allow" });
  }
  const verdict = rules.some((rule) => rule.verdict === "deny")
    ? "deny"
    : rules.some((rule) => rule.verdict === "ask")
      ? "ask"
      : "allow";
  const decisive = rules.filter((rule) => rule.verdict === verdict);
  return {
    verdict,
    reason: decisive.map((rule) => rule.reason).join("; "),
    rules,
  };
}

/** Bound and normalize the receipt-safe subset before it reaches a journal or proof. */
export function summarizePolicyRequest(input: PolicyRequest): PolicyRequestSummary {
  if (!isRecord(input)) throw new Error("policy request must be an object");
  const phase = enumValue(input.phase, ["dispatch", "external_mutation"], "policy phase");
  const isolation = enumValue(input.isolation, ISOLATIONS, "policy isolation");
  const networkAccess = enumValue(
    input.network_access,
    ["enabled", "disabled", "unknown"],
    "policy network_access",
  );
  return {
    phase,
    action: boundedString(input.action, "policy action", MAX_FIELD),
    path: optionalBounded(input.path, "policy path"),
    harness: optionalBounded(input.harness, "policy harness"),
    model: optionalBounded(input.model, "policy model"),
    effort: optionalBounded(input.effort, "policy effort"),
    max_attempts: optionalWholeNumber(input.max_attempts, "policy max_attempts", 1),
    max_turns: optionalWholeNumber(input.max_turns, "policy max_turns", 1),
    timeout_ms: optionalWholeNumber(input.timeout_ms, "policy timeout_ms", 1),
    prompt_bytes: optionalWholeNumber(input.prompt_bytes, "policy prompt_bytes", 0),
    isolation,
    network_access: networkAccess,
    service: optionalBounded(input.service, "policy service"),
    target: optionalBounded(safeTarget(input.target), "policy target"),
    current_cost_usd: optionalMoney(input.current_cost_usd, "current_cost_usd"),
    projected_cost_usd:
      input.projected_cost_usd === null
        ? null
        : optionalMoney(input.projected_cost_usd, "projected_cost_usd"),
  };
}

function contains(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function optionalPathList(value: unknown, baseDir: string): readonly string[] | undefined {
  const values = optionalStringList(value, "allowed_paths");
  if (!values) return undefined;
  return [...new Set(values.map((item) => resolve(baseDir, item)))].sort();
}

function optionalStringList(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST) {
    throw new Error(`${field} must be a non-empty array with at most ${MAX_LIST} entries`);
  }
  return [
    ...new Set(value.map((item, index) => boundedString(item, `${field}[${index}]`, MAX_FIELD))),
  ].sort();
}

function optionalEnumList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST) {
    throw new Error(`${field} must be a non-empty array with at most ${MAX_LIST} entries`);
  }
  return [...new Set(value.map((item) => enumValue(item, allowed, field)))].sort();
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${field} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function optionalMoney(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return value;
}

function optionalWholeNumber(value: unknown, field: string, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${field} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = withoutControls(value).replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function optionalBounded(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : boundedString(value, field, MAX_FIELD);
}

function safeTarget(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    const query = value.indexOf("?");
    const fragment = value.indexOf("#");
    const boundary = Math.min(
      query === -1 ? value.length : query,
      fragment === -1 ? value.length : fragment,
    );
    return value.slice(0, boundary);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutControls(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export type { PolicyIsolation };
