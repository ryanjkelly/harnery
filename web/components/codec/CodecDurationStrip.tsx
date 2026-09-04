"use client";

import { Tooltip } from "@/components/ui/tooltip";
import type { CodecPanelScene } from "@/lib/codec/contracts";

import styles from "./codec.module.css";

type DurationField = "session" | "last-turn" | "working" | "idle";

const LABELS: Record<DurationField, string> = {
  session: "session",
  "last-turn": "last turn",
  working: "working",
  idle: "idle",
};

const DETAILS: Record<DurationField, string> = {
  session: "Total wall-clock time from this session's start to now or its terminal event.",
  "last-turn": "Wall-clock duration of the newest turn, including any time it spent waiting.",
  working: "Session time inside an active turn, excluding explicit waits.",
  idle: "Session time between turns or inside an explicit wait.",
};

export function CodecDurationStrip({
  panel,
  nowMs,
}: {
  panel: CodecPanelScene;
  nowMs: number | null;
}) {
  const timing = panel.timing;
  if (!timing) return null;
  const values = liveDurationValues(timing, nowMs);

  return (
    <ul
      data-codec-durations
      className={`${styles.runtimeStrip} ${styles.durationStrip}`}
      aria-label="Agent session durations"
    >
      {(Object.keys(LABELS) as DurationField[]).map((field) => {
        const value = values[field];
        const formattedValue = value === undefined ? undefined : formatCodecDuration(value);
        const isPartialLifecycleDuration =
          timing.value.observed_from !== undefined && (field === "working" || field === "idle");
        const visibleValue =
          formattedValue === undefined
            ? "—"
            : `${isPartialLifecycleDuration ? "≥ " : ""}${formattedValue}`;
        const accessibleValue =
          formattedValue === undefined
            ? "unavailable"
            : `${isPartialLifecycleDuration ? "at least " : ""}${formattedValue}`;
        return (
          <li key={field} className={styles.runtimeListItem}>
            <Tooltip
              side="bottom"
              align="start"
              triggerClassName={styles.runtimeTooltipTrigger}
              content={
                <div className="space-y-1">
                  <p className="font-semibold">
                    {LABELS[field]} · {formattedValue === undefined ? "unavailable" : visibleValue}
                  </p>
                  <p>{DETAILS[field]}</p>
                  {isPartialLifecycleDuration && (
                    <p>
                      This is a lower bound because only lifecycle time observed since{" "}
                      <time dateTime={timing.value.observed_from}>
                        {timing.value.observed_from}
                      </time>{" "}
                      is counted. Earlier working and idle time is not included.
                    </p>
                  )}
                  <p className="text-muted-foreground">
                    {timing.provenance} · {timing.confidence} confidence
                  </p>
                </div>
              }
            >
              <button
                type="button"
                data-duration-field={field}
                data-runtime-missing={value === undefined ? "true" : undefined}
                className={styles.runtimeField}
                aria-label={`${LABELS[field]} duration: ${accessibleValue}`}
              >
                <span className={styles.runtimeLabel}>{LABELS[field]}</span>
                <strong className={styles.runtimeValue}>{visibleValue}</strong>
              </button>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}

export function liveDurationValues(
  timing: NonNullable<CodecPanelScene["timing"]>,
  nowMs: number | null,
): Record<DurationField, number | undefined> {
  const value = timing.value;
  const observedAt = Date.parse(timing.observed_at);
  const delta = nowMs !== null && Number.isFinite(observedAt) ? Math.max(0, nowMs - observedAt) : 0;
  return {
    session: value.session_duration_ms + (value.session_active ? delta : 0),
    "last-turn":
      value.last_turn_duration_ms === undefined
        ? undefined
        : value.last_turn_duration_ms + (value.last_turn_active ? delta : 0),
    working:
      value.working_duration_ms +
      (value.session_active && value.current_bucket === "working" ? delta : 0),
    idle:
      value.idle_duration_ms +
      (value.session_active && value.current_bucket === "idle" ? delta : 0),
  };
}

export function formatCodecDuration(valueMs: number): string {
  const seconds = Math.max(0, Math.floor(valueMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  }
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
}
