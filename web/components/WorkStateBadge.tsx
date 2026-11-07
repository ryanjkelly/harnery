import type { WorkState } from "harnery/core/work/state";

import { StatusBadge } from "@/components/ui/status-badge";
import type { Tone } from "@/lib/tone";

const WORK_TONES: Partial<Record<WorkState, Tone>> = {
  succeeded: "done",
  blocked: "danger",
  cancelled: "danger",
  awaiting_approval: "warn",
  in_review: "warn",
};

export function WorkStateBadge({ state }: { state: WorkState }) {
  return <StatusBadge state={state} tones={WORK_TONES} />;
}
