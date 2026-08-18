import { buildEventV2 } from "../builder.ts";
import { type FingerprintContextV2, fingerprintV2, normalizeNativeIdV2 } from "../canonical.ts";
import type { EventV2 } from "../contract.ts";
import { eventIdV2 } from "../ids.ts";

export type CommandSignalV2 = "command.started" | "command.output_observed" | "command.completed";

export interface CommandProducerContextV2 {
  root_id: `root_${string}`;
  instance_id: `inst_${string}`;
  session_id: `sid_${string}`;
  generation_id: `gen_${string}`;
  turn_id: `tid_${string}`;
  attestation_id: `att_${string}`;
  producer_id: `prd_${string}`;
  boot_id: `boot_${string}`;
  sequence: number;
  build_id: `build_${string}`;
  platform: "linux" | "windows" | "macos" | "unknown";
  bridge?: "codex-wsl";
  span_id: `span_${string}`;
  parent_span_id?: `span_${string}`;
  caused_by?: `evt_${string}`[];
  event_id?: `evt_${string}`;
  observed_at?: string;
  recorded_at?: string;
  monotonic_ns?: string;
  clock_id?: `clk_${string}`;
  fingerprintContext: FingerprintContextV2;
  attribution_method: "session_env" | "heartbeat_match" | "explicit_argument";
}

export interface CommandObservationV2 {
  native_command_id: string;
  native_observation_id?: string;
  executable?: string;
  executable_class?: string;
  argv?: readonly string[];
  intent?: string;
  intent_kind?: string;
  sensitive_argument_count?: number;
  stream?: "stdout" | "stderr" | "combined";
  output?: unknown;
  output_bytes?: number;
  output_lines?: number;
  outcome?: "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted" | "unknown";
  exit_code?: number;
  signal?: string;
  duration_ms?: number;
  error_class?: string;
}

/** Translate one session-tee observation without retaining command, intent, or output literals. */
export function normalizeCommandEventV2(
  signal: CommandSignalV2,
  observation: CommandObservationV2,
  context: CommandProducerContextV2,
): EventV2 | null {
  const eventId = context.event_id ?? eventIdV2();
  const sourceRecordId = normalizeNativeIdV2(
    context.fingerprintContext,
    "session-tee.command-source",
    observation.native_command_id,
  );
  const producer = {
    producer_id: context.producer_id,
    boot_id: context.boot_id,
    sequence: context.sequence,
    component: "session-tee" as const,
    build_id: context.build_id,
    platform: context.platform,
    ...(context.bridge ? { bridge: context.bridge } : {}),
  };
  const scope = {
    root_id: context.root_id,
    instance_id: context.instance_id,
    session_id: context.session_id,
    generation_id: context.generation_id,
    turn_id: context.turn_id,
  };
  const provenance = {
    source_event: `session-tee.${signal}`,
    attestation: "derived" as const,
    confidence: "exact" as const,
    source_record_id: sourceRecordId,
    attribution: {
      method: context.attribution_method,
      state: "verified" as const,
      subject_instance_id: context.instance_id,
    },
  };
  const common = {
    event_id: eventId,
    producer,
    scope,
    attestation_id: context.attestation_id,
    provenance,
    observed_at: context.observed_at,
    recorded_at: context.recorded_at,
    monotonic_ns: context.monotonic_ns,
    clock_id: context.clock_id,
    links: {
      caused_by: context.caused_by ?? [],
      span_id: context.span_id,
      ...(context.parent_span_id ? { parent_span_id: context.parent_span_id } : {}),
    },
  };

  switch (signal) {
    case "command.started": {
      const argv = [...(observation.argv ?? [])];
      const intent = observation.intent?.normalize("NFC") ?? "";
      return buildEventV2("command.started", {
        ...common,
        payload: {
          executable: safeToken(observation.executable ?? argv[0] ?? "unknown", "unknown"),
          executable_class: safeToken(observation.executable_class ?? "cli", "cli"),
          exact_command: fingerprintV2(context.fingerprintContext, "exact-command", argv),
          intent_kind: safeToken(observation.intent_kind ?? "unknown", "unknown"),
          intent_length: Buffer.byteLength(intent, "utf8"),
          ...(intent
            ? { intent_fingerprint: fingerprintV2(context.fingerprintContext, "intent", intent) }
            : {}),
          sensitive_argument_count: safeCount(observation.sensitive_argument_count),
        },
      }) as EventV2;
    }
    case "command.output_observed": {
      const bytes =
        observation.output_bytes ??
        (observation.output === undefined ? 0 : byteLengthOfUnknown(observation.output));
      return buildEventV2("command.output_observed", {
        ...common,
        payload: {
          stream: observation.stream ?? "combined",
          bytes: safeCount(bytes),
          ...(observation.output_lines === undefined
            ? {}
            : { lines: safeCount(observation.output_lines) }),
          ...(observation.output === undefined
            ? {}
            : {
                content_fingerprint: fingerprintV2(
                  context.fingerprintContext,
                  "command.output_observed",
                  observation.output,
                ),
              }),
        },
      }) as EventV2;
    }
    case "command.completed": {
      const outcome = observation.outcome ?? outcomeFromExit(observation.exit_code);
      return buildEventV2("command.completed", {
        ...common,
        payload: {
          outcome,
          ...(observation.exit_code === undefined ? {} : { exit_code: observation.exit_code }),
          ...(observation.signal
            ? { signal: safeToken(observation.signal, "unknown_signal") }
            : {}),
          duration_ms: safeCount(observation.duration_ms),
          ...(observation.error_class
            ? { error_class: safeToken(observation.error_class, "command_error") }
            : {}),
        },
      }) as EventV2;
    }
  }
}

function outcomeFromExit(
  exitCode: number | undefined,
): NonNullable<CommandObservationV2["outcome"]> {
  if (exitCode === undefined) return "unknown";
  return exitCode === 0 ? "succeeded" : "failed";
}

function safeToken(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[^a-zA-Z0-9._:/+-]/g, "_")
    .slice(0, 128);
  return /^[a-zA-Z0-9]/.test(normalized) ? normalized : fallback;
}

function safeCount(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0;
}

function byteLengthOfUnknown(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}
