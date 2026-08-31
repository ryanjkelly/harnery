import {
  Activity,
  CircleAlert,
  Cpu,
  Gauge,
  HeartPulse,
  History,
  MemoryStick,
  ServerCog,
  Workflow,
} from "lucide-react";
import { AgentChip, AgentChipProvider } from "@/components/AgentChip";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { NavBar } from "@/components/NavBar";
import { ResourceLiveRefresher } from "@/components/resources/ResourceLiveRefresher";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  buildAgentSummaryMap,
  buildEndedAgentSummaries,
  buildSubagentSummaries,
} from "@/lib/agent-summary";
import { coordRoot, readAgents, readInstanceIdentities } from "@/lib/coord-reader";
import { readResourceDashboard } from "@/lib/resource-reader";
import { readSupervisorDashboard } from "@/lib/supervisor-reader";
import type {
  ObservedServiceHealth,
  SupervisorFinding,
  SupervisorHistoryPoint,
} from "../../../src/core/supervisor/contract";
import type { HookHealthAggregate } from "../../../src/core/supervisor/hook-health";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Resources · Harnery" };

export default function ResourcesPage() {
  const root = coordRoot();
  const report = readResourceDashboard(root);
  const supervisor = readSupervisorDashboard(root);
  const snapshot = report.snapshot;
  const agents = readAgents();
  const identities = readInstanceIdentities();
  const instanceToName: Record<string, string> = {};
  for (const agent of [...agents.active, ...agents.stale, ...agents.terminal]) {
    instanceToName[agent.instance_id] = agent.name;
  }
  for (const [instanceId, identity] of Object.entries(identities)) {
    instanceToName[instanceId] ??= identity.name;
  }
  const names = [...new Set(Object.values(instanceToName))];
  const summaries = {
    ...buildEndedAgentSummaries(identities),
    ...buildSubagentSummaries(identities, agents),
    ...buildAgentSummaryMap(names, identities, agents),
  };

  return (
    <AgentChipProvider summaries={summaries}>
      <div className="min-h-screen bg-background text-foreground">
        <ResourceLiveRefresher />
        <NavBar scannedDir={root} />
        <main className="mx-auto max-w-screen-2xl px-4 pb-12 sm:px-6">
          <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">Resource activity</h1>
                <ObserverBadge running={report.service.running} stale={report.service.stale} />
                {snapshot ? <SupportBadge state={snapshot.support.state} /> : null}
              </div>
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                See local CPU and memory pressure by process tree. Expensive unmatched processes
                stay visible.
              </p>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              {snapshot ? (
                <>
                  <div>
                    Captured <FormattedDateTime iso={snapshot.sampled_at} kind="datetime" />
                  </div>
                  <div className="mt-1">
                    {formatAge((report.freshness_ms ?? 0) / 1_000)} ago · {snapshot.namespace}
                  </div>
                </>
              ) : (
                <span>No snapshot yet</span>
              )}
            </div>
          </header>

          {!snapshot ? (
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardHeader>
                <CardTitle className="text-base">Waiting for the resource observer</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                The dashboard starts the local supervisor automatically. Service status:{" "}
                {report.service.record?.state ?? "not started"}.
              </CardContent>
            </Card>
          ) : (
            <>
              <section
                aria-label="Machine pressure"
                className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
              >
                <MetricCard
                  icon={<Cpu aria-hidden />}
                  label="CPU"
                  value={formatPercent(snapshot.machine.cpu_percent)}
                  detail={`${snapshot.machine.cpu_logical_count} logical CPUs · ${formatMs(snapshot.sample_duration_ms)} sample`}
                  tone={pressureTone(snapshot.machine.cpu_percent)}
                />
                <MetricCard
                  icon={<MemoryStick aria-hidden />}
                  label="Memory"
                  value={formatPercent(snapshot.machine.memory_percent)}
                  detail={`${formatBytes(snapshot.machine.memory_used_bytes)} of ${formatBytes(snapshot.machine.memory_total_bytes)}`}
                  tone={pressureTone(snapshot.machine.memory_percent)}
                />
                <MetricCard
                  icon={<Gauge aria-hidden />}
                  label="Load average"
                  value={
                    snapshot.machine.load_average
                      ? snapshot.machine.load_average[0].toFixed(2)
                      : "Unknown"
                  }
                  detail={
                    snapshot.machine.load_average
                      ? `${snapshot.machine.load_average.map((value) => value.toFixed(2)).join(" · ")} over 1, 5, 15 minutes`
                      : "Not reported"
                  }
                  tone="sky"
                />
                <MetricCard
                  icon={<Activity aria-hidden />}
                  label="Processes"
                  value={snapshot.machine.process_count.toLocaleString()}
                  detail={`${snapshot.visible_process_count} shown · ${snapshot.unattributed_process_count} unattributed`}
                  tone={snapshot.unattributed_process_count > 0 ? "warning" : "success"}
                />
              </section>

              <section aria-labelledby="supervisor-heading" className="mb-6">
                <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <HeartPulse className="size-5 text-sky-500" aria-hidden />
                      <h2 id="supervisor-heading" className="text-lg font-semibold">
                        Local supervisor
                      </h2>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Service health, hook activity, recent pressure, and bounded finding evidence.
                    </p>
                  </div>
                  {supervisor.snapshot ? (
                    <div className="text-xs text-muted-foreground">
                      {`${formatMs(supervisor.snapshot.collector_duration_ms)} total collection · ${supervisor.snapshot.log_record_count} live log records`}
                    </div>
                  ) : null}
                </div>

                <div className="grid gap-3 xl:grid-cols-[1.1fr_1fr]">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <ServerCog className="size-4 text-sky-500" aria-hidden /> Service health
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {(supervisor.snapshot?.services ?? []).map((service) => (
                          <ServiceHealthRow key={service.id} service={service} />
                        ))}
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <History className="size-4 text-violet-500" aria-hidden /> 15-minute
                        pressure
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <MiniHistoryChart points={supervisor.history?.points ?? []} />
                    </CardContent>
                  </Card>
                </div>
              </section>

              {(supervisor.findings?.active.length ?? 0) > 0 ? (
                <section aria-labelledby="findings-heading" className="mb-6">
                  <div className="mb-3 flex items-center gap-2">
                    <CircleAlert className="size-5 text-amber-500" aria-hidden />
                    <h2 id="findings-heading" className="text-lg font-semibold">
                      Active findings
                    </h2>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {supervisor.findings?.active.map((finding) => (
                      <FindingCard key={finding.id} finding={finding} />
                    ))}
                  </div>
                </section>
              ) : null}

              {(supervisor.snapshot?.hooks.length ?? 0) > 0 ? (
                <section aria-labelledby="hooks-heading" className="mb-6">
                  <div className="mb-3 flex items-center gap-2">
                    <Workflow className="size-5 text-emerald-500" aria-hidden />
                    <h2 id="hooks-heading" className="text-lg font-semibold">
                      Active hooks
                    </h2>
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-border/60 bg-card">
                    <table className="min-w-[760px] w-full text-sm">
                      <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                        <tr>
                          <Th>Owner</Th>
                          <Th align="right">PID</Th>
                          <Th align="right">Age</Th>
                          <Th align="right">CPU</Th>
                          <Th align="right">Memory</Th>
                          <Th>Command</Th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        {supervisor.snapshot?.hooks.map((hook) => (
                          <tr key={hook.pid} className="align-top hover:bg-muted/30">
                            <Td>
                              <Owner
                                kind="agent"
                                id={hook.owner_id}
                                instanceToName={instanceToName}
                              />
                            </Td>
                            <Td align="right" mono>
                              {hook.pid}
                            </Td>
                            <Td align="right" mono>
                              {formatAge(hook.age_seconds)}
                            </Td>
                            <Td align="right" mono>
                              {formatPercent(hook.cpu_percent)}
                            </Td>
                            <Td align="right" mono>
                              {formatBytes(hook.rss_bytes)}
                            </Td>
                            <Td
                              mono
                              className="max-w-[420px] break-all text-xs text-muted-foreground"
                            >
                              {hook.command}
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : null}

              {supervisor.hookHealth ? (
                <section aria-labelledby="completed-hooks-heading" className="mb-6">
                  <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <Workflow className="size-5 text-violet-500" aria-hidden />
                        <h2 id="completed-hooks-heading" className="text-lg font-semibold">
                          Completed hook health
                        </h2>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Recent terminal receipts. Memory is the hook process RSS at completion, not
                        a process-tree peak.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge
                        variant={
                          supervisor.hookHealth?.capability.state === "supported"
                            ? "secondary"
                            : "warning"
                        }
                      >
                        {supervisor.hookHealth?.capability.state ?? "unavailable"}
                      </Badge>
                      <span className="text-muted-foreground">
                        {supervisor.hookHealth?.summary.invocation_count ?? 0} receipts ·{" "}
                        {supervisor.hookHealth?.summary.degraded_count ?? 0} degraded ·{" "}
                        {supervisor.hookHealth?.summary.faulted_count ?? 0} faulted
                      </span>
                    </div>
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-border/60 bg-card">
                    <table className="min-w-[980px] w-full text-sm">
                      <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                        <tr>
                          <Th>Hook</Th>
                          <Th>Adapter</Th>
                          <Th align="right">Runs</Th>
                          <Th align="right">P50</Th>
                          <Th align="right">P95</Th>
                          <Th align="right">Max</Th>
                          <Th align="right">Max memory</Th>
                          <Th align="right">Problems</Th>
                          <Th>Owners</Th>
                          <Th>Last seen</Th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        {supervisor.hookHealth.aggregates.length > 0 ? (
                          supervisor.hookHealth.aggregates.map((hook) => (
                            <CompletedHookRow
                              key={hook.key}
                              hook={hook}
                              instanceToName={instanceToName}
                            />
                          ))
                        ) : (
                          <tr>
                            <td colSpan={10} className="px-3 py-5 text-center">
                              <span className="text-sm text-muted-foreground">
                                No completed hook receipts are visible in the bounded log window.
                              </span>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : null}

              <section aria-labelledby="groups-heading" className="mb-6">
                <div className="mb-3 flex items-center gap-2">
                  <ServerCog className="size-5 text-sky-500" aria-hidden />
                  <h2 id="groups-heading" className="text-lg font-semibold">
                    Active resource groups
                  </h2>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {snapshot.groups.map((group) => (
                    <Card key={`${group.kind}:${group.id}`} className="min-w-0">
                      <CardContent className="p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <div className="break-all font-medium sm:truncate">
                              <Owner
                                kind={group.kind}
                                id={group.id}
                                instanceToName={instanceToName}
                              />
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {group.process_count} process{group.process_count === 1 ? "" : "es"}
                            </div>
                          </div>
                          <Badge variant={group.kind === "unattributed" ? "warning" : "secondary"}>
                            {group.kind}
                          </Badge>
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-3 text-sm tabular-nums">
                          <div>
                            <div className="text-xs text-muted-foreground">CPU</div>
                            <div className="font-semibold">{formatPercent(group.cpu_percent)}</div>
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground">Memory</div>
                            <div className="font-semibold">{formatBytes(group.rss_bytes)}</div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </section>

              <section aria-labelledby="processes-heading">
                <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 id="processes-heading" className="text-lg font-semibold">
                      Processes
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      Sorted by current CPU, then resident memory. Every shown row remains
                      searchable.
                    </p>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Supervisor resource overhead {formatMs(snapshot.collector_cpu_ms)} CPU per
                    sample
                  </div>
                </div>
                <div className="overflow-x-auto rounded-xl border border-border/60 bg-card">
                  <div className="divide-y divide-border/60 md:hidden">
                    {snapshot.processes.map((row) => (
                      <div key={row.start_id} className="space-y-2 p-3 text-xs">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <Owner
                              kind={row.owner_kind}
                              id={row.owner_id ?? "unattributed"}
                              instanceToName={instanceToName}
                            />
                            <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                              PID {row.pid} · {formatAge(row.age_seconds)} · {row.name}
                            </div>
                          </div>
                          <div className="shrink-0 text-right font-mono tabular-nums">
                            <div className="font-semibold">
                              {formatPercent(row.cpu_percent)} CPU
                            </div>
                            <div className="mt-1 text-muted-foreground">
                              {formatBytes(row.rss_bytes)}
                            </div>
                          </div>
                        </div>
                        <div className="break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
                          {row.command}
                        </div>
                      </div>
                    ))}
                  </div>
                  <table className="hidden min-w-[1040px] w-full text-sm md:table">
                    <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                      <tr>
                        <Th>Owner</Th>
                        <Th align="right">PID</Th>
                        <Th align="right">CPU</Th>
                        <Th align="right">Memory</Th>
                        <Th align="right">Age</Th>
                        <Th>Process</Th>
                        <Th>Command</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {snapshot.processes.map((row) => (
                        <tr key={row.start_id} className="align-top hover:bg-muted/30">
                          <Td>
                            <Owner
                              kind={row.owner_kind}
                              id={row.owner_id ?? "unattributed"}
                              instanceToName={instanceToName}
                            />
                          </Td>
                          <Td align="right" mono>
                            {row.pid}
                          </Td>
                          <Td align="right" mono>
                            {formatPercent(row.cpu_percent)}
                          </Td>
                          <Td align="right" mono>
                            {formatBytes(row.rss_bytes)}
                          </Td>
                          <Td align="right" mono>
                            {formatAge(row.age_seconds)}
                          </Td>
                          <Td mono>{row.name}</Td>
                          <Td
                            mono
                            className="max-w-[460px] break-all text-xs text-muted-foreground"
                          >
                            {row.command}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </AgentChipProvider>
  );
}

function CompletedHookRow({
  hook,
  instanceToName,
}: {
  hook: HookHealthAggregate;
  instanceToName: Record<string, string>;
}) {
  const problems = hook.degraded_count + hook.faulted_count;
  return (
    <tr className="align-top hover:bg-muted/30" data-hook-health-key={hook.key}>
      <Td mono>{hook.hook_name}</Td>
      <Td>
        <Badge variant="outline">{hook.adapter}</Badge>
      </Td>
      <Td align="right" mono>
        {hook.invocation_count}
      </Td>
      <Td align="right" mono>
        {formatMs(hook.duration_p50_ms)}
      </Td>
      <Td align="right" mono>
        {formatMs(hook.duration_p95_ms)}
      </Td>
      <Td align="right" mono>
        {formatMs(hook.duration_max_ms)}
      </Td>
      <Td align="right" mono>
        {formatBytes(hook.rss_end_max_bytes)}
      </Td>
      <Td align="right">
        <Badge variant={problems > 0 ? "warning" : "secondary"}>{problems}</Badge>
      </Td>
      <Td>
        <div className="flex max-w-72 flex-wrap gap-1">
          {hook.owner_ids.length > 0 ? (
            hook.owner_ids.map((ownerId) => (
              <Owner key={ownerId} kind="agent" id={ownerId} instanceToName={instanceToName} />
            ))
          ) : (
            <span className="text-xs text-muted-foreground">Unknown</span>
          )}
        </div>
      </Td>
      <Td>
        <FormattedDateTime iso={hook.latest_observed_at} kind="timestamp" />
      </Td>
    </tr>
  );
}

function Owner({
  kind,
  id,
  instanceToName,
}: {
  kind: "agent" | "service" | "unattributed";
  id: string;
  instanceToName: Record<string, string>;
}) {
  if (kind === "agent") {
    const name = instanceToName[id];
    return name ? <AgentChip name={name} /> : <span className="font-mono text-xs">{id}</span>;
  }
  return <span className="font-mono text-xs">{id}</span>;
}

function MetricCard({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: "success" | "warning" | "danger" | "sky";
}) {
  const toneClass = {
    success: "border-emerald-500/25 bg-emerald-500/5 text-emerald-600 dark:text-emerald-300",
    warning: "border-amber-500/25 bg-amber-500/5 text-amber-600 dark:text-amber-300",
    danger: "border-red-500/25 bg-red-500/5 text-red-600 dark:text-red-300",
    sky: "border-sky-500/25 bg-sky-500/5 text-sky-600 dark:text-sky-300",
  }[tone];
  return (
    <Card className={toneClass}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="[&>svg]:size-4">{icon}</span>
          {label}
        </div>
        <div className="mt-3 text-3xl font-semibold tabular-nums text-foreground">{value}</div>
        <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
      </CardContent>
    </Card>
  );
}

function ObserverBadge({ running, stale }: { running: boolean; stale: boolean }) {
  return (
    <Badge variant={running ? "success" : stale ? "warning" : "secondary"}>
      supervisor {running ? "running" : stale ? "stale" : "stopped"}
    </Badge>
  );
}

function ServiceHealthRow({ service }: { service: ObservedServiceHealth }) {
  const variant =
    service.state === "running" ? "success" : service.state === "stale" ? "warning" : "secondary";
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
      <div className="min-w-0">
        <div className="truncate font-mono text-xs font-medium">{service.id}</div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          {service.pid ? `PID ${service.pid}` : (service.reason ?? "No live process")}
        </div>
      </div>
      <Badge variant={variant}>{service.state}</Badge>
    </div>
  );
}

function MiniHistoryChart({ points }: { points: readonly SupervisorHistoryPoint[] }) {
  if (points.length < 2) {
    return (
      <div className="flex h-28 items-center justify-center text-xs text-muted-foreground">
        Building bounded history
      </div>
    );
  }
  const cpu = chartPoints(points.map((point) => point.machine.cpu_percent));
  const memory = chartPoints(points.map((point) => point.machine.memory_percent));
  const latest = points[points.length - 1]!;
  return (
    <div>
      <svg
        viewBox="0 0 100 36"
        role="img"
        aria-label="CPU and memory history"
        className="h-24 w-full overflow-visible"
      >
        <path
          d="M0 9H100 M0 18H100 M0 27H100"
          className="stroke-border"
          strokeWidth="0.35"
          fill="none"
        />
        {cpu ? (
          <polyline
            points={cpu}
            fill="none"
            stroke="rgb(14 165 233)"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {memory ? (
          <polyline
            points={memory}
            fill="none"
            stroke="rgb(168 85 247)"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>
          <span className="mr-1 inline-block size-2 rounded-full bg-sky-500" />
          CPU {formatPercent(latest.machine.cpu_percent)}
        </span>
        <span>
          <span className="mr-1 inline-block size-2 rounded-full bg-violet-500" />
          Memory {formatPercent(latest.machine.memory_percent)}
        </span>
        <span>{points.length} bounded points</span>
      </div>
    </div>
  );
}

function FindingCard({ finding }: { finding: SupervisorFinding }) {
  const variant = finding.severity === "critical" ? "destructive" : "warning";
  return (
    <Card
      className={
        finding.severity === "critical"
          ? "border-red-500/30 bg-red-500/5"
          : "border-amber-500/30 bg-amber-500/5"
      }
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-xs font-semibold">{finding.finding_kind}</div>
            <p className="mt-1 text-sm text-muted-foreground">{finding.summary}</p>
          </div>
          <div className="flex flex-wrap justify-end gap-1">
            {finding.occurrence_count > 1 ? (
              <Badge variant="secondary">×{finding.occurrence_count}</Badge>
            ) : null}
            <Badge variant={variant}>{finding.severity}</Badge>
          </div>
        </div>
        {finding.attribution || finding.workload_context ? (
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground/75">
            {finding.attribution ? <span>{findingOwnerLabel(finding)}</span> : null}
            {finding.workload_context ? (
              <span>{finding.workload_context.relationship.replaceAll("-", " ")}</span>
            ) : null}
          </div>
        ) : null}
        <div className="mt-3 text-[10px] text-muted-foreground">
          Opened <FormattedDateTime iso={finding.opened_at} kind="datetime" />
        </div>
      </CardContent>
    </Card>
  );
}

function findingOwnerLabel(finding: SupervisorFinding): string {
  if (!finding.attribution || finding.attribution.state === "unattributed") {
    return "Unattributed process";
  }
  return `${finding.attribution.owner_kind}:${finding.attribution.owner_id}`;
}

function chartPoints(values: readonly (number | null)[]): string | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length < 2) return null;
  const lastIndex = Math.max(1, values.length - 1);
  return values
    .map((value, index) => {
      if (value === null) return null;
      return `${((index / lastIndex) * 100).toFixed(2)},${(34 - Math.max(0, Math.min(100, value)) * 0.32).toFixed(2)}`;
    })
    .filter((value): value is string => value !== null)
    .join(" ");
}

function SupportBadge({ state }: { state: string }) {
  return <Badge variant={state === "supported" ? "secondary" : "warning"}>{state}</Badge>;
}

function pressureTone(value: number | null): "success" | "warning" | "danger" {
  if (value === null || value < 70) return "success";
  if (value < 90) return "warning";
  return "danger";
}

function formatPercent(value: number | null): string {
  return value === null ? "Warming up" : `${value.toFixed(1)}%`;
}

function formatBytes(value: number | null): string {
  if (value === null) return "Unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1_024 && unit < units.length - 1) {
    amount /= 1_024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3_600).toFixed(seconds < 36_000 ? 1 : 0)}h`;
  return `${(seconds / 86_400).toFixed(seconds < 864_000 ? 1 : 0)}d`;
}

function formatMs(value: number): string {
  return value < 1 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`;
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th className={`px-3 py-2.5 font-medium ${align === "right" ? "text-right" : ""}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  mono,
  className = "",
}: {
  children: React.ReactNode;
  align?: "right";
  mono?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`px-3 py-2.5 ${align === "right" ? "whitespace-nowrap text-right" : ""} ${mono ? "font-mono tabular-nums" : ""} ${className}`}
    >
      {children}
    </td>
  );
}
