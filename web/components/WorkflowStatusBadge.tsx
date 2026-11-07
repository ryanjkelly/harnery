import { StatusBadge } from "@/components/ui/status-badge";
import type { Tone } from "@/lib/tone";

/** What each state means, on hover. These badges are the first thing an
 * operator reads on both workflow surfaces, and several of them are easy to
 * misread: `stale` is not a failure, `cached` is not a skip-because-broken, and
 * a run can be `done` while individual agents inside it failed. */
const STATUS_HINTS: Record<string, string> = {
  running:
    "The run is in flight. A run stays running as long as a child agent's heartbeat is alive, however long it goes without writing to its transcript.",
  done: "The orchestrator finished and reported success. Individual agents may still have retried along the way.",
  failed:
    "The run ended without success. The transcript records which agent failed and why; the proof packet below records what had been established before it did.",
  parked:
    "Stopped on a durable approval. No further protected work runs until someone resolves the request and resumes the run explicitly.",
  stale:
    "No live child and no transcript write for a while, with no run.end. The orchestrator most likely died. This is not a reported failure, it is the absence of any report.",
  cached:
    "Skipped because an identical call in an earlier run already produced this result. Nothing was spawned and nothing was charged.",
};

type WorkflowStatus = "running" | "parked" | "done" | "failed" | "stale" | "cached";

const STATUS_TONES: Partial<Record<WorkflowStatus, Tone>> = {
  running: "act",
  done: "done",
  parked: "warn",
  failed: "danger",
};

const STATUS_LABELS: Partial<Record<WorkflowStatus, string>> = {
  parked: "awaiting approval",
};

/** House colour grammar: sky = working live, neutral = wait/stale,
 * emerald = done. Shared by the /workflows list + detail pages. */
export function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  return (
    <StatusBadge
      state={status}
      tones={STATUS_TONES}
      labels={STATUS_LABELS}
      hints={STATUS_HINTS}
      live={status === "running"}
    />
  );
}
