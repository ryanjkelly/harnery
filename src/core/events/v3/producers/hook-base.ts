import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import type { EventAdapterIdV3 } from "../adapter-id.ts";
import { buildEventV3Base } from "../base-builder.ts";
import type { EventV3Base, RuntimeAttestationV3Base } from "../base-contract.ts";
import { type FingerprintContextV3, fingerprintV3, normalizeNativeIdV3 } from "../canonical.ts";
import {
  adapterDurationSupportV3,
  adapterSignalSupportV3,
  adapterTurnWaitCountSupportV3,
  type CursorExecutionModeV3,
} from "../capabilities.ts";
import { eventIdV3 } from "../ids.ts";
import {
  effectiveRuntimeTelemetryCapabilitiesV3,
  type RuntimeTelemetryCapabilitiesV3,
} from "../runtime-telemetry-capabilities.ts";
import { exactToolInputFingerprintV3, extractTargetsV3 } from "../targets.ts";

export type HookSignalV3Base =
  | "session-start"
  | "session-end"
  | "user-prompt-submit"
  | "after-agent-response"
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

export interface HookProducerContextV3Base {
  coordRoot: string;
  adapter: EventAdapterIdV3;
  adapterVersion?: string;
  harnessVersion?: string;
  root_id: `root_${string}`;
  run_id?: `run_${string}`;
  workflow_id?: `wf_${string}`;
  workflow_agent_id?: string;
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
  cursor_mode?: CursorExecutionModeV3;
  fingerprintContext: FingerprintContextV3;
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
  tool_call_count_support?: "native" | "derived" | "conditional" | "unsupported";
  tool_call_count_missing_reason?: string;
  response_bytes?: number;
  delegation_id?: `del_${string}`;
  child_generation_id?: `gen_${string}`;
  agent_role?: string;
  stop_remediation?: boolean;
  turn_ritual?: TurnRitualEvidenceV3;
  /** Tuning read from a local runtime transcript by the recorder; hook-base
   * itself performs no I/O. */
  runtime_tuning?: RuntimeTuningContextV3;
  /** Effective telemetry evidence resolved by the recorder. When absent, the
   * session-start attestation records only what hook delivery can prove. */
  runtime_telemetry?: RuntimeTelemetryCapabilitiesV3;
}

export interface TurnRitualEvidenceV3 {
  status_box_present: boolean;
  status_box_present_strict: boolean;
  session_name_required: boolean;
  session_name_present: boolean;
}

type TurnRitualObservationV3 = NonNullable<
  Extract<EventV3Base, { event_type: "turn.completed" }>["payload"]["ritual"]
>;

