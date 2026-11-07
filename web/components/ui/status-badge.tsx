import type * as React from "react";

import { Badge } from "@/components/ui/badge";
import { stateLabel, type Tone, toneFor } from "@/lib/tone";

/**
 * A state pill driven by a state→tone map. Replaces the per-feature badges
 * that each hand-wrote the same sky/emerald/amber/red class strings.
 *
 *   <StatusBadge state={run.state} tones={{ succeeded: "done", blocked: "danger" }} />
 *
 * Unmapped states render neutral. `labels` and `hints` override the default
 * label (the state with underscores turned into spaces) and add a tooltip.
 * `live` prefixes the pulsing live dot for a state that is working right now.
 */
export function StatusBadge<S extends string>({
  state,
  tones,
  labels,
  hints,
  live = false,
  className,
}: {
  state: S;
  tones: Partial<Record<S, Tone>>;
  labels?: Partial<Record<S, React.ReactNode>>;
  hints?: Partial<Record<S, React.ReactNode>>;
  live?: boolean;
  className?: string;
}) {
  return (
    <Badge tone={toneFor(state, tones)} title={hints?.[state]} className={className}>
      {live ? <span className="live-dot mr-0.5" /> : null}
      {labels?.[state] ?? stateLabel(state)}
    </Badge>
  );
}
