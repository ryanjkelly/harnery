import type { Adapter } from "../../adapter.ts";

export const PROMPT_CONTEXT_REQUEST_SCHEMA = "harnery.prompt-context-request/v1" as const;
export const PROMPT_CONTEXT_RESULT_SCHEMA = "harnery.prompt-context-result/v1" as const;

export const DEFAULT_PROMPT_CONTEXT_TIMEOUT_MS = 15_000;
export const DEFAULT_PROMPT_CONTEXT_MAX_OUTPUT_BYTES = 65_536;
export const MAX_PROMPT_CONTEXT_TIMEOUT_MS = 120_000;
export const MAX_PROMPT_CONTEXT_OUTPUT_BYTES = 4 * 1024 * 1024;

const MAX_PROVIDER_ID_CHARS = 100;
const MAX_REASON_CODES = 32;
const MAX_REASON_CODE_CHARS = 80;

export type PromptContextDelivery = "direct" | "consume" | "unsupported";

export interface PromptContextConfig {
  enabled: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface PromptContextRequestV1 {
  schema: typeof PROMPT_CONTEXT_REQUEST_SCHEMA;
  event: "user_prompt_submit";
  adapter: Adapter;
  session_id: string;
  turn_id: string;
  cwd: string;
  prompt: string;
}

export interface PromptContextResultV1 {
  schema: typeof PROMPT_CONTEXT_RESULT_SCHEMA;
  provider_id: string;
  context: string;
  matched: number;
  succeeded: number;
  failed: number;
  reason_codes: string[];
}

export interface PromptContextAuditV1 {
  provider_id?: string;
  status:
    | "disabled"
    | "no_prompt"
    | "missing_extension"
    | "timeout"
    | "signal"
    | "nonzero_exit"
    | "invalid_result"
    | "oversized_result"
    | "empty"
    | "delivered"
    | "staged";
  delivery: PromptContextDelivery;
  elapsed_ms: number;
  matched?: number;
  succeeded?: number;
  failed?: number;
  reason_codes?: string[];
  output_bytes?: number;
  context_fingerprint?: string;
}

export type PromptContextResultValidation =
  | { ok: true; value: PromptContextResultV1 }
  | { ok: false; reason: string };

const DELIVERY_BY_ADAPTER: Readonly<Record<Adapter, PromptContextDelivery>> = {
  "claude-code": "direct",
  codex: "direct",
  cursor: "consume",
};

export function promptContextDelivery(adapter: Adapter): PromptContextDelivery {
  return DELIVERY_BY_ADAPTER[adapter] ?? "unsupported";
}

export function parsePromptContextConfig(value: unknown): PromptContextConfig | null {
  if (value === undefined) {
    return {
      enabled: false,
      timeoutMs: DEFAULT_PROMPT_CONTEXT_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_PROMPT_CONTEXT_MAX_OUTPUT_BYTES,
    };
  }
  if (!isRecord(value) || typeof value.enabled !== "boolean") return null;

  const timeoutMs = value.timeoutMs ?? DEFAULT_PROMPT_CONTEXT_TIMEOUT_MS;
  const maxOutputBytes = value.maxOutputBytes ?? DEFAULT_PROMPT_CONTEXT_MAX_OUTPUT_BYTES;
  if (!isBoundedInteger(timeoutMs, 1, MAX_PROMPT_CONTEXT_TIMEOUT_MS)) return null;
  if (!isBoundedInteger(maxOutputBytes, 1, MAX_PROMPT_CONTEXT_OUTPUT_BYTES)) return null;

  return { enabled: value.enabled, timeoutMs, maxOutputBytes };
}

export function buildPromptContextRequest(input: {
  adapter: Adapter;
  sessionId: string;
  turnId: string;
  cwd: string;
  prompt: string;
}): PromptContextRequestV1 {
  return {
    schema: PROMPT_CONTEXT_REQUEST_SCHEMA,
    event: "user_prompt_submit",
    adapter: input.adapter,
    session_id: input.sessionId,
    turn_id: input.turnId,
    cwd: input.cwd,
    prompt: input.prompt,
  };
}

export function validatePromptContextResult(value: unknown): PromptContextResultValidation {
  if (!isRecord(value)) return invalid("result_not_object");
  if (value.schema !== PROMPT_CONTEXT_RESULT_SCHEMA) return invalid("unsupported_schema");
  if (
    typeof value.provider_id !== "string" ||
    value.provider_id.length === 0 ||
    value.provider_id.length > MAX_PROVIDER_ID_CHARS ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value.provider_id)
  ) {
    return invalid("invalid_provider_id");
  }
  if (typeof value.context !== "string") return invalid("invalid_context");
  if (!isCount(value.matched) || !isCount(value.succeeded) || !isCount(value.failed)) {
    return invalid("invalid_counts");
  }
  if (value.succeeded + value.failed !== value.matched) return invalid("count_mismatch");
  if (value.succeeded === 0 && value.context.length > 0) return invalid("context_without_success");
  if (value.succeeded > 0 && value.context.length === 0) return invalid("success_without_context");
  if (!Array.isArray(value.reason_codes) || value.reason_codes.length > MAX_REASON_CODES) {
    return invalid("invalid_reason_codes");
  }
  if (
    value.reason_codes.some(
      (code) =>
        typeof code !== "string" ||
        code.length === 0 ||
        code.length > MAX_REASON_CODE_CHARS ||
        !/^[a-z0-9][a-z0-9._-]*$/.test(code),
    )
  ) {
    return invalid("invalid_reason_code");
  }

  return {
    ok: true,
    value: {
      schema: PROMPT_CONTEXT_RESULT_SCHEMA,
      provider_id: value.provider_id,
      context: value.context,
      matched: value.matched,
      succeeded: value.succeeded,
      failed: value.failed,
      reason_codes: [...value.reason_codes],
    },
  };
}

function invalid(reason: string): PromptContextResultValidation {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
