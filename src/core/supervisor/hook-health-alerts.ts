import type { SupervisorFindingEvidence, SupervisorFindingSeverity } from "./contract.ts";
import {
  type CompletedHookHealth,
  type HookHealthAggregate,
  SUPERVISOR_HIGH_COMPLETED_HOOK_RSS_BYTES,
  SUPERVISOR_HOOK_RETRY_CLUSTER_COUNT,
  SUPERVISOR_SLOW_COMPLETED_HOOK_MS,
  type SupervisorHookHealth,
} from "./hook-health.ts";

export interface HookHealthAlert {
  finding_kind:
    | "hook.execution-degraded"
    | "hook.execution-slow"
    | "hook.memory-heavy"
    | "hook.retry-cluster";
  severity: SupervisorFindingSeverity;
  scope_id: string;
  summary: string;
  observed_value: number;
  unit: SupervisorFindingEvidence["unit"];
  source: CompletedHookHealth;
  owner_id?: string;
}

export function evaluateHookHealthAlerts(health: SupervisorHookHealth): readonly HookHealthAlert[] {
  if (health.capability.state === "unavailable") return [];
  const alerts: HookHealthAlert[] = [];
  for (const aggregate of health.aggregates) {
    const receipts = health.recent.filter(
      (receipt) => `${receipt.adapter}:${receipt.hook_name}` === aggregate.key,
    );
    const problem = receipts.find(
      (receipt) => receipt.outcome === "faulted" || receipt.outcome === "degraded",
    );
    if (problem) alerts.push(problemAlert(aggregate, problem));
    const slow = maxReceipt(receipts, (receipt) => receipt.duration_ms);
    if (slow && slow.duration_ms >= SUPERVISOR_SLOW_COMPLETED_HOOK_MS) {
      alerts.push({
        finding_kind: "hook.execution-slow",
        severity: "warning",
        scope_id: aggregate.key,
        summary: `${aggregate.hook_name} completed in ${slow.duration_ms} milliseconds.`,
        observed_value: slow.duration_ms,
        unit: "milliseconds",
        source: slow,
        ...(slow.owner_id ? { owner_id: slow.owner_id } : {}),
      });
    }
    const heavy = maxReceipt(receipts, (receipt) => receipt.rss_end_bytes);
    if (heavy && heavy.rss_end_bytes >= SUPERVISOR_HIGH_COMPLETED_HOOK_RSS_BYTES) {
      alerts.push({
        finding_kind: "hook.memory-heavy",
        severity: "warning",
        scope_id: aggregate.key,
        summary: `${aggregate.hook_name} completed with ${heavy.rss_end_bytes} resident bytes.`,
        observed_value: heavy.rss_end_bytes,
        unit: "bytes",
        source: heavy,
        ...(heavy.owner_id ? { owner_id: heavy.owner_id } : {}),
      });
    }
  }
  if (health.summary.retry_count >= SUPERVISOR_HOOK_RETRY_CLUSTER_COUNT) {
    const latestRetry = health.recent.find((receipt) => receipt.retry_worker);
    if (latestRetry) {
      alerts.push({
        finding_kind: "hook.retry-cluster",
        severity: "warning",
        scope_id: `${latestRetry.adapter}:runtime-context-retry`,
        summary: `${health.summary.retry_count} hook retry workers ran inside five minutes.`,
        observed_value: health.summary.retry_count,
        unit: "count",
        source: latestRetry,
        ...(latestRetry.owner_id ? { owner_id: latestRetry.owner_id } : {}),
      });
    }
  }
  return alerts.slice(0, 12);
}

function problemAlert(
  aggregate: HookHealthAggregate,
  receipt: CompletedHookHealth,
): HookHealthAlert {
  const severity: SupervisorFindingSeverity =
    receipt.outcome === "faulted" ? "critical" : "warning";
  return {
    finding_kind: "hook.execution-degraded",
    severity,
    scope_id: aggregate.key,
    summary: `${aggregate.hook_name} completed with internal outcome ${receipt.outcome}.`,
    observed_value: aggregate.degraded_count + aggregate.faulted_count,
    unit: "count",
    source: receipt,
    ...(receipt.owner_id ? { owner_id: receipt.owner_id } : {}),
  };
}

function maxReceipt(
  receipts: readonly CompletedHookHealth[],
  value: (receipt: CompletedHookHealth) => number,
): CompletedHookHealth | undefined {
  return receipts.reduce<CompletedHookHealth | undefined>(
    (current, receipt) => (!current || value(receipt) > value(current) ? receipt : current),
    undefined,
  );
}
