import type { WorkflowWorkspaceInspection } from "harnery/core/workflow";
import { Badge } from "@/components/ui/badge";
import { stateLabel, type Tone, toneFor } from "@/lib/tone";

type LifecycleState = Extract<
  WorkflowWorkspaceInspection,
  { ok: true }
>["value"]["lifecycle"]["state"];

const LIFECYCLE_TONES: Partial<Record<LifecycleState, Tone>> = {
  integrated: "done",
  released: "done",
  blocked: "danger",
  lost: "danger",
  abandoned_dirty: "danger",
  preserved_dirty: "warn",
  failed_retained: "warn",
  running: "act",
  allocating: "act",
  integrating: "act",
  cleanup_pending: "act",
};

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
    return (
      <Badge
        variant="muted"
        title="The run's agents worked directly in this checkout, alongside you. Nothing needs integrating, and nothing needs cleaning up."
      >
        shared workspace
      </Badge>
    );
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
  return (
    <Badge
      tone={toneFor(state, LIFECYCLE_TONES)}
      title={`${status.provider?.id ?? "workspace provider"} · verification ${status.verification.status}`}
    >
      {stateLabel(state)}
    </Badge>
  );
}
