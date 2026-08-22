"use client";

import { Tooltip } from "@/components/ui/tooltip";
import type { CodecPanelScene, CodecRuntimeValue } from "@/lib/codec/contracts";

import styles from "./codec.module.css";

type RuntimeField = "harness" | "model" | "effort" | "speed";

const LABELS: Record<RuntimeField, string> = {
  harness: "harness",
  model: "model",
  effort: "effort",
  speed: "speed",
};

/** Compact, always-visible runtime identity. Missing tuning stays explicit:
 * absence means the adapter did not report it, never a default we guessed. */
export function CodecRuntimeStrip({ panel }: { panel: CodecPanelScene }) {
  const runtime = panel.runtime?.value;
  const values: Record<RuntimeField, string | null> = {
    harness: displayToken(runtime?.harness),
    model: displayToken(runtime?.model),
    effort: displayToken(runtime?.effort),
    speed: displayToken(runtime?.speed),
  };

  return (
    <ul data-codec-runtime className={styles.runtimeStrip} aria-label="Agent runtime configuration">
      {(Object.keys(LABELS) as RuntimeField[]).map((field) => {
        const value = values[field];
        return (
          <li key={field} className={styles.runtimeListItem}>
            <Tooltip
              side="bottom"
              align="start"
              triggerClassName={styles.runtimeTooltipTrigger}
              content={
                <RuntimeTooltip field={field} value={value} runtime={runtime} panel={panel} />
              }
            >
              <button
                type="button"
                data-runtime-field={field}
                data-runtime-missing={value ? undefined : "true"}
                className={styles.runtimeField}
                aria-label={`${LABELS[field]}: ${value ?? "not reported"}`}
              >
                <span className={styles.runtimeLabel}>{LABELS[field]}</span>
                <strong className={styles.runtimeValue}>{value ?? "—"}</strong>
              </button>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}

function displayToken(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function RuntimeTooltip({
  field,
  value,
  runtime,
  panel,
}: {
  field: RuntimeField;
  value: string | null;
  runtime: CodecRuntimeValue | undefined;
  panel: CodecPanelScene;
}) {
  const source = panel.runtime;
  const details =
    field === "harness"
      ? runtime?.harness_version
        ? `Harness version ${runtime.harness_version}.`
        : "Harness version was not reported."
      : field === "model"
        ? runtime?.model_provider
          ? `Provider: ${runtime.model_provider}.`
          : "Model provider was not reported."
        : field === "effort" || field === "speed"
          ? runtime?.harness === "cursor" && value
            ? `Explicitly encoded in the canonical Cursor model id ${runtime.model ?? ""}.`
            : `The ${field} setting was not reported by this adapter.`
          : "";

  return (
    <div className="space-y-1">
      <p className="font-semibold">
        {LABELS[field]} · {value ?? "not reported"}
      </p>
      <p>{details}</p>
      <p className="text-muted-foreground">
        {source
          ? `${source.provenance} · ${source.confidence} confidence`
          : "No runtime attestation reached this panel."}
      </p>
    </div>
  );
}
