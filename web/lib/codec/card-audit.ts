import type { AgentsSnapshot, Heartbeat } from "@/lib/coord-reader";

import type { CodecScene } from "./contracts";

export interface CodecCardCapture {
  captured_at: string;
  scene_generated_at: string;
  cards: Array<{
    instance_id: string;
    display_name: string;
    machine?: string;
    task: string | null;
    presence: string;
    activity: string;
    lifecycle: string;
    ledger_state: string | null;
    updated_at: string;
  }>;
}

export interface CodecCardAuditFinding {
  instance_id: string;
  display_name: string;
  field: string;
  card: string | null;
  known: string | null;
  explanation: string;
  severity: "mismatch" | "unverified";
}

export interface CodecCardAuditReport {
  capture: CodecCardCapture;
  checked_at: string;
  authority_read_state: AgentsSnapshot["meta"]["read_state"];
  findings: CodecCardAuditFinding[];
  summary: { checked: number; mismatches: number; unverified: number };
}

/** Capture exactly the data currently driving each rendered card. */
export function captureCodecCards(scene: CodecScene, capturedAt: string): CodecCardCapture {
  return {
    captured_at: capturedAt,
    scene_generated_at: scene.generated_at,
    cards: scene.panels.map((panel) => ({
      instance_id: panel.instance_id,
      display_name: panel.identity.display_name,
      ...(panel.machine ? { machine: panel.machine } : {}),
      task: panel.identity.task?.value ?? null,
      presence: panel.presence.value,
      activity: panel.activity.value,
      lifecycle: panel.lifecycle.value,
      ledger_state: panel.ledger_state?.value ?? null,
      updated_at: panel.updated_at,
    })),
  };
}

/** Compare a browser-held card snapshot with an independent, current V3 read. */
export function compareCodecCards(
  capture: CodecCardCapture,
  authority: AgentsSnapshot,
  checkedAt: string,
): CodecCardAuditReport {
  const findings: CodecCardAuditFinding[] = [];
  const localCards = capture.cards.filter((card) => !card.machine);
  const readState = authority.meta.read_state;
  if (readState.ok === false) {
    return {
      capture,
      checked_at: checkedAt,
      authority_read_state: readState,
      findings: localCards.map((card) => ({
        instance_id: card.instance_id,
        display_name: card.display_name,
        field: "authority",
        card: null,
        known: null,
        explanation: readState.reason,
        severity: "unverified",
      })),
      summary: { checked: 0, mismatches: 0, unverified: localCards.length },
    };
  }

  const rows = [...authority.active, ...authority.stale, ...authority.terminal];
  const byId = new Map<string, Heartbeat>();
  for (const row of rows) {
    byId.set(row.instance_id, row);
    if (row.v3_instance_id) byId.set(row.v3_instance_id, row);
  }
  const capturedIds = new Set<string>();
  const mismatch = (
    card: CodecCardCapture["cards"][number],
    field: string,
    cardValue: string | null,
    known: string | null,
    explanation: string,
  ) =>
    findings.push({
      instance_id: card.instance_id,
      display_name: card.display_name,
      field,
      card: cardValue,
      known,
      explanation,
      severity: "mismatch",
    });

  for (const card of localCards) {
    const row = byId.get(card.instance_id);
    if (!row) {
      findings.push({
        instance_id: card.instance_id,
        display_name: card.display_name,
        field: "agent",
        card: "visible",
        known: null,
        explanation:
          "No current authoritative row; recent event-only cards cannot be verified here.",
        severity: "unverified",
      });
      continue;
    }
    capturedIds.add(row.instance_id);
    if (row.ledger_state === "terminal") {
      mismatch(
        card,
        "card",
        "visible",
        "terminal",
        "The session has ended and should have left Codec.",
      );
      continue;
    }
    if (card.ledger_state && row.ledger_state && card.ledger_state !== row.ledger_state) {
      mismatch(
        card,
        "ledger state",
        card.ledger_state,
        row.ledger_state,
        "Ledger state changed since the card was projected.",
      );
    }
    if (row.age_seconds < authority.meta.stale_threshold_seconds) {
      if (card.presence !== "online") {
        mismatch(
          card,
          "presence",
          card.presence,
          "online",
          "The current agent observation is fresh.",
        );
      }
      if (
        row.activity !== "unknown" &&
        card.activity !== row.activity.replace("needs_input", "needs-input")
      ) {
        mismatch(
          card,
          "activity",
          card.activity,
          row.activity,
          "Current coordination activity differs from the card.",
        );
      }
    }
    if (row.task?.trim() && card.task !== row.task) {
      mismatch(
        card,
        "task",
        card.task,
        row.task,
        "The declared task differs from the current coordination view.",
      );
    }
    if (row.task_state_updated_at && card.lifecycle !== row.task_state) {
      mismatch(
        card,
        "lifecycle",
        card.lifecycle,
        row.task_state,
        "The declared lifecycle differs from the current coordination view.",
      );
    }
  }

  for (const row of authority.active) {
    if (row.ledger_state === "terminal" || capturedIds.has(row.instance_id)) continue;
    if (capture.cards.some((card) => card.instance_id === row.v3_instance_id)) continue;
    findings.push({
      instance_id: row.instance_id,
      display_name: row.name,
      field: "card",
      card: null,
      known: "active",
      explanation: "A current active agent was missing from the captured Codec scene.",
      severity: "mismatch",
    });
  }

  return {
    capture,
    checked_at: checkedAt,
    authority_read_state: authority.meta.read_state,
    findings,
    summary: {
      checked: localCards.length,
      mismatches: findings.filter((finding) => finding.severity === "mismatch").length,
      unverified: findings.filter((finding) => finding.severity === "unverified").length,
    },
  };
}
