import { GitCompareArrows } from "lucide-react";

import { DiagnosticsComparison } from "@/components/diagnostics/DiagnosticsComparison";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { EmptyState } from "@/components/layout/EmptyState";
import { Notice } from "@/components/layout/Notice";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { hostInfo } from "@/lib/config";
import { coordRoot } from "@/lib/coord-reader";
import { readDiagnosticComparison } from "@/lib/diagnostics-reader";
import {
  type DiagnosticBundleComparison,
  listDiagnosticBundleCandidates,
} from "../../../../src/core/diagnostics/index";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Compare diagnostics · Harnery" };

interface PageProps {
  searchParams: Promise<{
    before?: string | string[];
    after?: string | string[];
  }>;
}

export default async function DiagnosticComparisonPage({ searchParams }: PageProps) {
  const root = coordRoot();
  const raw = await searchParams;
  const before = opaqueArtifactId(raw.before);
  const after = opaqueArtifactId(raw.after);
  const bundles = listDiagnosticBundleCandidates(root)
    .filter((bundle) => bundle.selectable && bundle.captured_at)
    .sort((left, right) => right.captured_at!.localeCompare(left.captured_at!));
  let comparison: DiagnosticBundleComparison | undefined;
  let error: string | undefined;
  if (before && after) {
    try {
      comparison = readDiagnosticComparison(root, before, after);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  } else if (raw.before !== undefined || raw.after !== undefined) {
    error = "Choose two opaque managed diagnostic bundle IDs.";
  }

  return (
    <PageShell width="wide">
      <section aria-labelledby="comparison-picker-heading" className="mb-6">
        <PageHeader
          className="mb-4"
          title={
            <span className="flex flex-wrap items-center gap-2">
              <GitCompareArrows className="size-5 text-sky-500" aria-hidden />
              <span id="comparison-picker-heading">Compare frozen bundles</span>
            </span>
          }
        />
        <form
          action="/diagnostics/compare"
          className="grid gap-3 rounded-xl border border-border/60 bg-card p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end"
        >
          <BundleSelect label="Before" name="before" value={before} bundles={bundles} />
          <BundleSelect label="After" name="after" value={after} bundles={bundles} />
          <button
            type="submit"
            disabled={bundles.length < 2}
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Compare
          </button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">
          {bundles.length} managed bundle candidate{bundles.length === 1 ? "" : "s"} available. The
          selected pair is fully validated before comparison.
        </p>
      </section>

      {error ? (
        <Notice tone="warn" className="mb-5">
          {error}
        </Notice>
      ) : null}

      {comparison ? (
        <DiagnosticsComparison comparison={comparison} binName={hostInfo().binName} />
      ) : (
        <EmptyState icon={<GitCompareArrows className="text-sky-500" aria-hidden />}>
          Select an earlier bundle and a later bundle to expose regressions, recoveries, and
          evidence changes.
        </EmptyState>
      )}
    </PageShell>
  );
}

function BundleSelect({
  label,
  name,
  value,
  bundles,
}: {
  label: string;
  name: "before" | "after";
  value?: string;
  bundles: ReturnType<typeof listDiagnosticBundleCandidates>;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <select
        name={name}
        required
        defaultValue={value ?? ""}
        className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <option value="">Choose a bundle</option>
        {bundles.map((bundle) => (
          <option key={bundle.artifact_id} value={bundle.artifact_id}>
            {bundle.artifact_id} · {bundle.captured_at}
          </option>
        ))}
      </select>
      {value ? (
        <span className="sr-only">
          Selected bundle{" "}
          <FormattedDateTime
            iso={bundles.find((bundle) => bundle.artifact_id === value)?.captured_at}
          />
        </span>
      ) : null}
    </label>
  );
}

function opaqueArtifactId(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : undefined;
}
