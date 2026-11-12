import { HelperLimitControl } from "@/components/HelperLimitControl";
import { Notice } from "@/components/layout/Notice";
import {
  type HelperLimitReport,
  last24hLabel,
  limitInEffect,
  pairLabel,
  sourceLabel,
} from "@/lib/helper-limit";
import { TONE } from "@/lib/tone";

/**
 * "Helper agents (subagents)": the most expensive model and the highest
 * effort helpers may use, for all the person's projects, whether that limit
 * is active, and what helpers ran on in the last 24 hours. Rendered from
 * `harn devtools helpers`; one quiet line when that cannot be read.
 */
export function HelperAgentsBlock({ report }: { report: HelperLimitReport | null }) {
  if (!report) {
    return (
      <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
        The helper agent limit could not be read.
      </p>
    );
  }
  const from = sourceLabel(report.source);
  const inEffect = limitInEffect(report.limit);
  const covered = report.coverage.covered;
  const notCovered = report.coverage.not_covered;
  return (
    <div data-helper-limit className="mt-4 space-y-1.5 border-t border-border pt-3 text-xs">
      <h3 className="text-sm font-medium">Helper agents (subagents)</h3>
      <p>
        <span className="text-muted-foreground">Now: </span>
        {report.summary}
        {from ? <span className="text-muted-foreground">{` From: ${from}.`}</span> : null}
      </p>
      {inEffect ? (
        report.active ? (
          <p className={TONE.done.text}>Active in Claude Code.</p>
        ) : (
          <p className={TONE.warn.text}>
            {`Not active: ${report.inactive_reason ?? "Harnery cannot apply it right now."}`}
          </p>
        )
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5">
        <dt className="text-muted-foreground">All my projects</dt>
        <dd className="min-w-0">
          <HelperLimitControl
            ladders={report.ladders}
            user={report.user}
            hasProjectDefault={report.project_default !== null}
          />
        </dd>
        <dt className="text-muted-foreground">Project default</dt>
        <dd className="min-w-0">
          {report.project_default
            ? `${pairLabel(report.project_default)}. Set in .harnery/config.jsonc.`
            : "None. Set in .harnery/config.jsonc."}
        </dd>
      </dl>
      {covered.length || notCovered.length ? (
        <p className="text-muted-foreground">
          {covered.length ? `Covered: ${covered.join(", ")}.` : ""}
          {covered.length && notCovered.length ? " " : ""}
          {notCovered.length ? `Not covered: ${notCovered.join(", ")}.` : ""}
        </p>
      ) : null}
      <p className="text-muted-foreground">{last24hLabel(report.last_24h)}</p>
      {report.warnings.map((w) => (
        <Notice key={w} tone="warn" className="px-3 py-2 text-xs">
          {w}
        </Notice>
      ))}
    </div>
  );
}
