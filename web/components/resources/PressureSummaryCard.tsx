import { CircleGauge, TriangleAlert } from "lucide-react";
import { AgentChip } from "@/components/AgentChip";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";
import type {
  PressureAssessment,
  PressureContributor,
  PressureState,
} from "../../../src/core/diagnostics/contract";
import type { SupervisorCapability } from "../../../src/core/supervisor/contract";

/**
 * The one published assessment, rendered above the charts so the page, the CLI,
 * the prompt notice, and a diagnostic bundle all say the same thing. A
 * dimension the platform does not expose reads "unavailable" here; it is never
 * drawn as healthy.
 */
export function PressureSummaryCard({
  assessment,
  capability,
}: {
  assessment: PressureAssessment;
  capability: SupervisorCapability;
}) {
  const unknown = assessment.state === "unknown";
  const named = assessment.contributors.filter(
    (row) => row.attribution_confidence === "exact" && row.owner_kind === "agent" && row.owner_id,
  );
  const unattributed = assessment.unattributed_memory_percent;
  return (
    <Card
      className={unknown ? "mb-6 border-amber-500/30 bg-amber-500/5" : "mb-6"}
      data-pressure-summary={assessment.state}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          {unknown ? (
            <TriangleAlert className="size-4 text-amber-500" aria-hidden />
          ) : (
            <CircleGauge className="size-4 text-sky-500" aria-hidden />
          )}
          Resource pressure
          <StateBadge state={assessment.state} />
          <Badge variant="outline">{`${assessment.scope} scope`}</Badge>
          <Badge variant="outline">{`recommended: ${assessment.recommended_action}`}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{assessment.summary}</p>

        <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 xl:grid-cols-5">
          <Field label="State" value={assessment.state} />
          <Field label="Scope" value={assessment.scope} />
          <Field label="Trend" value={assessment.trend} />
          <Field label="Evidence age" value={formatAge(assessment.sample_age_ms)} />
          <Field label="Limiting resource" value={assessment.limiting_resource} />
        </dl>

        <p className="text-xs text-muted-foreground">
          {`Evidence is ${assessment.evidence_state}. Source ${capability.source_kind} is ${capability.state}${capability.reason_code ? ` (${capability.reason_code})` : ""}.`}
        </p>

        <div>
          <h3 className="text-xs font-medium">Measured dimensions</h3>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {assessment.evidence.map((row) => (
              <li key={row.dimension}>
                <Tooltip
                  content={
                    row.state === "unavailable"
                      ? `This platform does not report ${row.dimension.replaceAll("_", " ")}, so it is unavailable rather than clear.`
                      : `${row.dimension.replaceAll("_", " ")} held its current side of the threshold for ${row.sample_count} sample(s).`
                  }
                >
                  <Badge
                    variant={row.state === "unavailable" ? "outline" : "secondary"}
                    className={row.state === "unavailable" ? "text-muted-foreground" : undefined}
                  >
                    {`${row.dimension.replaceAll("_", " ")}: ${
                      row.state === "unavailable"
                        ? "unavailable"
                        : formatValue(row.observed_value, row.unit)
                    }`}
                  </Badge>
                </Tooltip>
              </li>
            ))}
          </ul>
        </div>

        {assessment.reasons.length > 0 ? (
          <div>
            <h3 className="text-xs font-medium">Why</h3>
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {assessment.reasons.map((reason) => (
                <li key={reason.code}>{reason.summary}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div>
          <h3 className="text-xs font-medium">
            Contributors
            <span className="ml-1 font-normal text-muted-foreground">
              who holds the resource, never the machine state
            </span>
          </h3>
          {assessment.contributors.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              No process, group, or hook is currently named as a contributor.
            </p>
          ) : (
            <ul className="mt-1 space-y-1 text-xs">
              {assessment.contributors.map((row) => (
                <li key={row.finding_id} className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{row.finding_kind}</Badge>
                  <span className="text-muted-foreground">{`${row.scope_kind}:${row.scope_id}`}</span>
                  <Owner contributor={row} />
                  <span className="text-muted-foreground">{row.summary}</span>
                </li>
              ))}
            </ul>
          )}
          {assessment.omitted_contributor_count > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {`${assessment.omitted_contributor_count} further contributors were omitted to keep this read bounded.`}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            {unattributed === null
              ? "Unattributed memory share is unavailable."
              : `${Math.round(unattributed)}% of machine memory has no validated owner.`}
          </p>
          {named.length > 0 ? (
            <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              Named owners:
              {named.map((row) => (
                <AgentChip key={row.finding_id} name={row.owner_id as string} />
              ))}
            </p>
          ) : null}
        </div>

        {assessment.guidance.length > 0 ? (
          <div>
            <h3 className="text-xs font-medium">What to do</h3>
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {assessment.guidance.map((row) => (
                <li key={row.workload_class}>
                  {`${WORKLOAD_LABEL[row.workload_class] ?? row.workload_class}: ${row.summary}`}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

const WORKLOAD_LABEL: Record<string, string> = {
  lightweight: "Reads and small edits",
  "cpu-heavy": "Builds and test runs",
  "memory-heavy": "Browser captures and page QA",
  "storage-heavy": "Large writes and exports",
};

/** Ownership is shown only when attribution is exact. */
function Owner({ contributor }: { contributor: PressureContributor }) {
  if (contributor.attribution_confidence === "exact" && contributor.owner_id) {
    return contributor.owner_kind === "agent" ? (
      <AgentChip name={contributor.owner_id} />
    ) : (
      <span>{`${contributor.owner_kind ?? "owner"} ${contributor.owner_id}`}</span>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {contributor.attribution_state === "unattributed"
        ? "no validated owner"
        : "owner unconfirmed"}
    </Badge>
  );
}

function StateBadge({ state }: { state: PressureState }) {
  // Colour grammar: sky means act now, neutral means wait, emerald means done.
  if (state === "critical") return <Badge variant="destructive">critical</Badge>;
  if (state === "elevated") return <Badge variant="default">elevated</Badge>;
  if (state === "normal") return <Badge variant="secondary">normal</Badge>;
  return <Badge variant="outline">unknown</Badge>;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function formatAge(ms: number | null): string {
  if (ms === null) return "unavailable";
  if (ms < 1_000) return "under a second";
  const seconds = Math.round(ms / 1_000);
  return seconds < 120 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;
}

function formatValue(value: number | null, unit: string | null): string {
  if (value === null) return "not reported";
  switch (unit) {
    case "percent":
      return `${Math.round(value)}%`;
    case "bytes":
      return formatBytes(value);
    case "bytes-per-second":
      return `${formatBytes(value)}/s`;
    case "pages-per-second":
      return `${Math.round(value)} pages/s`;
    case "milliseconds":
      return `${Math.round(value)} ms`;
    default:
      return `${value}`;
  }
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${Math.round(bytes / 1024 ** 2)} MiB`;
}
