import Link from "next/link";
import { GovernorStateBadge } from "@/components/GovernorStateBadge";
import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { SectionHeader } from "@/components/layout/Section";
import { Badge } from "@/components/ui/badge";
import { hostInfo } from "@/lib/config";
import { coordRoot } from "@/lib/coord-reader";
import {
  governorDashboardDecision,
  governorPlanDashboardStatus,
  readGovernorBackgroundService,
  readGovernors,
} from "@/lib/governor-reader";
import { TONE } from "@/lib/tone";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Goals · Harnery" };

export default function GovernorsPage() {
  const root = coordRoot();
  const { binName } = hostInfo();
  const records = readGovernors(root);
  const service = readGovernorBackgroundService(root);
  const serviceState =
    service.liveness === "unknown"
      ? "unknown"
      : service.running
        ? (service.record?.state ?? "running")
        : service.stale
          ? "stale"
          : "stopped";
  return (
    <PageShell>
      <PageHeader
        title="Goals"
        description="Durable goals: bounded specialist teams supervising missions and immutable work graphs."
      />
      <section className="mb-6 rounded-lg border border-border bg-card px-4 py-3">
        <SectionHeader
          className="mb-0"
          title="Background service"
          actions={
            <Badge
              tone={
                service.running
                  ? "act"
                  : service.liveness === "unknown" || service.stale
                    ? "warn"
                    : "neutral"
              }
            >
              {service.config ? serviceState : "unconfigured"}
            </Badge>
          }
        />
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{service.config?.goal_ids.length ?? 0} enrolled goals</span>
          {service.record ? <span>{service.record.sweep_count} sweeps</span> : null}
          {service.record?.active_goal_id ? (
            <span>active: {service.record.active_goal_id}</span>
          ) : null}
          {service.record ? <span>heartbeat: {service.record.heartbeat_at}</span> : null}
          <span>generation: {service.generation}</span>
          <span>running build: {service.running_build?.version ?? "unknown"}</span>
          {service.restart_needed ? <span>restart needed</span> : null}
        </div>
        {service.record?.last_error ? (
          <p className={`mt-2 text-xs ${TONE.danger.text}`}>{service.record.last_error}</p>
        ) : null}
      </section>
      {records.length === 0 ? (
        <EmptyState>
          No goals yet. Create one with <code>{binName} governor create</code>.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {records.map((record) => {
            const { intent, projection, plans } = record;
            const decision = governorDashboardDecision(record);
            const pendingPlan = projection.pending_plan_id
              ? plans.find((plan) => plan.request.id === projection.pending_plan_id)
              : undefined;
            const pendingPlanStatus = pendingPlan
              ? governorPlanDashboardStatus(pendingPlan)
              : undefined;
            return (
              <li key={intent.id}>
                <Link
                  href={`/governors/${encodeURIComponent(intent.id)}`}
                  className="block rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-foreground/25"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <GovernorStateBadge state={projection.state} />
                    <span className="font-medium">{intent.title}</span>
                    <span className="text-xs text-muted-foreground">{intent.id}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{projection.work_ids.length} work items</span>
                    <span>
                      {projection.attempts_used}/{intent.limits.max_total_attempts} attempts
                    </span>
                    <span>next: {decision.nextAction}</span>
                    {intent.replanning ? (
                      <span>
                        plan generation {projection.plan_generation} · {projection.replans_used}/
                        {intent.replanning.max_replans} replans
                      </span>
                    ) : null}
                    {intent.mission ? (
                      <span>
                        milestones {projection.milestones_completed}/{intent.mission.max_milestones}
                      </span>
                    ) : null}
                    {pendingPlanStatus && projection.pending_plan_id ? (
                      <span>
                        pending plan: {projection.pending_plan_id} · {pendingPlanStatus.label}
                      </span>
                    ) : null}
                    {projection.attention_plan_id ? (
                      <span>attention plan: {projection.attention_plan_id}</span>
                    ) : null}
                    <span>{decision.reason}</span>
                    {service.config?.goal_ids.includes(intent.id) ? (
                      <span>service: {service.runtime?.goals[intent.id]?.state ?? "enrolled"}</span>
                    ) : null}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </PageShell>
  );
}
