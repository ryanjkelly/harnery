import Link from "next/link";
import { notFound } from "next/navigation";

import { AgentChip, AgentChipProvider } from "@/components/AgentChip";
import { Attention } from "@/components/Attention";
import { DecisionArchiveActions } from "@/components/DecisionArchiveActions";
import { DecisionReopenActions } from "@/components/DecisionReopenActions";
import { DecisionReviewActions } from "@/components/DecisionReviewActions";
import { StakesPill, StatusPill, TierPill, VerdictPill } from "@/components/decision/DecisionPills";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { NavBar } from "@/components/NavBar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildAgentSummaryMap } from "@/lib/agent-summary";
import {
  coordRoot,
  type InstanceIdentity,
  readAgents,
  readInstanceIdentities,
} from "@/lib/coord-reader";
import { readDecision } from "@/lib/decision-reader";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

function norm(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.startsWith("agent-") ? name : `agent-${name}`;
}

/** Resolve an actor field to a chip name. `claimed_by` stores an instance_id
 * (from `resolveOwner`), unlike `filed_by`/`resolved_by` which store the name;
 * map the id back through the identity index so the chip resolves + hovers
 * instead of showing a raw `agent-<uuid>`. */
function actorName(
  value: string | null | undefined,
  identities: Record<string, InstanceIdentity>,
): string | null {
  if (!value) return null;
  const bare = value.startsWith("agent-") ? value.slice("agent-".length) : value;
  return norm(identities[bare]?.name ?? identities[value]?.name ?? value);
}

export default async function DecisionDetailPage({ params }: PageProps) {
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  const detail = readDecision(decoded);
  if (!detail) notFound();

  const { manifest: m, bodies } = detail;
  const awaitingReview = m.status === "resolved" || m.status === "enacted";
  const identities = readInstanceIdentities();
  const filedBy = norm(m.filed_by);
  const resolvedBy = norm(m.resolution?.resolved_by);
  const claimedBy = actorName(m.claimed_by, identities);
  const claimerBare = m.claimed_by?.startsWith("agent-")
    ? m.claimed_by.slice("agent-".length)
    : m.claimed_by;
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
      <NavBar scannedDir={coordRoot()} />
      <main className="w-full max-w-4xl mx-auto px-6 pb-10">
        <nav className="mb-4 text-xs text-muted-foreground">
          <Link href="/decisions" className="hover:text-foreground">
            ← Decision docket
          </Link>
        </nav>

        <header className="mb-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <h1 className="min-w-0 text-lg font-semibold leading-snug max-w-2xl">{m.question}</h1>
            <TierPill tier={m.tier} />
          </div>
          <div className="mt-2.5 flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
            <StatusPill status={m.status} />
            <StakesPill stakes={m.stakes} />
            {m.review && <VerdictPill verdict={m.review.verdict} />}
            {filedBy && (
              <span className="inline-flex items-center gap-1">
                <span className="text-muted-foreground/60">filed by</span>
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
                  <span className="text-muted-foreground/60">claimed by</span>
                )}
                <AgentChip name={claimedBy} className="font-mono text-foreground/80" />
                {claimerWorking && <span className="text-emerald-400/90">working</span>}
              </span>
            )}
          </div>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground/60">{m.decision_id}</p>
        </header>

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
          <Card className="mb-4 border-emerald-500/30">
            <CardHeader>
              <CardTitle>Resolution</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm font-medium leading-relaxed">{m.resolution.recommendation}</p>
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                  Evidence
                </p>
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
      </main>
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
