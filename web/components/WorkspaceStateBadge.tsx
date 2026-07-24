import type { WorkflowWorkspaceInspection } from "harnery/core/workflow";
import { Badge } from "@/components/ui/badge";

export function WorkspaceStateBadge({ inspection }: { inspection: WorkflowWorkspaceInspection }) {
  if (!inspection.ok) {
    return (
      <Badge variant="destructive" title={inspection.error}>
        workspace invalid
      </Badge>
    );
  }
  const status = inspection.value;
  if (status.selection === "shared") {
    return <Badge variant="muted">shared workspace</Badge>;
  }
  if (status.selection === "compatibility") {
    return (
      <Badge
        variant="warning"
        title={`Requested ${status.requested_isolation}; ${status.compatibility?.reason ?? "compatibility fallback"}`}
      >
        {status.requested_isolation} → shared
      </Badge>
    );
  }
  const state = status.lifecycle.state;
  const variant =
    state === "integrated" || state === "released"
      ? "success"
      : state === "blocked" || state === "lost" || state === "abandoned_dirty"
        ? "destructive"
        : state === "preserved_dirty" || state === "failed_retained"
          ? "warning"
          : state === "running" ||
              state === "allocating" ||
              state === "integrating" ||
              state === "cleanup_pending"
            ? "info"
            : "muted";
  return (
    <Badge
      variant={variant}
      title={`${status.provider?.id ?? "workspace provider"} · verification ${status.verification.status}`}
    >
      {state.replaceAll("_", " ")}
    </Badge>
  );
}
