import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import type { Adapter } from "../../../hooks/events/schema.ts";
import { buildEventV2 } from "../builder.ts";
import { type FingerprintContextV2, fingerprintV2, normalizeNativeIdV2 } from "../canonical.ts";
import { adapterSignalSupportV2 } from "../capabilities.ts";
import type { EventV2, RuntimeAttestationV2 } from "../contract.ts";
import { eventIdV2 } from "../ids.ts";
import { exactToolInputFingerprintV2, extractTargetsV2 } from "../targets.ts";

export type HookSignalV2 =
  | "session-start"
  | "session-end"
  | "user-prompt-submit"
  | "stop"
  | "stop-failure"
  | "pre-tool-use"
  | "post-tool-use"
  | "post-tool-use-failure"
  | "permission-request"
  | "sub-agent-start"
  | "sub-agent-stop"
  | "pre-compact"
  | "post-compact";

export interface HookProducerContextV2 {
  coordRoot: string;
  adapter: Adapter;
  adapterVersion?: string;
  harnessVersion?: string;
  root_id: `root_${string}`;
  instance_id: `inst_${string}`;
  generation_id: `gen_${string}`;
  attestation_id: `att_${string}`;
  producer_id: `prd_${string}`;
  boot_id: `boot_${string}`;
  sequence: number;
  build_id: `build_${string}`;
  platform: "linux" | "windows" | "macos" | "unknown";
  bridge?: "codex-wsl";
  capability_profile: `cap_${string}`;
  fingerprintContext: FingerprintContextV2;
  turn_native_id?: string;
  turn_id?: `tid_${string}`;
  span_id?: `span_${string}`;
  caused_by?: `evt_${string}`[];
  event_id?: `evt_${string}`;
  observed_at?: string;
  recorded_at?: string;
  monotonic_ns?: string;
  clock_id?: `clk_${string}`;
  duration_ms?: number;
  tool_call_count?: number;
  response_bytes?: number;
  delegation_id?: `del_${string}`;
  child_generation_id?: `gen_${string}`;
  agent_role?: string;
}

