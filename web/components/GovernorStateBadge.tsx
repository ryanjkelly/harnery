import type { GovernorState } from "harnery/core/governor/state";

import { StatusBadge } from "@/components/ui/status-badge";
import type { Tone } from "@/lib/tone";

const GOVERNOR_TONES: Partial<Record<GovernorState, Tone>> = {
  succeeded: "done",
  blocked: "danger",
  budget_exhausted: "danger",
  awaiting_attention: "warn",
  running: "act",
};

export function GovernorStateBadge({ state }: { state: GovernorState }) {
  return <StatusBadge state={state} tones={GOVERNOR_TONES} live={state === "running"} />;
}
