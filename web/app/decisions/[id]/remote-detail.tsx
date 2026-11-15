import { AgentChip, AgentChipProvider } from "@/components/AgentChip";
import {
  MachineBadge,
  ReachLine,
  RemoteStakes,
  RemoteStatus,
  RemoteTier,
} from "@/components/decision/RemoteDocket";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { Notice } from "@/components/layout/Notice";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { chipName } from "@/lib/decision-actors";
import { formatDuration } from "@/lib/format/duration";
import type { RemoteDecisionRow } from "@/lib/remote-docket-reader";
import { TONE } from "@/lib/tone";

/**
 * Read-only view of a decision shared from another machine. It shows exactly
 * what the docket blob carries (question, context, default, brief, a short
 * resolution) and nothing else: no review, claim or archive controls, and no
 * `Attention`, because only the filing machine can act on it.
 */
export function RemoteDecisionDetail({
  row,
  binName,
}: {
  row: RemoteDecisionRow;
  binName: string;
}) {
  const d = row.decision;
  const now = new Date().toISOString();
  const filedBy = chipName(d.filed_by);
  const claimedBy = chipName(d.claimed_by);
  const resolvedBy = chipName(d.resolved_by);
  return (
    // Empty summaries: a remote agent's name must never pick up a local
    // agent's hover card or its end-session control.
    <AgentChipProvider summaries={{}}>
      <PageShell width="narrow">
        <PageHeader
          back={{ href: "/decisions", label: "Decision docket" }}
          title={d.question}
          actions={<RemoteTier tier={d.tier} />}
          meta={
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <MachineBadge source={row.source} now={now} />
              <RemoteStatus status={d.status} />
              <RemoteStakes stakes={d.stakes} />
              {filedBy && (
                <span className="inline-flex items-center gap-1">
                  <span className="text-subtle-foreground">filed by</span>
                  <AgentChip name={filedBy} className="font-mono text-foreground/80" />
                </span>
              )}
              <FormattedDateTime iso={d.filed_at} />
              {claimedBy && (
                <span className="inline-flex items-center gap-1">
                  <span className="text-subtle-foreground">claimed by</span>
                  <AgentChip name={claimedBy} className="font-mono text-foreground/80" />
                </span>
              )}
            </div>
          }
          description={
            <span className="font-mono text-[11px] text-subtle-foreground">{d.decision_id}</span>
          }
        />

        <Notice
          tone={row.source.stale ? "warn" : "neutral"}
          title={`Shared from ${row.source.label}. Only that machine can resolve it.`}
          className="mb-4"
        >
          <p>
            {`This is a read-only copy published ${formatDuration(row.source.publishedAt, now)} ago.${
              row.source.stale
                ? " That machine has stopped refreshing it, so the decision may already be settled there."
                : ""
            } Resolve, claim or review it on ${row.source.label}. To reach its owner:`}
          </p>
          <div className="mt-2">
            <ReachLine binName={binName} source={row.source} />
          </div>
        </Notice>

        {(d.context || d.default_taken) && (
          <Card className="mb-4">
            <CardHeader>
              <CardTitle>Context</CardTitle>
            </CardHeader>
            <CardContent>
              {d.context && (
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{d.context}</p>
              )}
              {d.default_taken && (
                <p className={d.context ? "mt-3 text-sm" : "text-sm"}>
                  <span className="text-muted-foreground">Proceeded with: </span>
                  <span className="font-medium">{d.default_taken}</span>
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {(d.resolution_summary || d.resolved_at) && (
          <Card className={`mb-4 ${TONE.done.surface}`}>
            <CardHeader>
              <CardTitle>Resolution</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {d.resolution_summary && (
                <p className="text-sm font-medium leading-relaxed">{d.resolution_summary}</p>
              )}
              <p className="inline-flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                {resolvedBy && (
                  <>
                    <span>resolved by</span>
                    <AgentChip name={resolvedBy} className="font-mono text-foreground/80" />
                  </>
                )}
                {d.resolved_at && <FormattedDateTime iso={d.resolved_at} />}
                {d.review_verdict && <span>{`· review: ${d.review_verdict}`}</span>}
              </p>
              <p className="text-[11px] text-muted-foreground">
                The shared copy carries a short summary; the full evidence stays on the filing
                machine.
              </p>
            </CardContent>
          </Card>
        )}

        {d.brief ? (
          <Card className="mb-4">
            <CardHeader>
              <CardTitle className="font-mono text-sm">brief.md</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{d.brief}</pre>
              {d.brief_truncated && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {`Shortened in the shared copy. The full brief is on ${row.source.label}.`}
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          d.brief_truncated && (
            <p className="mb-4 text-xs text-muted-foreground">
              {`The brief was left out of the shared copy to fit its size cap. Read it on ${row.source.label}.`}
            </p>
          )
        )}
      </PageShell>
    </AgentChipProvider>
  );
}
