import type { CodecPanelScene, Presented } from "./contracts";

export interface CodecEvidenceReceiptRow {
  channel: string;
  value: string;
  provenance: string;
  confidence: string;
  observed_at: string;
  evidence_event_ids: string[];
  expires_at?: string;
}

/** Flatten visible panel channels into a bounded read-only inspection receipt. */
export function codecEvidenceReceiptRows(panel: CodecPanelScene): CodecEvidenceReceiptRow[] {
  const rows: CodecEvidenceReceiptRow[] = [];
  add(rows, "presence", panel.presence);
  add(rows, "activity", panel.activity);
  add(rows, "lifecycle", panel.lifecycle);
  add(rows, "expression", panel.expression);
  add(rows, "attention", panel.attention);
  add(rows, "context", panel.context_band);
  add(rows, "progress", panel.progress_rhythm);
  if (panel.operation) add(rows, "operation", panel.operation);
  if (panel.artifact_cue) add(rows, "artifact", panel.artifact_cue);
  if (panel.friction) add(rows, "friction", panel.friction);
  if (panel.telemetry) add(rows, "telemetry", panel.telemetry);
  if (panel.focus_bubble) add(rows, "focus", panel.focus_bubble);
  if (panel.ledger_state) add(rows, "ledger", panel.ledger_state);
  for (const action of panel.recent_actions.slice(-3)) {
    rows.push({
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

function add(
  rows: CodecEvidenceReceiptRow[],
  channel: string,
  presented: Presented<unknown>,
): void {
  rows.push({
    channel,
    value: displayValue(presented.value),
    provenance: presented.provenance,
    confidence: presented.confidence,
    observed_at: presented.observed_at,
    evidence_event_ids: (presented.evidence_event_ids ?? []).slice(-3),
    ...(presented.expires_at ? { expires_at: presented.expires_at } : {}),
  });
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
