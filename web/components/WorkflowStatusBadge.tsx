import { Badge } from "@/components/ui/badge";

/** What each state means, on hover. These badges are the first thing an
 * operator reads on both workflow surfaces, and several of them are easy to
 * misread: `stale` is not a failure, `cached` is not a skip-because-broken, and
 * a run can be `done` while individual agents inside it failed. */
const STATUS_HINTS: Record<string, string> = {
  running:
    "The run is in flight. A run stays running as long as a child agent's heartbeat is alive, however long it goes without writing to its journal.",
  done: "The orchestrator finished and reported success. Individual agents may still have retried along the way.",
  failed:
    "The run ended without success. The journal records which agent failed and why; the proof packet below records what had been established before it did.",
  parked:
    "Stopped on a durable approval. No further protected work runs until someone resolves the request and resumes the run explicitly.",
  stale:
    "No live child and no journal write for a while, with no run.end. The orchestrator most likely died. This is not a reported failure, it is the absence of any report.",
  cached:
    "Skipped because an identical call in an earlier run already produced this result. Nothing was spawned and nothing was charged.",
};

/** House colour grammar: sky = working live, neutral = wait/stale,
 * emerald = done. Shared by the /workflows list + detail pages. */
export function WorkflowStatusBadge({
  status,
}: {
  status: "running" | "parked" | "done" | "failed" | "stale" | "cached";
}) {
  const hint = STATUS_HINTS[status];
  if (status === "running") {
    return (
      <Badge
        className="border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400"
        title={hint}
      >
        <span className="live-dot mr-1" />
        running
      </Badge>
    );
  }
  if (status === "done") {
    return (
      <Badge
        className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
        title={hint}
      >
        done
      </Badge>
    );
  }
  if (status === "parked") {
    return (
      <Badge
        className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        title={hint}
      >
        awaiting approval
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge
        className="border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
        title={hint}
      >
        failed
      </Badge>
    );
  }
  if (status === "cached") {
    return (
      <Badge className="text-muted-foreground" title={hint}>
        cached
      </Badge>
    );
  }
  return (
    <Badge className="text-muted-foreground" title={hint}>
      stale
    </Badge>
  );
}
