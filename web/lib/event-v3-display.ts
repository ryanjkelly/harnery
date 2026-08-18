import type { EventRow } from "./coord-reader";

export type EventDisplayVariantV3 =
  | "muted"
  | "info"
  | "success"
  | "destructive"
  | "warning"
  | "accent"
  | "secondary";

export type EventTimelineKindV3 =
  | "action_started"
  | "action_completed_ok"
  | "action_completed_fail"
  | "narration"
  | "session"
  | "task";

export interface EventDisplayV3 {
  kind: string;
  summary: string;
  variant: EventDisplayVariantV3;
  timeline_kind?: EventTimelineKindV3;
  workspace_path?: string;
}

/**
 * One structural display projection for every canonical V3 event. Durable
 * payloads stay metadata-only; unexpired prose can come only from the narrow
 * live-display overlay already scrubbed by its producer.
 */
export function describeEventV3(event: EventRow): EventDisplayV3 {
  const live = event.live_display;
  switch (event.event_type) {
    case "ledger.genesis":
      return display("ledger genesis", event.data.genesis_id, "accent");
    case "ledger.activated":
      return display("ledger activated", event.data.activation_id, "success");
    case "ledger.schema_advanced":
      return display("schema advanced", event.data.release_reference, "warning");
    case "ledger.comparability_advanced":
      return display("comparability advanced", event.data.next_group_id, "warning");
    case "session.started": {
      const adapter = observedValue(event.data.runtime_attestation.adapter);
      const model = observedValue(event.data.runtime_attestation.model);
      const summary = [adapter?.id, model?.id].filter(Boolean).join(" · ");
      return display("session start", summary, "accent", "session");
    }
    case "session.attestation_changed":
      return display("attestation changed", event.data.reason, "warning");
    case "session.resumed":
      return display("session resumed", event.data.continuity, "accent", "session");
    case "session.ended":
      return display(
        "session end",
        `${event.data.outcome} · ${event.data.reason}`,
        outcomeVariant(event.data.outcome),
        "session",
      );
    case "session.termination_observed":
      return display("termination observed", event.data.observation, "warning", "session");
    case "run.started":
      return display("run start", event.data.run_kind, "accent", "session");
    case "run.completed":
      return display(
        "run end",
        `${event.data.outcome} · ${formatDuration(event.data.duration_ms)}`,
        outcomeVariant(event.data.outcome),
        "session",
      );
    case "turn.started":
      return display(
        "turn start",
        `${event.data.intent_kind} · ${event.data.input.bytes} bytes`,
        "accent",
      );
    case "turn.completed": {
      const duration = observedValue(event.data.duration_ms);
      const calls = observedValue(event.data.tool_call_count);
      const summary = [
        event.data.outcome,
        typeof calls === "number" ? `${calls} tools` : undefined,
        typeof duration === "number" ? formatDuration(duration) : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      return display("turn end", summary, outcomeVariant(event.data.outcome), "narration");
    }
    case "tool.requested": {
      const name = `${event.data.tool.namespace}.${event.data.tool.name}`;
      const target =
        live?.target_labels?.[0] ?? event.data.targets.find((item) => item.display)?.display;
      const summary = [name, target, live?.intent_display].filter(Boolean).join(" · ");
      const workspace = event.data.targets.find(
        (item) => item.kind === "workspace_path" && item.display,
      )?.display;
      return {
        ...display("tool request", summary, "info", "action_started"),
        ...(workspace ? { workspace_path: workspace } : {}),
      };
    }
    case "tool.completed": {
      const name = `${event.data.tool.namespace}.${event.data.tool.name}`;
      const duration = observedValue(event.data.duration_ms);
      const summary = [
        name,
        event.data.outcome,
        typeof duration === "number" ? formatDuration(duration) : undefined,
        event.data.error?.class,
      ]
        .filter(Boolean)
        .join(" · ");
      const ok = event.data.outcome === "succeeded";
      return display(
        ok ? "tool ok" : "tool fail",
        summary,
        outcomeVariant(event.data.outcome),
        ok ? "action_completed_ok" : "action_completed_fail",
      );
    }
    case "command.started":
      return display(
        "command start",
        [live?.executable ?? event.data.executable, live?.intent_display, event.data.intent_kind]
          .filter(Boolean)
          .join(" · "),
        "info",
        "action_started",
      );
    case "command.output_observed":
      return display(
        event.data.stream,
        `${event.data.bytes} bytes${event.data.lines === undefined ? "" : ` · ${event.data.lines} lines`}`,
        event.data.stream === "stderr" ? "warning" : "muted",
      );
    case "command.completed": {
      const ok = event.data.outcome === "succeeded";
      const duration = observedValue(event.data.duration_ms);
      return display(
        ok ? "command ok" : "command fail",
        [
          event.data.outcome,
          event.data.exit_code === undefined ? undefined : `exit ${event.data.exit_code}`,
          typeof duration === "number" ? formatDuration(duration) : undefined,
          event.data.error_class,
        ]
          .filter(Boolean)
          .join(" · "),
        outcomeVariant(event.data.outcome),
        ok ? "action_completed_ok" : "action_completed_fail",
      );
    }
    case "context.observed":
      return display("context", measurementSummary(event.data.measurement), "secondary");
    case "context.compaction_started":
      return display("compaction start", measurementSummary(event.data.before), "warning");
    case "context.compaction_completed":
      return display(
        "compaction end",
        `${event.data.outcome} · ${measurementSummary(event.data.after)}`,
        outcomeVariant(event.data.outcome),
      );
    case "context.checkpointed":
      return display("checkpoint", event.data.checkpoint_id, "secondary");
    case "context.recovery_injected":
      return display("recovery", `${event.data.checkpoint_id} · ${event.data.outcome}`, "warning");
    case "agent.delegated":
      return display(
        "agent delegated",
        `${event.data.role} · ${event.data.child_generation_id}`,
        "accent",
      );
    case "agent.started":
      return display(
        "agent start",
        `${event.data.role} · ${event.data.child_generation_id}`,
        "accent",
      );
    case "agent.completed":
      return display(
        "agent end",
        `${event.data.child_generation_id} · ${event.data.outcome}`,
        outcomeVariant(event.data.outcome),
      );
    case "wait.started":
      return display("wait start", event.data.kind, "warning");
    case "wait.ended":
      return display("wait end", event.data.outcome, outcomeVariant(event.data.outcome));
    case "artifact.observed":
      return display(
        "artifact",
        `${event.data.operation} · ${event.data.artifact.kind} · ${event.data.artifact.bytes} bytes`,
        "secondary",
      );
    case "progress.observed":
      return display(
        "progress",
        `${event.data.kind} · ${event.data.evidence_event_ids.length} facts`,
        "success",
      );
    case "coord.task_changed":
      return display("task", event.data.new_state, "secondary", "task");
    case "coord.lifecycle_changed":
      return display("lifecycle", event.data.new_state, "secondary");
    case "coord.status_observed":
      return display("status", event.data.status, "muted");
    case "coord.claim_changed":
      return display(
        "claim",
        `${event.data.operation} · ${event.data.target.display ?? event.data.target.kind}`,
        event.data.operation === "denied" ? "destructive" : "secondary",
      );
    case "coord.presence_changed":
      return display("presence", event.data.new_state, "secondary");
    case "coord.message_observed":
      return display(
        "message",
        `${event.data.direction} · ${event.data.body_length} bytes`,
        "secondary",
      );
    case "coord.identity_attested":
      return display("identity", event.data.method, "secondary");
    case "council.state_changed":
      return display("council", `${event.data.council_id} · ${event.data.new_state}`, "secondary");
    case "decision.state_changed":
      return display(
        "decision",
        `${event.data.decision_id} · ${event.data.new_state}`,
        "secondary",
      );
    case "lifecycle.recovered":
      return display("lifecycle recovery", event.data.recovery_kind, "warning");
    case "lifecycle.sweep_observed":
      return display(
        "lifecycle sweep",
        `${event.data.observation} · ${event.data.age_ms}ms`,
        "warning",
      );
    case "health.observed":
      return display(
        "health",
        `${event.data.subsystem} · ${event.data.severity}`,
        event.data.severity === "healthy" ? "success" : "warning",
      );
    case "health.capability_drift":
      return display(
        "capability drift",
        `${event.data.signal} · ${event.data.observed_count}/${event.data.expected_count}`,
        "warning",
      );
  }
}

function display(
  kind: string,
  summary: string,
  variant: EventDisplayVariantV3,
  timeline_kind?: EventTimelineKindV3,
): EventDisplayV3 {
  return { kind, summary, variant, ...(timeline_kind ? { timeline_kind } : {}) };
}

function outcomeVariant(outcome: string): EventDisplayVariantV3 {
  if (outcome === "succeeded") return "success";
  if (outcome === "unknown") return "warning";
  return "destructive";
}

function observedValue<T>(observation: { state: string; value?: T }): T | undefined {
  return observation.state === "observed" ? observation.value : undefined;
}

function measurementSummary(observation: {
  state: string;
  value?: { used_tokens: number; limit_tokens: number };
}): string {
  const value = observedValue(observation);
  return value ? `${value.used_tokens}/${value.limit_tokens} tokens` : observation.state;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)}s`;
  const seconds = Math.floor(ms / 1_000);
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}
