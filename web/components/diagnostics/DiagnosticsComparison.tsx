import {
  Activity,
  ArrowRight,
  CircleCheck,
  CircleGauge,
  FileWarning,
  GitCompareArrows,
  HeartPulse,
} from "lucide-react";
import Link from "next/link";

import { FormattedDateTime } from "@/components/FormattedDateTime";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  DiagnosticBundleComparison,
  DiagnosticComparisonImpact,
  DiagnosticFindingComparison,
  DiagnosticHookHealthSummary,
  DiagnosticOptionalSourceComparison,
  DiagnosticShadowAdmissionSummary,
} from "../../../src/core/diagnostics/contract";

export function DiagnosticsComparison({
  comparison,
  binName,
}: {
  comparison: DiagnosticBundleComparison;
  binName: string;
}) {
  return (
    <div data-diagnostics-comparison={comparison.comparison_digest} className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Diagnostic comparison</h1>
            <Badge variant="accent">
              <GitCompareArrows aria-hidden /> Frozen evidence
            </Badge>
            <Badge variant={comparison.comparability === "comparable" ? "success" : "warning"}>
              {comparison.comparability}
            </Badge>
            <Badge variant="info">Observer only</Badge>
          </div>
          <p className="mt-2 max-w-3xl text-pretty text-sm text-muted-foreground">
            Two validated bundles, compared without reading current supervisor state or changing
            thresholds, hooks, processes, or workflow dispatch.
          </p>
        </div>
        <code className="max-w-full break-all font-mono text-[11px] text-muted-foreground">
          {comparison.comparison_digest}
        </code>
      </header>

      <Card className="overflow-hidden">
        <CardContent className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
          <BundleSummary label="Before" bundle={comparison.before} />
          <ArrowRight className="size-5 justify-self-center text-sky-500" aria-hidden />
          <BundleSummary label="After" bundle={comparison.after} />
        </CardContent>
      </Card>

      <section aria-labelledby="comparison-summary-heading">
        <h2 id="comparison-summary-heading" className="sr-only">
          Comparison summary
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <MetricCard
            label="Regressions"
            value={comparison.findings.regressions}
            impact="regression"
          />
          <MetricCard label="Worsened" value={comparison.findings.worsened} impact="worsened" />
          <MetricCard label="Changed" value={comparison.findings.changed} impact="changed" />
          <MetricCard label="Improved" value={comparison.findings.improved} impact="improved" />
          <MetricCard label="Recoveries" value={comparison.findings.recoveries} impact="recovery" />
          <MetricCard label="Unchanged" value={comparison.findings.unchanged} impact="unchanged" />
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CircleGauge className="size-4 text-sky-500" aria-hidden /> Pressure advice
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <PressureBadge pressure={comparison.before.pressure} />
            <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
            <PressureBadge pressure={comparison.after.pressure} />
            <Badge variant="outline">{comparison.advice.direction}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{comparison.advice.after.summary}</p>
        </CardContent>
      </Card>

      {comparison.warnings.length > 0 ? (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileWarning className="size-4 text-amber-500" aria-hidden /> Comparability warnings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {comparison.warnings.map((warning) => (
                <li key={warning.code} className="grid gap-1 sm:grid-cols-[auto_1fr] sm:gap-2">
                  <code className="font-mono text-xs text-amber-700 dark:text-amber-300">
                    {warning.code}
                  </code>
                  <span className="text-muted-foreground">{warning.summary}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <section aria-labelledby="signal-changes-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="signal-changes-heading" className="text-lg font-semibold">
            Signal changes
          </h2>
          <span className="text-xs text-muted-foreground">
            {comparison.findings.total} stable fingerprints
          </span>
        </div>
        {comparison.findings.rows.length > 0 ? (
          <ol aria-label="Diagnostic comparison findings" className="space-y-3">
            {comparison.findings.rows.map((row) => (
              <SignalChange
                key={row.fingerprint}
                row={row}
                beforeArtifactId={comparison.before.artifact_id}
                afterArtifactId={comparison.after.artifact_id}
              />
            ))}
          </ol>
        ) : (
          <Card>
            <CardContent className="flex-row items-center gap-2 text-sm text-muted-foreground">
              <CircleCheck className="size-4 text-emerald-500" aria-hidden /> Neither bundle
              contains a finding in its frozen selection.
            </CardContent>
          </Card>
        )}
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <OptionalEvidenceCard
          title="Completed hook health"
          icon={<HeartPulse className="size-4 text-purple-500" aria-hidden />}
          comparison={comparison.hook_health}
          rows={hookMetrics}
        />
        <OptionalEvidenceCard
          title="Shadow admission"
          icon={<Activity className="size-4 text-sky-500" aria-hidden />}
          comparison={comparison.shadow_admission}
          rows={admissionMetrics}
        />
      </div>

      {comparison.capabilities.some((row) => row.change !== "unchanged") ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Source capability changes</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2">
              {comparison.capabilities
                .filter((row) => row.change !== "unchanged")
                .map((row) => (
                  <li
                    key={row.source_kind}
                    className="grid gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
                  >
                    <code className="break-all font-mono">{row.source_kind}</code>
                    <Badge variant="outline">{row.before?.state ?? "not captured"}</Badge>
                    <Badge variant={row.after?.state === "supported" ? "success" : "warning"}>
                      {row.after?.state ?? "not captured"}
                    </Badge>
                  </li>
                ))}
            </ol>
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-sky-500/25 bg-sky-500/5">
        <CardContent>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Reproduce this comparison
          </div>
          <code className="break-all whitespace-pre-wrap font-mono text-xs">
            {`${binName} diagnostics compare ${comparison.before.artifact_id} ${comparison.after.artifact_id}`}
          </code>
        </CardContent>
      </Card>
    </div>
  );
}

function BundleSummary({
  label,
  bundle,
}: {
  label: string;
  bundle: DiagnosticBundleComparison["before"];
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <PressureBadge pressure={bundle.pressure} />
      </div>
      <Link
        href={`/diagnostics/bundles/${encodeURIComponent(bundle.artifact_id)}`}
        prefetch={false}
        className="mt-2 block break-all font-mono text-xs underline decoration-dotted underline-offset-2 hover:text-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {bundle.artifact_id}
      </Link>
      <div className="mt-2 text-xs text-muted-foreground">
        <FormattedDateTime iso={bundle.captured_at} kind="datetime" /> · {bundle.finding_count}{" "}
        findings
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  impact,
}: {
  label: string;
  value: number;
  impact: DiagnosticComparisonImpact;
}) {
  return (
    <Card className={`transition-colors motion-reduce:transition-none ${impactBorder(impact)}`}>
      <CardContent>
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}

function SignalChange({
  row,
  beforeArtifactId,
  afterArtifactId,
}: {
  row: DiagnosticFindingComparison;
  beforeArtifactId: string;
  afterArtifactId: string;
}) {
  const finding = row.after ?? row.before!;
  return (
    <li
      data-comparison-impact={row.impact}
      className={`rounded-xl border bg-card p-4 transition-colors motion-reduce:transition-none ${impactBorder(row.impact)}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ImpactBadge impact={row.impact} />
        <Badge variant="outline">{row.change_class}</Badge>
        <Badge variant="secondary">{humanize(finding.finding_kind)}</Badge>
        <span className="ml-auto text-[11px] text-muted-foreground">
          ×{finding.occurrence_count}
        </span>
      </div>
      <p className="mt-2 text-sm font-medium">{finding.summary}</p>
      <code className="mt-1 block break-all font-mono text-[11px] text-muted-foreground">
        {finding.scope_kind}:{finding.scope_id} · {row.fingerprint}
      </code>
      {row.field_changes.length > 0 ? (
        <dl className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {row.field_changes.map((change) => (
            <div key={change.field} className="rounded-lg border border-border/50 bg-muted/20 p-2">
              <dt className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {humanize(change.field)}
              </dt>
              <dd className="mt-1 break-all text-xs">
                {String(change.before)} <ArrowRight className="mx-1 inline size-3" aria-hidden />{" "}
                {String(change.after)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3 text-xs">
        {row.before ? (
          <Link
            href={findingHref(beforeArtifactId, row.before.id)}
            className="underline decoration-dotted underline-offset-2 hover:text-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Before episode
          </Link>
        ) : null}
        {row.after ? (
          <Link
            href={findingHref(afterArtifactId, row.after.id)}
            className="underline decoration-dotted underline-offset-2 hover:text-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            After episode
          </Link>
        ) : null}
      </div>
    </li>
  );
}

function OptionalEvidenceCard<T>({
  title,
  icon,
  comparison,
  rows,
}: {
  title: string;
  icon: React.ReactNode;
  comparison: DiagnosticOptionalSourceComparison<T>;
  rows: (value: T) => readonly [string, number][];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {icon} {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          <EvidenceColumn
            label="Before"
            capability={comparison.before_capability.state}
            value={comparison.before}
            rows={rows}
          />
          <EvidenceColumn
            label="After"
            capability={comparison.after_capability.state}
            value={comparison.after}
            rows={rows}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function EvidenceColumn<T>({
  label,
  capability,
  value,
  rows,
}: {
  label: string;
  capability: string;
  value?: T;
  rows: (value: T) => readonly [string, number][];
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <Badge variant={value ? "success" : "warning"}>{capability}</Badge>
      </div>
      {value ? (
        <dl className="mt-3 space-y-1 text-xs">
          {rows(value).map(([metric, amount]) => (
            <div key={metric} className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">{metric}</dt>
              <dd className="font-mono tabular-nums">{amount.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">Not captured in this bundle.</p>
      )}
    </div>
  );
}

function ImpactBadge({ impact }: { impact: DiagnosticComparisonImpact }) {
  const variant =
    impact === "regression"
      ? "destructive"
      : impact === "worsened"
        ? "warning"
        : impact === "improved"
          ? "info"
          : impact === "recovery"
            ? "success"
            : impact === "changed"
              ? "accent"
              : "muted";
  return <Badge variant={variant}>{impact}</Badge>;
}

function PressureBadge({
  pressure,
}: {
  pressure: DiagnosticBundleComparison["before"]["pressure"];
}) {
  const variant =
    pressure === "critical"
      ? "destructive"
      : pressure === "elevated"
        ? "warning"
        : pressure === "normal"
          ? "success"
          : "muted";
  return <Badge variant={variant}>{pressure}</Badge>;
}

function hookMetrics(value: DiagnosticHookHealthSummary): readonly [string, number][] {
  return [
    ["Invocations", value.invocation_count],
    ["Degraded", value.degraded_count],
    ["Faulted", value.faulted_count],
    ["Slow", value.slow_count],
    ["High memory", value.high_memory_count],
    ["Retries", value.retry_count],
  ];
}

function admissionMetrics(value: DiagnosticShadowAdmissionSummary): readonly [string, number][] {
  return [
    ["Records", value.record_count],
    ["Critical", value.critical_count],
    ["Elevated", value.elevated_count],
    ["Normal", value.normal_count],
    ["Unknown", value.unknown_count],
    ["Max wait ms", value.max_wait_ms],
  ];
}

function findingHref(artifactId: string, findingId: string): string {
  return `/diagnostics/bundles/${encodeURIComponent(artifactId)}?finding=${encodeURIComponent(findingId)}`;
}

function impactBorder(impact: DiagnosticComparisonImpact): string {
  if (impact === "regression") return "border-destructive/50 bg-destructive/5";
  if (impact === "worsened") return "border-amber-500/40 bg-amber-500/5";
  if (impact === "improved") return "border-sky-500/35 bg-sky-500/5";
  if (impact === "recovery") return "border-emerald-500/35 bg-emerald-500/5";
  if (impact === "changed") return "border-purple-500/35 bg-purple-500/5";
  return "border-border/60";
}

function humanize(value: string): string {
  return value.replace(/[._-]+/g, " ");
}
