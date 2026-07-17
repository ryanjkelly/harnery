import { Badge } from "@/components/ui/badge";

/** House colour grammar: sky = working live, neutral = wait/stale,
 * emerald = done. Shared by the /workflows list + detail pages. */
export function WorkflowStatusBadge({
  status,
}: {
  status: "running" | "done" | "failed" | "stale" | "cached";
}) {
  if (status === "running") {
    return (
      <Badge className="border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400">
        <span className="live-dot mr-1" />
        running
      </Badge>
    );
  }
  if (status === "done") {
    return (
      <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        done
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge className="border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400">
        failed
      </Badge>
    );
  }
  if (status === "cached") {
    return <Badge className="text-muted-foreground">cached</Badge>;
  }
  return <Badge className="text-muted-foreground">stale</Badge>;
}