/** Normalize one already-parsed hook payload directly into V3Base without retaining its raw fields. */
export function normalizeHookEventV3Base(
  signal: HookSignalV3Base,
  payload: ParsedPayload,
  context: HookProducerContextV3Base,
): EventV3Base | null {
  const eventId = context.event_id ?? eventIdV3();
  const sessionNative =
    payload.session_id ?? payload.conversation_id ?? payload.agent_id ?? context.instance_id;
  const sessionId = asSessionId(
    normalizeNativeIdV3(context.fingerprintContext, `${context.adapter}.session`, sessionNative),
  );
  const turnNative =
    payload.turn_id ?? context.turn_native_id ?? `${sessionNative}:${context.sequence}`;
  // A native payload turn id normally outranks the producer-state stamp: a
  // lost or late user-prompt-submit hook must not mis-attribute this event to
  // a stale turn (ADR 0078 turn attribution). Turn terminals are different:
  // Cursor can mint a new generation_id for Stop, so the producer's open turn
  // is the authoritative correlation target when one exists.
  const terminalTurnId =
    signal === "stop" || signal === "stop-failure" ? context.turn_id : undefined;
  const turnId = terminalTurnId
    ? terminalTurnId
    : payload.turn_id
      ? asTurnId(
          normalizeNativeIdV3(
            context.fingerprintContext,
            `${context.adapter}.turn`,
            payload.turn_id,
          ),
        )
      : (context.turn_id ??
        asTurnId(
          normalizeNativeIdV3(context.fingerprintContext, `${context.adapter}.turn`, turnNative),
        ));
  const generationScope = {
    root_id: context.root_id,
    instance_id: context.instance_id,
    session_id: sessionId,
    generation_id: context.generation_id,
    ...(context.run_id ? { run_id: context.run_id } : {}),
    ...(context.workflow_id ? { workflow_id: context.workflow_id } : {}),
    ...(context.workflow_agent_id ? { workflow_agent_id: context.workflow_agent_id } : {}),
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
            normalizeNativeIdV3(
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
      const runtimeAttestation: RuntimeAttestationV3Base = {
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
          : adapterSignalSupportV3(context.adapter, "model_identity") === "unsupported"
            ? { state: "unsupported", capability: "model_identity" }
            : {
                state: "expected_but_missing",
                capability: "model_identity",
                reason: "not_reported",
              },
        tuning: tuningObservation(context, payload),
        telemetry: context.runtime_telemetry ?? initialTelemetryCapabilities(context),
        capability_profile: context.capability_profile,
        declared_by_event_id: eventId,
      };
      return buildEventV3Base("session.started", {
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
      }) as EventV3Base;
    }
    case "session-end":
      return buildEventV3Base("session.ended", {
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
      }) as EventV3Base;
    case "user-prompt-submit": {
      const prompt = payload.prompt ?? "";
      return buildEventV3Base("turn.started", {
        ...common,
        scope: turnScope,
        links: { caused_by: causedBy },
        payload: {
          input: {
            storage: "omitted",
            media_type: "text/plain",
            bytes: Buffer.byteLength(prompt, "utf8"),
            fingerprint: fingerprintV3(context.fingerprintContext, "user-prompt", prompt),
          },
          intent_kind: "unknown",
          ...(context.stop_remediation ? { stop_remediation: true } : {}),
        },
      }) as EventV3Base;
    }
    case "after-agent-response":
      // Cursor's completed-response hook contributes a privacy-safe ritual
      // observation to producer state. The authoritative turn.completed event
      // remains the later Stop signal, which consumes that observation.
      return null;
    case "stop":
    case "stop-failure":
      return buildEventV3Base("turn.completed", {
        ...common,
        scope: turnScope,
        links: { caused_by: causedBy },
        payload: {
          outcome: signal === "stop" ? "succeeded" : "failed",
          duration_ms:
            adapterDurationSupportV3(context.adapter, "turn_duration") === "unsupported"
              ? { state: "unsupported", capability: "turn_duration" }
              : measuredOrMissing(context.duration_ms, "turn_duration", "turn_timing_not_supplied"),
          tool_call_count:
            context.tool_call_count_support === "unsupported"
              ? { state: "unsupported", capability: "turn_tool_call_count" }
              : measuredOrMissing(
                  context.tool_call_count,
                  "turn_tool_call_count",
                  context.tool_call_count_missing_reason ?? "turn_aggregate_not_supplied",
                ),
          wait_count:
            adapterTurnWaitCountSupportV3(context.adapter) === "unsupported"
              ? { state: "unsupported", capability: "turn_wait_count" }
              : measuredOrMissing(undefined, "turn_wait_count", "turn_wait_aggregate_not_supplied"),
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
          ...(context.turn_ritual
            ? { ritual: turnRitualObservation(context.adapter, context.turn_ritual) }
            : {}),
        },
      }) as EventV3Base;
    case "pre-tool-use": {
      if (!payload.tool_name || !context.span_id) return null;
      const toolInput = payload.tool_input ?? null;
      return buildEventV3Base("tool.requested", {
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
          exact_input: exactToolInputFingerprintV3(
            context.fingerprintContext,
            context.adapter,
            payload.tool_name,
            toolInput,
          ),
          targets: extractTargetsV3({
            coordRoot: context.coordRoot,
            toolNamespace: context.adapter,
            toolName: payload.tool_name,
            toolInput,
            fingerprintContext: context.fingerprintContext,
          }),
        },
      }) as EventV3Base;
    }
    case "post-tool-use":
    case "post-tool-use-failure": {
      if (!payload.tool_name || !context.span_id) return null;
      return buildEventV3Base("tool.completed", {
        ...common,
        scope: turnScope,
        links: { caused_by: causedBy, span_id: context.span_id },
        payload: {
          tool: { namespace: context.adapter, name: safeToolName(payload.tool_name) },
          outcome: signal === "post-tool-use" ? "succeeded" : "failed",
          duration_ms:
            adapterDurationSupportV3(context.adapter, "tool_duration") === "unsupported"
              ? { state: "unsupported", capability: "tool_duration" }
              : measuredOrMissing(context.duration_ms, "tool_duration", "span_timing_not_supplied"),
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
      }) as EventV3Base;
    }
    case "permission-request": {
      const waitNative = payload.tool_use_id ?? `${sessionNative}:${context.sequence}`;
      const waitId = normalizeNativeIdV3(
        context.fingerprintContext,
        `${context.adapter}.wait`,
        waitNative,
      );
      return buildEventV3Base("wait.started", {
        ...common,
        scope: turnScope,
        links: { caused_by: causedBy },
        payload: { wait_id: waitId, kind: "permission" },
      }) as EventV3Base;
    }
    case "sub-agent-start": {
      if (!context.delegation_id || !context.child_generation_id) return null;
      return buildEventV3Base("agent.started", {
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
      }) as EventV3Base;
    }
    case "sub-agent-stop": {
      if (!context.delegation_id || !context.child_generation_id) return null;
      return buildEventV3Base("agent.completed", {
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
      }) as EventV3Base;
    }
    case "pre-compact":
      return buildEventV3Base("context.compaction_started", {
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
      }) as EventV3Base;
    case "post-compact":
      return buildEventV3Base("context.compaction_completed", {
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
      }) as EventV3Base;
  }
}