/** Normalize one already-parsed hook payload directly into V2 without retaining its raw fields. */
export function normalizeHookEventV2(
  signal: HookSignalV2,
  payload: ParsedPayload,
  context: HookProducerContextV2,
): EventV2 | null {
  const eventId = context.event_id ?? eventIdV2();
  const sessionNative =
    payload.session_id ?? payload.conversation_id ?? payload.agent_id ?? context.instance_id;
  const sessionId = asSessionId(
    normalizeNativeIdV2(context.fingerprintContext, `${context.adapter}.session`, sessionNative),
  );
  const turnNative =
    payload.turn_id ?? context.turn_native_id ?? `${sessionNative}:${context.sequence}`;
  // A native payload turn id outranks the producer-state stamp: a lost or late
  // user-prompt-submit hook must not mis-attribute this event to a stale turn
  // (ADR 0078 turn attribution).
  const turnId = payload.turn_id
    ? asTurnId(
        normalizeNativeIdV2(context.fingerprintContext, `${context.adapter}.turn`, payload.turn_id),
      )
    : (context.turn_id ??
      asTurnId(
        normalizeNativeIdV2(context.fingerprintContext, `${context.adapter}.turn`, turnNative),
      ));
  const generationScope = {
    root_id: context.root_id,
    instance_id: context.instance_id,
    session_id: sessionId,
    generation_id: context.generation_id,
  };
  const turnScope = { ...generationScope, turn_id: turnId };
  const producer = {
    producer_id: context.producer_id,
    boot_id: context.boot_id,
    sequence: context.sequence,
    component: "agent-hook" as const,
    build_id: context.build_id,
    platform: context.platform,
    ...(context.bridge ? { bridge: context.bridge } : {}),
  };
  const provenance = {
    source_event: `${context.adapter}.${signal}`,
    attestation: "native" as const,
    confidence: "exact" as const,
    ...(payload.tool_use_id
      ? {
          source_record_id: asSourceId(
            normalizeNativeIdV2(
              context.fingerprintContext,
              `${context.adapter}.source-record`,
              payload.tool_use_id,
            ),
          ),
        }
      : {}),
    attribution: {
      method: "native_payload" as const,
      state: "verified" as const,
      subject_instance_id: context.instance_id,
    },
  };
  const common = {
    event_id: eventId,
    producer,
    attestation_id: context.attestation_id,
    provenance,
    observed_at: context.observed_at,
    recorded_at: context.recorded_at,
    monotonic_ns: context.monotonic_ns,
    clock_id: context.clock_id,
  };
  const causedBy = context.caused_by ?? [];

  switch (signal) {
    case "session-start": {
      const runtimeAttestation: RuntimeAttestationV2 = {
        attestation_id: context.attestation_id,
        generation_id: context.generation_id,
        adapter: observedIdentity(context.adapter, context.adapterVersion),
        harness: observedIdentity(context.adapter, context.harnessVersion),
        model: payload.model
          ? {
              state: "observed",
              value: { provider: providerFor(context.adapter), id: safeModelId(payload.model) },
              attestation: "native",
              confidence: "exact",
            }
          : { state: "expected_but_missing", capability: "model_identity", reason: "not_reported" },
        capability_profile: context.capability_profile,
        declared_by_event_id: eventId,
      };
      return buildEventV2("session.started", {
        ...common,
        scope: generationScope,
        links: { caused_by: causedBy },
        payload: {
          runtime_attestation: runtimeAttestation,
          resume:
            payload.source === "resume"
              ? { state: "unknown", reason: "prior_generation_not_bound" }
              : { state: "not_applicable" },
        },
      }) as EventV2;
    }
    case "session-end":
      return buildEventV2("session.ended", {
        ...common,
        scope: generationScope,
        links: { caused_by: causedBy },
        payload: {
          outcome:
            payload.clean_exit === true
              ? "succeeded"
              : payload.clean_exit === false
                ? "failed"
                : "unknown",
          authority: "native",
          reason:
            payload.clean_exit === true
              ? "native_clean_exit"
              : payload.clean_exit === false
                ? "native_unclean_exit"
                : "native_exit_outcome_unknown",
          completeness: { state: "unknown", reason: "terminal_signal_coverage_unmeasured" },
        },
      }) as EventV2;
    case "user-prompt-submit": {
      const prompt = payload.prompt ?? "";
      return buildEventV2("turn.started", {
        ...common,
        scope: turnScope,
        links: { caused_by: causedBy },
        payload: {
          input: {
            storage: "omitted",
            media_type: "text/plain",
            bytes: Buffer.byteLength(prompt, "utf8"),
            fingerprint: fingerprintV2(context.fingerprintContext, "user-prompt", prompt),
          },
          intent_kind: "unknown",
        },
      }) as EventV2;
    }
    case "stop":
    case "stop-failure":
      return buildEventV2("turn.completed", {
        ...common,
        scope: turnScope,
        links: { caused_by: causedBy },
        payload: {
          outcome: signal === "stop" ? "succeeded" : "failed",
          duration_ms: measuredOrMissing(
            context.duration_ms,
            "turn_duration",
            "turn_timing_not_supplied",
          ),
          tool_call_count: measuredOrMissing(
            context.tool_call_count,
            "turn_tool_call_count",
            "turn_aggregate_not_supplied",
          ),
          response:
            context.response_bytes === undefined
              ? { state: "unsupported", capability: "turn_response_descriptor" }
              : {
                  state: "observed",
                  value: {
                    storage: "omitted",
                    media_type: "text/plain",
                    bytes: context.response_bytes,
                  },
                  attestation: "derived",
                  confidence: "exact",
                },
        },
      }) as EventV2;
    case "pre-tool-use": {
      if (!payload.tool_name || !context.span_id) return null;
      const toolInput = payload.tool_input ?? null;
      return buildEventV2("tool.requested", {
        ...common,
        scope: turnScope,
        links: { caused_by: causedBy, span_id: context.span_id },
        payload: {
          tool: { namespace: context.adapter, name: safeToolName(payload.tool_name) },
          input: {
            storage: "omitted",
            media_type: "application/json",
            bytes: byteLengthOfUnknown(toolInput),
          },
          exact_input: exactToolInputFingerprintV2(
            context.fingerprintContext,
            context.adapter,
            payload.tool_name,
            toolInput,
          ),
          targets: extractTargetsV2({
            coordRoot: context.coordRoot,
            toolNamespace: context.adapter,
            toolName: payload.tool_name,
            toolInput,
            fingerprintContext: context.fingerprintContext,
          }),
        },
      }) as EventV2;
    }
    case "post-tool-use":
    case "post-tool-use-failure": {
      if (!payload.tool_name || !context.span_id) return null;
      return buildEventV2("tool.completed", {
        ...common,
        scope: turnScope,
        links: { caused_by: causedBy, span_id: context.span_id },
        payload: {
          tool: { namespace: context.adapter, name: safeToolName(payload.tool_name) },
          outcome: signal === "post-tool-use" ? "succeeded" : "failed",
          duration_ms: measuredOrMissing(
            context.duration_ms,
            "tool_duration",
            "span_timing_not_supplied",
          ),
          result: {
            storage: "omitted",
            media_type:
              typeof payload.tool_response === "string" ? "text/plain" : "application/json",
            bytes: byteLengthOfUnknown(payload.tool_response ?? null),
          },
          ...(signal === "post-tool-use-failure"
            ? { error: { class: "adapter_tool_failure" } }
            : {}),
        },
      }) as EventV2;
    }
    case "permission-request": {
      const waitNative = payload.tool_use_id ?? `${sessionNative}:${context.sequence}`;
      const waitId = normalizeNativeIdV2(
        context.fingerprintContext,
        `${context.adapter}.wait`,
        waitNative,
      );
      return buildEventV2("interaction.wait_started", {
        ...common,
        scope: turnScope,
        links: { caused_by: causedBy },
        payload: { wait_id: waitId, kind: "permission" },
      }) as EventV2;
    }
    case "sub-agent-start": {
      if (!context.delegation_id || !context.child_generation_id) return null;
      return buildEventV2("agent.started", {
        ...common,
        scope: generationScope,
        links: {
          caused_by: causedBy,
          delegation_id: context.delegation_id,
          parent_generation_id: context.generation_id,
        },
        payload: {
          delegation_id: context.delegation_id,
          child_generation_id: context.child_generation_id,
          role: safeToken(context.agent_role ?? "agent", "agent"),
        },
      }) as EventV2;
    }
    case "sub-agent-stop": {
      if (!context.delegation_id || !context.child_generation_id) return null;
      return buildEventV2("agent.completed", {
        ...common,
        scope: generationScope,
        links: {
          caused_by: causedBy,
          delegation_id: context.delegation_id,
          parent_generation_id: context.generation_id,
        },
        payload: {
          delegation_id: context.delegation_id,
          child_generation_id: context.child_generation_id,
          outcome:
            payload.exit_status === "ok"
              ? "succeeded"
              : payload.exit_status === "interrupted"
                ? "interrupted"
                : payload.exit_status
                  ? "failed"
                  : "unknown",
        },
      }) as EventV2;
    }
    case "pre-compact":
      return buildEventV2("context.compaction_started", {
        ...common,
        scope: generationScope,
        links: { caused_by: causedBy },
        payload: {
          before: contextMeasurement(
            inputContextMeasurement(payload, "before"),
            context,
            "pre_compaction",
          ),
          method: `${context.adapter.replaceAll("-", "_")}_hook`,
        },
      }) as EventV2;
    case "post-compact":
      return buildEventV2("context.compaction_completed", {
        ...common,
        scope: generationScope,
        links: { caused_by: causedBy },
        payload: {
          outcome: "succeeded",
          before: contextMeasurement(
            inputContextMeasurement(payload, "before"),
            context,
            "pre_compaction",
          ),
          after: contextMeasurement(
            inputContextMeasurement(payload, "after"),
            context,
            "post_compaction",
          ),
        },
      }) as EventV2;
  }
}

