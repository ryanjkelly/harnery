import type { CodecPanelScene, Presented } from "./contracts";
import {
  type CodecSemanticChannel,
  type CodecSemanticPresented,
  codecSemantic,
} from "./semantic-contract";

export interface CodecEvidenceReceiptRow {
  group: "state" | "activity" | "source";
  channel: string;
  value: string;
  detail?: string;
  provenance: string;
  confidence: string;
  observed_at: string;
  evidence_event_ids: string[];
  expires_at?: string;
}

/** Flatten visible panel channels into a bounded read-only inspection receipt. */
export function codecEvidenceReceiptRows(panel: CodecPanelScene): CodecEvidenceReceiptRow[] {
  const rows: CodecEvidenceReceiptRow[] = [];
  add(rows, "state", "presence", panel.presence);
  add(rows, "state", "activity", panel.activity);
  add(rows, "state", "lifecycle", panel.lifecycle);
  add(rows, "state", "expression", panel.expression);
  add(rows, "state", "attention", panel.attention);
  add(rows, "state", "context", panel.context_band);
  add(rows, "activity", "progress", panel.progress_rhythm);
  if (panel.operation) add(rows, "activity", "operation", panel.operation);
  if (panel.artifact_cue) add(rows, "activity", "artifact", panel.artifact_cue);
  if (panel.friction) add(rows, "activity", "friction", panel.friction);
  if (panel.telemetry) add(rows, "source", "telemetry", panel.telemetry);
  if (panel.telemetry_reason) {
    add(rows, "source", "observer reason", panel.telemetry_reason);
  }
  if (panel.focus_bubble) add(rows, "activity", "focus", panel.focus_bubble);
  if (panel.ledger_state) add(rows, "source", "ledger", panel.ledger_state);
  const semantic = codecSemantic(panel);
  if (semantic) addSemanticRows(rows, semantic);
  if (panel.remote_source) {
    add(rows, "source", "relay", panel.remote_source.relay);
    if (panel.remote_source.digest) {
      add(rows, "source", "remote digest", panel.remote_source.digest);
    }
  }
  for (const action of panel.recent_actions.slice(-3)) {
    rows.push({
      group: "activity",
      channel: "action",
      value: `${action.category} · ${action.outcome}`,
      provenance: "event",
      confidence: "high",
      observed_at: action.observed_at,
      evidence_event_ids: [action.event_id],
    });
  }
  return rows;
}

function addSemanticRows(rows: CodecEvidenceReceiptRow[], semantic: CodecSemanticChannel): void {
  rows.push({
    group: "source",
    channel: "semantic reader",
    value: `${semantic.reader.configured_model} · ${semantic.state}`,
    detail: [
      semantic.reader.harness,
      semantic.reader.resolved_model_id,
      semantic.reader.model_attestation,
      semantic.receipt?.reason_code,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · "),
    provenance: "projection",
    confidence:
      semantic.reader.model_attestation === "verified"
        ? "high"
        : semantic.reader.model_attestation === "requested-only"
          ? "medium"
          : "low",
    observed_at: semantic.generated_at,
    evidence_event_ids: [semantic.observed_through_event_id],
    expires_at: semantic.expires_at,
  });
  if (semantic.state !== "current") return;
  addSemantic(rows, "headline", semantic.headline);
  addSemantic(rows, "summary", semantic.summary);
  addSemantic(rows, "phase", semantic.phase);
  addSemantic(rows, "expression cue", semantic.expression_cue);
  addSemantic(rows, "purpose", semantic.purpose);
  addSemantic(rows, "recent result", semantic.recent_result);
  addSemantic(rows, "semantic attention", semantic.attention);
  addSemantic(rows, "next prediction", semantic.next_step);
  addSemantic(rows, "tags", semantic.tags);
}

function addSemantic(
  rows: CodecEvidenceReceiptRow[],
  channel: string,
  field: CodecSemanticPresented<unknown> | undefined,
): void {
  if (!field) return;
  rows.push({
    group: "activity",
    channel,
    value: displayValue(field.value),
    detail: field.basis,
    provenance: field.provenance,
    confidence: field.confidence,
    observed_at: field.observed_at,
    evidence_event_ids: (field.evidence_event_ids ?? []).slice(-3),
    ...(field.expires_at ? { expires_at: field.expires_at } : {}),
  });
}

function add(
  rows: CodecEvidenceReceiptRow[],
  group: CodecEvidenceReceiptRow["group"],
  channel: string,
  presented: Presented<unknown>,
): void {
  const detail = displayDetail(presented.value);
  rows.push({
    group,
    channel,
    value: displayValue(presented.value),
    ...(detail ? { detail } : {}),
    provenance: presented.provenance,
    confidence: presented.confidence,
    observed_at: presented.observed_at,
    evidence_event_ids: (presented.evidence_event_ids ?? []).slice(-3),
    ...(presented.expires_at ? { expires_at: presented.expires_at } : {}),
  });
}

function displayDetail(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const details: string[] = [];
  if (typeof record.elapsed_ms === "number") details.push(`elapsed ${duration(record.elapsed_ms)}`);
  if (typeof record.duration_sample_count === "number") {
    details.push(`${record.duration_sample_count} baseline samples`);
  }
  if (typeof record.long_running_threshold_ms === "number") {
    details.push(`long-running after ${duration(record.long_running_threshold_ms)}`);
  }
  if (typeof record.age_ms === "number") details.push(`age ${duration(record.age_ms)}`);
  return details.length > 0 ? details.join(" · ") : undefined;
}

function duration(value: number): string {
  if (value < 1_000) return `${Math.max(0, Math.round(value))}ms`;
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function displayValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      [record.label, record.state, record.operation, record.kind, record.text]
        .filter((part): part is string => typeof part === "string")
        .join(" · ") || "observed"
    );
  }
  return "unknown";
}
