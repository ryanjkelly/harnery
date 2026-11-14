import { notFound } from "next/navigation";

import { AgentChip, AgentChipProvider } from "@/components/AgentChip";
import { Attention } from "@/components/Attention";
import { DecisionArchiveActions } from "@/components/DecisionArchiveActions";
import { DecisionReopenActions } from "@/components/DecisionReopenActions";
import { DecisionReviewActions } from "@/components/DecisionReviewActions";
import { StakesPill, StatusPill, TierPill, VerdictPill } from "@/components/decision/DecisionPills";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Eyebrow } from "@/components/layout/Section";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildAgentSummaryMap } from "@/lib/agent-summary";
import { readAgents, readInstanceIdentities } from "@/lib/coord-reader";
import { actorName, chipName } from "@/lib/decision-actors";
import { readDecision } from "@/lib/decision-reader";
import { bareName } from "@/lib/identities";
import { TONE } from "@/lib/tone";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function DecisionDetailPage({ params }: PageProps) {
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  const detail = readDecision(decoded);
  if (!detail) notFound();

  const { manifest: m, bodies } = detail;
  const awaitingReview = m.status === "resolved" || m.status === "enacted";
  const identities = readInstanceIdentities();
  const filedBy = chipName(m.filed_by);
  const resolvedBy = chipName(m.resolution?.resolved_by);
  const claimedBy = actorName(m.claimed_by, identities);
  const claimerBare = m.claimed_by ? bareName(m.claimed_by) : m.claimed_by;
  // "working" = the claimer is live AND the decision is still being deliberated.
  // Once resolved/reviewed, claimed_by lingers but the agent isn't working it,
  // so a live session shouldn't imply active work on this decision.
  const claimerWorking =
    m.status === "deliberating" &&
    !!claimerBare &&
    readAgents().active.some(
      (a) => a.instance_id === claimerBare || a.instance_id === m.claimed_by,
    );

  const names = new Set<string>();
  for (const n of [filedBy, resolvedBy, claimedBy]) if (n) names.add(n);
  const summaries = buildAgentSummaryMap(names);

  return (
    <AgentChipProvider summaries={summaries}>
      <PageShell width="narrow">
        <PageHeader
          back={{ href: "/decisions", label: "Decision docket" }}
          title={m.question}
          actions={<TierPill tier={m.tier} />}
          meta={
            <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
              <StatusPill status={m.status} />
              <StakesPill stakes={m.stakes} />
              {m.review && <VerdictPill verdict={m.review.verdict} />}
              {filedBy && (
                <span className="inline-flex items-center gap-1">
                  <span className="text-subtle-foreground">filed by</span>
                  <AgentChip name={filedBy} className="font-mono text-foreground/80" />
                </span>
              )}
              <span>
                <FormattedDateTime iso={m.filed_at} />
              </span>
              {claimedBy && (
                <span className="inline-flex items-center gap-1">
                  {claimerWorking ? (
                    <span className="live-dot" aria-hidden />
                  ) : (
                    <span className="text-subtle-foreground">claimed by</span>
                  )}
                  <AgentChip name={claimedBy} className="font-mono text-foreground/80" />
                  {claimerWorking && <span className={TONE.done.text}>working</span>}
                </span>
              )}
            </div>
          }
          description={
            <span className="font-mono text-[11px] text-subtle-foreground">{m.decision_id}</span>
          }
        />

        {awaitingReview && (
          <Attention
            request={{ key: `decision-review-${m.decision_id}`, label: "Decision awaiting review" }}
          />
        )}

        {m.context && (
          <Card className="mb-4">
            <CardHeader>
              <CardTitle>Context</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm whitespace-pre-wrap leading-relaxed">{m.context}</p>
              {m.default_taken && (
                <p className="text-sm mt-3">
                  <span className="text-muted-foreground">Proceeded with: </span>
                  <span className="font-medium">{m.default_taken}</span>
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {m.resolution && (
          <Card className={`mb-4 ${TONE.done.surface}`}>
            <CardHeader>
              <CardTitle>Resolution</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm font-medium leading-relaxed">{m.resolution.recommendation}</p>
              <div>
                <Eyebrow className="mb-1">Evidence</Eyebrow>
                <ul className="list-disc pl-5 space-y-1 text-sm">
                  {m.resolution.evidence.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <Field label="Confidence" value={m.resolution.confidence} />
                <Field label="Reversal cost" value={m.resolution.reversal_cost} />
                <Field label="Wrong if" value={m.resolution.wrong_if} />
                <Field label="Revisit when" value={m.resolution.revisit_when} />
              </dl>
              <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                resolved by{" "}
                {resolvedBy ? (
                  <AgentChip name={resolvedBy} className="font-mono text-foreground/80" />
                ) : (
                  <span className="font-mono">unknown</span>
                )}{" "}
                <FormattedDateTime iso={m.resolution.resolved_at} />
              </p>
            </CardContent>
          </Card>
        )}

        {bodies.map((b) => (
          <Card key={b.name} className="mb-4">
            <CardHeader>
              <CardTitle className="font-mono text-sm">{b.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-xs whitespace-pre-wrap font-mono leading-relaxed">
                {b.content}
              </pre>
            </CardContent>
          </Card>
        ))}

        {m.review ? (
          <>
            <Card className="mb-4">
              <CardHeader>
                <CardTitle>Review</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Verdict:</span>
                  <VerdictPill verdict={m.review.verdict} />
                </div>
                {m.review.note && <p className="text-sm whitespace-pre-wrap">{m.review.note}</p>}
                <p className="text-[11px] text-muted-foreground">
                  reviewed <FormattedDateTime iso={m.review.reviewed_at} />
                </p>
              </CardContent>
            </Card>
            {m.status === "reviewed" && <DecisionArchiveActions decisionId={m.decision_id} />}
            {m.graduated_to && (
              <p className="text-[11px] text-muted-foreground">
                graduated to <span className="font-mono text-foreground/80">{m.graduated_to}</span>
              </p>
            )}
            {m.status === "archived" && <DecisionReopenActions decisionId={m.decision_id} />}
          </>
        ) : awaitingReview ? (
          <DecisionReviewActions decisionId={m.decision_id} />
        ) : null}
      </PageShell>
    </AgentChipProvider>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}