function inputContextMeasurement(payload: ParsedPayload, phase: "before" | "after") {
  const metadata = plainRecord(payload.raw.compact_metadata);
  const usedKeys =
    phase === "before"
      ? ["pre_tokens", "pre_compact_tokens", "used_tokens"]
      : ["post_tokens", "post_compact_tokens", "used_tokens"];
  const limitKeys = [
    "context_window_size",
    "context_window_tokens",
    "window_tokens",
    "limit_tokens",
  ];
  return {
    used: firstNumber(payload.raw, metadata, usedKeys),
    limit: firstNumber(payload.raw, metadata, limitKeys),
  };
}

function contextMeasurement(
  measurement: { used?: number; limit?: number },
  context: HookProducerContextV2,
  capability: "pre_compaction" | "post_compaction",
) {
  if (adapterSignalSupportV2(context.adapter, capability) === "unsupported") {
    return { state: "unsupported", capability } as const;
  }
  if (measurement.used === undefined || measurement.limit === undefined || measurement.limit < 1) {
    return {
      state: "expected_but_missing",
      capability,
      reason: "context_measurement_incomplete",
    } as const;
  }
  return {
    state: "observed",
    value: {
      used_tokens: Math.floor(measurement.used),
      limit_tokens: Math.floor(measurement.limit),
      remaining_tokens: Math.max(0, Math.floor(measurement.limit - measurement.used)),
      measured_at: context.observed_at ?? context.recorded_at ?? new Date().toISOString(),
      method: `${context.adapter.replaceAll("-", "_")}_hook`,
    },
    attestation: "native",
    confidence: "exact",
  } as const;
}

function firstNumber(
  primary: Record<string, unknown>,
  secondary: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    for (const source of [primary, secondary]) {
      const value = source?.[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
  }
  return undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : undefined;
}

function observedIdentity(id: string, version: string | undefined) {
  return {
    state: "observed" as const,
    value: { id, ...(version ? { version } : {}) },
    attestation: "native" as const,
    confidence: "exact" as const,
  };
}

function providerFor(adapter: Adapter): string {
  if (adapter === "claude-code") return "anthropic";
  if (adapter === "codex") return "openai";
  return "cursor";
}

function safeModelId(value: string): string {
  return safeToken(value, "unknown-model");
}

function safeToolName(value: string): string {
  return safeToken(value, "unknown-tool");
}

function safeToken(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[^a-zA-Z0-9._:/+-]/g, "_")
    .slice(0, 128);
  return /^[a-zA-Z0-9]/.test(normalized) ? normalized : fallback;
}

function byteLengthOfUnknown(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}

function measuredOrMissing(value: number | undefined, capability: string, reason: string) {
  return value === undefined
    ? ({ state: "expected_but_missing", capability, reason } as const)
    : ({ state: "observed", value, attestation: "derived", confidence: "exact" } as const);
}

function asSessionId(value: `hid_${string}`): `sid_${string}` {
  return `sid_${value.slice(4)}`;
}

function asTurnId(value: `hid_${string}`): `tid_${string}` {
  return `tid_${value.slice(4)}`;
}

function asSourceId(value: `hid_${string}`): `hid_${string}` {
  return value;
}
