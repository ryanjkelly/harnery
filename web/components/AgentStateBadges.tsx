import { Badge } from "@/components/ui/badge";
import type { Heartbeat } from "@/lib/coord-reader";

export function AgentStateBadges({
  activity,
  taskState,
  reason,
  compact = false,
}: {
  activity: Heartbeat["activity"];
  taskState: Heartbeat["task_state"];
  reason?: string | null;
  compact?: boolean;
}) {
  const activityLabel = activity === "needs_input" ? "needs input" : activity;
  const lifecycleTitle =
    taskState === "blocked" && reason ? `Blocked: ${reason}` : `Lifecycle: ${taskState}`;

  return (
    <span className="inline-flex items-center gap-1 flex-wrap" data-state-axes>
      <Badge
        variant={activityVariant(activity)}
        title={`Activity: ${activityLabel}`}
        data-state-axis="activity"
      >
        {activity === "working" && <span className="live-dot" aria-hidden />}
        {compact ? activityLabel : `activity ${activityLabel}`}
      </Badge>
      <Badge
        variant={lifecycleVariant(taskState)}
        title={lifecycleTitle}
        data-state-axis="lifecycle"
      >
        {compact ? taskState : `lifecycle ${taskState}`}
      </Badge>
    </span>
  );
}

function activityVariant(
  activity: Heartbeat["activity"],
): "info" | "warning" | "outline" | "muted" {
  if (activity === "working") return "info";
  if (activity === "needs_input") return "warning";
  if (activity === "idle") return "outline";
  return "muted";
}

function lifecycleVariant(taskState: Heartbeat["task_state"]): "outline" | "warning" | "success" {
  if (taskState === "blocked") return "warning";
  if (taskState === "done") return "success";
  return "outline";
}