function turnRitualObservation(
  adapter: EventAdapterIdV3,
  evidence: TurnRitualEvidenceV3,
): TurnRitualObservationV3 {
  if (adapter === "cursor") {
    const unsupported = { state: "unsupported" as const, capability: "assistant_reply_text" };
    const observed = <T>(value: T) => ({
      state: "observed" as const,
      value,
      attestation: "derived" as const,
      confidence: "exact" as const,
    });
    return {
      status_box_present: observed(evidence.status_box_present),
      status_box_present_strict: observed(evidence.status_box_present_strict),
      session_name: unsupported,
    };
  }
  const observed = <T>(value: T) => ({
    state: "observed" as const,
    value,
    attestation: "derived" as const,
    confidence: "exact" as const,
  });
  return {
    status_box_present: observed(evidence.status_box_present),
    status_box_present_strict: observed(evidence.status_box_present_strict),
    session_name: observed({
      required: evidence.session_name_required,
      present: evidence.session_name_present,
    }),
  };
}

function inputContextMeasurement(payload: ParsedPayload, phase: "before" | "after") {
  const metadata = plainRecord(payload.raw.compact_metadata);
  const usedKeys =
    phase === "before"
      ? ["pre_tokens", "pre_compact_tokens", "used_tokens", "context_tokens"]
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
  context: HookProducerContextV3Base,
  capability: "pre_compaction" | "post_compaction",
) {
  if (adapterSignalSupportV3(context.adapter, capability) === "unsupported") {
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

/** Cursor encodes tuning in its parameterized model ids (…-high-fast). Other
 * adapters do not, so absent tuning stays honest instead of being guessed. */
const MODEL_ID_EFFORT_TOKENS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export type RuntimeTuningObservationV3 = RuntimeAttestationV3Base["tuning"];

function initialTelemetryCapabilities(
  context: HookProducerContextV3Base,
): RuntimeTelemetryCapabilitiesV3 {
  return effectiveRuntimeTelemetryCapabilitiesV3({
    adapter: context.adapter,
    ...(context.cursor_mode ? { cursor_mode: context.cursor_mode } : {}),
    context:
      context.adapter === "cursor"
        ? { state: "unsupported" }
        : { state: "partial", reason: "context_source_not_ready" },
    canonical_turn_boundaries:
      adapterSignalSupportV3(context.adapter, "turn_completion") !== "unsupported",
  });
}

/** Recorder-supplied tuning read from a local runtime transcript. */
export interface RuntimeTuningContextV3 {
  effort?: string;
  speed?: string;
  attestation: "native" | "derived";
}

/**
 * Attest the runtime's tuning identity for one generation.
 *
 * Precedence: a recorder-read transcript observation, then the native payload
 * field (CC stamps `effort.level` on tool hooks and Stop, never on
 * SessionStart), then Cursor's model-id tokens. A payload/transcript source
 * that was READ but carried no effort is proof the model has no dial —
 * `unsupported` with capability `effort_selection` — while nothing-read-yet
 * stays `expected_but_missing` so a later attestation can still land.
 */
function tuningObservation(
  context: HookProducerContextV3Base,
  payload: ParsedPayload,
): RuntimeTuningObservationV3 {
  const read = context.runtime_tuning;
  if (read) {
    if (read.effort || read.speed) {
      return {
        state: "observed",
        value: {
          ...(read.effort ? { effort: safeToken(read.effort, "unknown-effort") } : {}),
          ...(read.speed ? { speed: safeToken(read.speed, "unknown-speed") } : {}),
        },
        attestation: read.attestation,
        confidence: "exact",
      };
    }
    return { state: "unsupported", capability: "effort_selection" };
  }
  if (payload.effort) {
    return {
      state: "observed",
      value: { effort: safeToken(payload.effort, "unknown-effort") },
      attestation: "native",
      confidence: "exact",
    };
  }
  if (context.adapter === "cursor" && payload.model) {
    const tokens = payload.model.toLowerCase().split("-");
    let effort: string | undefined;
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      const token = tokens[index];
      if (token && MODEL_ID_EFFORT_TOKENS.has(token)) {
        effort = token;
        break;
      }
    }
    const speed = tokens.includes("fast") ? "fast" : undefined;
    if (effort || speed) {
      return {
        state: "observed",
        value: { ...(effort ? { effort } : {}), ...(speed ? { speed } : {}) },
        attestation: "derived",
        confidence: "high",
      };
    }
  }
  return { state: "expected_but_missing", capability: "effort_selection", reason: "not_reported" };
}

function observedIdentity(id: string, version: string | undefined) {
  return {
    state: "observed" as const,
    value: { id, ...(version ? { version } : {}) },
    attestation: "native" as const,
    confidence: "exact" as const,
  };
}

function providerFor(adapter: EventAdapterIdV3): string {
  if (adapter === "claude-code") return "anthropic";
  if (adapter === "codex") return "openai";
  return adapter;
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
