import { Activity, Cpu, Gauge, MemoryStick, ServerCog } from "lucide-react";
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

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Resources · Harnery" };

export default function ResourcesPage() {
  const root = coordRoot();
  const report = readResourceDashboard(root);
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
                The dashboard starts the observer automatically on supported machines. Service
                status: {report.service.record?.state ?? "not started"}.
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

              <section aria-labelledby="groups-heading" className="mb-6">
                <div className="mb-3 flex items-center gap-2">
                  <ServerCog className="size-5 text-sky-500" aria-hidden />
                  <h2 id="groups-heading" className="text-lg font-semibold">
                    Active resource groups
                  </h2>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {snapshot.groups.map((group) => (
                    <Card key={`${group.kind}:${group.id}`}>
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate font-medium">
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
                    Observer overhead {formatMs(snapshot.collector_cpu_ms)} CPU per sample
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
      observer {running ? "running" : stale ? "stale" : "stopped"}
    </Badge>
  );
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
