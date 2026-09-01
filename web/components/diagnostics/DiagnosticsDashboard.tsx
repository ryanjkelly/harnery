import { Activity, Archive, CircleCheck, CircleHelp, Clock3, FileWarning } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AgentChip } from "@/components/AgentChip";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type DiagnosticsQuery,
  type DiagnosticsViewModel,
  findingMatchesQuery,
} from "@/lib/diagnostics-reader";
import type {
  SupervisorCapability,
  SupervisorExplanationStatement,
  SupervisorFinding,
  SupervisorFindingExplanation,
  SupervisorPossibleExplanation,
  SupervisorTimeline,
} from "../../../src/core/supervisor/contract";

export type DiagnosticsFilters = DiagnosticsQuery;

export function DiagnosticsDashboard({
  model,
  filters,
  basePath,
  binName,
}: {
  model: DiagnosticsViewModel;
  filters: DiagnosticsFilters;
  basePath: string;
  binName: string;
}) {
  const sources = [...new Set(model.findings.map((finding) => finding.source_kind))].sort();
  const findings = model.findings.filter((finding) => findingMatchesQuery(finding, filters));
  const selected =
    model.selectedFinding && findings.some((finding) => finding.id === model.selectedFinding?.id)
      ? model.selectedFinding
      : undefined;
  const timeline = selected ? model.timeline : undefined;
  const explanation = selected ? model.explanation : undefined;
  return (
    <div data-diagnostics-mode={model.mode}>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Diagnostics</h1>
            <ModeBadge mode={model.mode} />
          </div>
          <p className="mt-2 max-w-3xl text-pretty text-sm text-muted-foreground">
            Follow a finding from direct observations through related evidence and clearly labeled
            possible explanations.
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          {model.capturedAt ? (
            <div>
              {model.mode === "frozen" ? "Captured" : "Observed"}{" "}
              <FormattedDateTime iso={model.capturedAt} kind="datetime" />
            </div>
          ) : (
            <div>Waiting for observations</div>
          )}
          {model.bundle ? (
            <code className="mt-1 block max-w-64 truncate font-mono">
              {model.bundle.artifact_id}
            </code>
          ) : null}
        </div>
      </header>

      {model.notice ? (
        <Card className="mb-5 border-amber-500/30 bg-amber-500/5">
          <CardContent className="flex-row items-center gap-2 text-sm text-muted-foreground">
            <FileWarning className="size-4 shrink-0 text-amber-500" aria-hidden />
            {model.notice}
          </CardContent>
        </Card>
      ) : null}

      <nav aria-label="Diagnostic source views" className="mb-5 flex flex-wrap gap-2 text-sm">
        <ContextLink href="/resources" label="Resources" />
        <ContextLink href="/logs" label="Log flow" />
        <ContextLink href="/events" label="Coordination events" />
        <ContextLink href="/diagnostics/compare" label="Compare bundles" />
      </nav>

      <form
        action={basePath}
        className="mb-5 grid gap-3 rounded-xl border border-border/60 bg-card p-4 sm:grid-cols-3"
      >
        <FilterSelect
          label="State"
          name="state"
          value={filters.state}
          options={["opened", "resolved"]}
        />
        <FilterSelect
          label="Severity"
          name="severity"
          value={filters.severity}
          options={["critical", "warning", "info"]}
        />
        <FilterSelect label="Source" name="source" value={filters.source} options={sources} />
        <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
          <button
            type="submit"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Apply filters
          </button>
          <Link
            href={basePath}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Clear
          </Link>
          <span aria-live="polite" className="ml-auto text-xs text-muted-foreground">
            {findings.length} of {model.findings.length} findings
          </span>
        </div>
      </form>

      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(280px,0.78fr)_minmax(0,1.5fr)]">
        <section aria-labelledby="finding-list-heading" className="min-w-0 max-w-full">
          <h2 id="finding-list-heading" className="mb-3 text-lg font-semibold">
            Findings
          </h2>
          {findings.length > 0 ? (
            <nav aria-label="Diagnostic findings">
              <ol className="space-y-2">
                {findings.map((finding) => {
                  const selectedNow = finding.id === selected?.id;
                  return (
                    <li
                      key={finding.id}
                      data-finding-id={finding.id}
                      data-finding-state={finding.state}
                      data-source-kind={finding.source_kind}
                    >
                      <Link
                        href={buildHref(basePath, { ...filters, finding: finding.id })}
                        aria-current={selectedNow ? "true" : undefined}
                        className={`block rounded-xl border p-3 transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 ${
                          selectedNow
                            ? "border-sky-500/60 bg-sky-500/10"
                            : "border-border/60 bg-card hover:border-sky-500/35 hover:bg-muted/30"
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <SeverityBadge severity={finding.severity} />
                          <StateBadge state={finding.state} />
                          <Badge variant="outline">{humanizeKind(finding.source_kind)}</Badge>
                          {finding.occurrence_count > 1 ? (
                            <Badge variant="secondary">×{finding.occurrence_count}</Badge>
                          ) : null}
                        </div>
                        <p className="mt-2 text-sm font-medium leading-snug">
                          {preventRunt(finding.summary)}
                        </p>
                        <div className="mt-2 grid min-w-0 gap-1 text-[11px] text-foreground/75 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                          <code className="min-w-0 break-all font-mono">{scopeLabel(finding)}</code>
                          <span className="whitespace-nowrap sm:text-right">
                            <FormattedDateTime iso={finding.observed_at} kind="timestamp" />
                          </span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </nav>
          ) : (
            <Card>
              <CardContent className="text-sm text-muted-foreground">
                No findings match these filters.
              </CardContent>
            </Card>
          )}
        </section>

        <section aria-labelledby="finding-detail-heading" className="min-w-0 max-w-full">
          {selected ? (
            <FindingDetail
              finding={selected}
              timeline={timeline}
              explanation={explanation}
              capabilities={model.capabilities}
              mode={model.mode}
              captureCommand={`${binName} diagnostics capture --finding ${selected.id}`}
            />
          ) : filters.finding ? (
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardContent className="items-center py-10 text-center text-sm text-muted-foreground">
                <FileWarning className="size-8 text-amber-500" aria-hidden />
                The requested finding is unavailable in this diagnostic view. The findings list is
                still available for inspection.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="items-center py-10 text-center text-sm text-muted-foreground">
                <CircleCheck className="size-8 text-emerald-500" aria-hidden />
                Nothing needs inspection in this view.
              </CardContent>
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}

function FindingDetail({
  finding,
  timeline,
  explanation,
  capabilities,
  mode,
  captureCommand,
}: {
  finding: SupervisorFinding;
  timeline?: SupervisorTimeline;
  explanation?: SupervisorFindingExplanation;
  capabilities: readonly SupervisorCapability[];
  mode: DiagnosticsViewModel["mode"];
  captureCommand: string;
}) {
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={finding.severity} />
            <StateBadge state={finding.state} />
            <Badge variant="outline">{humanizeKind(finding.finding_kind)}</Badge>
          </div>
          <CardTitle id="finding-detail-heading" className="mt-2 text-lg">
            {finding.summary}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            <Fact
              label="Opened"
              value={<FormattedDateTime iso={finding.opened_at} kind="datetime" />}
            />
            <Fact
              label="Last observed"
              value={<FormattedDateTime iso={finding.observed_at} kind="datetime" />}
            />
            <Fact
              label="Scope"
              value={
                finding.scope_kind === "agent" ? (
                  <AgentChip name={finding.scope_id} />
                ) : (
                  scopeLabel(finding)
                )
              }
              mono={finding.scope_kind !== "agent" && finding.scope_kind !== "unattributed"}
            />
            <Fact label="Finding ID" value={finding.id} mono />
            <Fact label="Occurrences" value={finding.occurrence_count.toLocaleString()} />
            {finding.peak_observed_value !== undefined ? (
              <Fact
                label="Peak"
                value={formatEvidenceValue(finding.peak_observed_value, finding.peak_unit)}
              />
            ) : null}
            {finding.attribution ? (
              <Fact label="Owner" value={<FindingOwner finding={finding} />} />
            ) : null}
            {finding.workload_context ? (
              <Fact
                label="Workload context"
                value={`${humanizeKind(finding.workload_context.relationship)} · ${humanizeKind(
                  finding.workload_context.declared_activity,
                )} · ${humanizeKind(finding.workload_context.task_state)}`}
              />
            ) : null}
          </dl>
          {mode === "live" ? (
            <div className="mt-2 rounded-lg border border-border/60 bg-muted/30 p-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Preserve this evidence
              </div>
              <code className="mt-1 block break-all whitespace-pre-wrap font-mono text-xs">
                {captureCommand}
              </code>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              This evidence is frozen. It does not read or merge current supervisor state.
            </p>
          )}
        </CardContent>
      </Card>

      <TimelineView timeline={timeline} finding={finding} />
      <ExplanationView explanation={explanation} />
      <CapabilityView capabilities={capabilities} />
    </div>
  );
}

function TimelineView({
  timeline,
  finding,
}: {
  timeline?: SupervisorTimeline;
  finding: SupervisorFinding;
}) {
  const entries =
    timeline?.entries ??
    finding.evidence.map((evidence) => ({
      id: evidence.id,
      occurred_at: evidence.source.observed_at,
      relation: "observed" as const,
      summary: evidence.summary,
      source: evidence.source,
      evidence_id: evidence.id,
    }));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock3 className="size-4 text-sky-500" aria-hidden /> Incident timeline
        </CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length > 0 ? (
          <ol className="relative space-y-0 border-l border-border/80 pl-5">
            {entries.map((entry) => (
              <li key={entry.id} className="relative pb-5 last:pb-0">
                <span className="absolute -left-[25px] top-1.5 size-2 rounded-full border border-background bg-sky-500 ring-2 ring-sky-500/20" />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={relationVariant(entry.relation)}>{entry.relation}</Badge>
                  <span className="text-[11px] text-foreground/75">
                    <FormattedDateTime iso={entry.occurred_at} kind="datetime" />
                  </span>
                </div>
                <p className="mt-1 text-sm">{preventRunt(entry.summary)}</p>
                <Link
                  href={sourceHref(
                    entry.source.source_kind,
                    entry.source.record_id ?? entry.source.source_id,
                  )}
                  className="mt-1 inline-flex break-all font-mono text-[11px] text-foreground/75 underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {entry.source.source_kind} · {entry.source.source_id}
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No timeline evidence was captured.</p>
        )}
        {timeline?.omitted_entries ? (
          <p className="text-xs text-muted-foreground">
            {timeline.omitted_entries} older entries omitted by the bundle limit.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ExplanationView({ explanation }: { explanation?: SupervisorFindingExplanation }) {
  if (!explanation) {
    return (
      <Card>
        <CardContent className="flex-row items-center gap-2 text-sm text-muted-foreground">
          <CircleHelp className="size-4 text-muted-foreground" aria-hidden />
          No ranked explanation is available for this finding.
        </CardContent>
      </Card>
    );
  }
  return (
    <section aria-labelledby="explanation-heading">
      <h3 id="explanation-heading" className="mb-3 text-base font-semibold">
        Evidence-ranked explanation
      </h3>
      <div className="grid gap-3 lg:grid-cols-3">
        <StatementTier
          icon={<CircleCheck className="size-4 text-emerald-500" aria-hidden />}
          title="Observed"
          description="Direct evidence"
          statements={explanation.observed}
        />
        <StatementTier
          icon={<Activity className="size-4 text-sky-500" aria-hidden />}
          title="Related"
          description="Nearby or shared context"
          statements={explanation.related}
        />
        <PossibleTier statements={explanation.possible} />
      </div>
    </section>
  );
}

function StatementTier({
  icon,
  title,
  description,
  statements,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  statements: readonly SupervisorExplanationStatement[];
}) {
  return (
    <Card data-explanation-tier={title.toLowerCase()}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>
        <StatementList statements={statements} />
      </CardContent>
    </Card>
  );
}

function PossibleTier({ statements }: { statements: readonly SupervisorPossibleExplanation[] }) {
  return (
    <Card className="border-amber-500/25" data-explanation-tier="possible">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CircleHelp className="size-4 text-amber-500" aria-hidden /> Possible
        </CardTitle>
        <p className="text-xs text-muted-foreground">Hypotheses, not causes</p>
      </CardHeader>
      <CardContent>
        {statements.length > 0 ? (
          <ul className="space-y-3">
            {statements.map((statement) => (
              <li key={statement.id} className="text-sm">
                <div className="flex items-start justify-between gap-2">
                  <span>{statement.summary}</span>
                  <Badge variant="warning">{statement.confidence}</Badge>
                </div>
                {statement.evidence_against_ids.length > 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {statement.evidence_against_ids.length} contrary evidence reference(s)
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No supported hypothesis.</p>
        )}
      </CardContent>
    </Card>
  );
}

function StatementList({ statements }: { statements: readonly SupervisorExplanationStatement[] }) {
  return statements.length > 0 ? (
    <ul className="space-y-3">
      {statements.map((statement) => (
        <li key={statement.id} className="text-sm">
          {statement.summary}
          <p className="mt-1 text-xs text-muted-foreground">
            {statement.evidence_ids.length} evidence reference(s)
          </p>
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-sm text-muted-foreground">No evidence in this tier.</p>
  );
}

function CapabilityView({ capabilities }: { capabilities: readonly SupervisorCapability[] }) {
  if (capabilities.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Source capability</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 sm:grid-cols-2">
          {capabilities.map((capability) => (
            <li
              key={capability.source_kind}
              data-capability-state={capability.state}
              className="rounded-lg border border-border/60 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <code className="break-all font-mono text-xs">{capability.source_kind}</code>
                <CapabilityBadge capability={capability} />
              </div>
              {capability.detail || capability.reason_code ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {capability.detail ?? humanizeKind(capability.reason_code ?? "unavailable")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ModeBadge({ mode }: { mode: DiagnosticsViewModel["mode"] }) {
  return mode === "live" ? (
    <Badge variant="success">
      <span className="live-dot !mr-0 !size-1.5 motion-reduce:animate-none" aria-hidden /> Live
    </Badge>
  ) : (
    <Badge variant="accent">
      <Archive aria-hidden /> Frozen bundle
    </Badge>
  );
}

function SeverityBadge({ severity }: { severity: SupervisorFinding["severity"] }) {
  const variant =
    severity === "critical" ? "destructive" : severity === "warning" ? "warning" : "info";
  return <Badge variant={variant}>{severity}</Badge>;
}

function StateBadge({ state }: { state: SupervisorFinding["state"] }) {
  return <Badge variant={state === "resolved" ? "success" : "info"}>{state}</Badge>;
}

function CapabilityBadge({ capability }: { capability: SupervisorCapability }) {
  const variant =
    capability.state === "supported"
      ? "success"
      : capability.state === "partial"
        ? "warning"
        : "destructive";
  return <Badge variant={variant}>{capability.state}</Badge>;
}

function ContextLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-full border border-border/60 bg-card px-3 py-1.5 text-muted-foreground hover:border-sky-500/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {label}
    </Link>
  );
}

function FilterSelect({
  label,
  name,
  value,
  options,
}: {
  label: string;
  name: string;
  value?: string;
  options: readonly string[];
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <select
        name={name}
        defaultValue={value ?? ""}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {humanizeKind(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-2">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className={`mt-1 break-all ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function FindingOwner({ finding }: { finding: SupervisorFinding }) {
  const attribution = finding.attribution;
  if (!attribution || attribution.state === "unattributed") {
    return <span>Unattributed · no validated process anchor</span>;
  }
  if (attribution.owner_kind === "agent" && attribution.owner_id) {
    return <AgentChip name={attribution.owner_id} />;
  }
  return <span>{`${attribution.owner_kind ?? "owner"}:${attribution.owner_id ?? "unknown"}`}</span>;
}

function formatEvidenceValue(value: number, unit: SupervisorFinding["peak_unit"]): string {
  if (unit === "bytes") return formatBytes(value);
  if (unit === "percent") return `${value.toLocaleString()}%`;
  if (unit === "milliseconds") return `${value.toLocaleString()} ms`;
  if (unit === "seconds") return `${value.toLocaleString()} s`;
  return `${value.toLocaleString()}${unit ? ` ${unit}` : ""}`;
}

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let index = 0;
  while (amount >= 1_024 && index < units.length - 1) {
    amount /= 1_024;
    index += 1;
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function preventRunt(value: string): string {
  return value.replace(/\s+(\S+)$/, "\u00a0$1");
}

function scopeLabel(finding: SupervisorFinding): string {
  if (finding.scope_kind === "unattributed") return "Processes without a known owner";
  return `${finding.scope_kind}:${finding.scope_id}`;
}

function buildHref(basePath: string, filters: DiagnosticsFilters): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const suffix = query.toString();
  return suffix ? `${basePath}?${suffix}` : basePath;
}

function humanizeKind(value: string): string {
  return value.replace(/[._-]+/g, " ");
}

function relationVariant(
  relation: SupervisorTimeline["entries"][number]["relation"],
): "info" | "success" | "warning" | "muted" {
  if (relation === "opened") return "warning";
  if (relation === "resolved") return "success";
  if (relation === "observed") return "info";
  return "muted";
}

function sourceHref(sourceKind: string, sourceId: string): string {
  if (
    sourceKind.startsWith("resource.") ||
    sourceKind.startsWith("hook.") ||
    sourceKind === "service.health"
  ) {
    return "/resources";
  }
  if (sourceKind.startsWith("log.")) return "/logs";
  if (sourceKind.startsWith("coordination.")) {
    return `/events?q=${encodeURIComponent(sourceId)}`;
  }
  return "/events";
}
