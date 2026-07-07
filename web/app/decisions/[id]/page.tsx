import Link from "next/link";
import { notFound } from "next/navigation";

import { Attention } from "@/components/Attention";
import { DecisionReviewActions } from "@/components/DecisionReviewActions";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { NavBar } from "@/components/NavBar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { coordRoot } from "@/lib/coord-reader";
import { readDecision } from "@/lib/decision-reader";

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

  return (
    <>
      <NavBar scannedDir={coordRoot()} />
      <main className="w-full max-w-4xl mx-auto px-6 pb-10">
        <nav className="mb-4 text-xs text-muted-foreground">
          <Link href="/decisions" className="hover:text-foreground">
            ← Decision docket
          </Link>
        </nav>

        <header className="mb-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <h1 className="text-lg font-semibold leading-snug max-w-2xl">{m.question}</h1>
            <TierPill tier={m.tier} />
          </div>
          <div className="mt-2 flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
            <StatusPill status={m.status} />
            <StakesPill stakes={m.stakes} />
            {m.filed_by && <span className="font-mono">filed by {m.filed_by}</span>}
            <span>
              filed <FormattedDateTime iso={m.filed_at} />
            </span>
            {m.claimed_by && <span className="font-mono">claimed by {m.claimed_by}</span>}
            <span className="font-mono text-muted-foreground/70">{m.decision_id}</span>
          </div>
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
              <p className="text-[11px] text-muted-foreground">
                resolved by <span className="font-mono">{m.resolution.resolved_by}</span>{" "}
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
          <Card className="mb-4">
            <CardHeader>
              <CardTitle>Review</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm">
                <span className="text-muted-foreground">Verdict: </span>
                <span className="font-medium">{m.review.verdict}</span>
              </p>
              {m.review.note && <p className="text-sm mt-1 whitespace-pre-wrap">{m.review.note}</p>}
              <p className="text-[11px] text-muted-foreground mt-2">
                reviewed <FormattedDateTime iso={m.review.reviewed_at} />
              </p>
            </CardContent>
          </Card>
        ) : awaitingReview ? (
          <DecisionReviewActions decisionId={m.decision_id} />
        ) : null}
      </main>
    </>
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

function TierPill({ tier }: { tier: number }) {
  const label =
    tier === 2 ? "Tier 2 · your call" : tier === 1 ? "Tier 1 · review" : "Tier 0 · auto";
  const cls =
    tier === 2
      ? "bg-sky-500/15 text-sky-300 border-sky-500/30"
      : tier === 1
        ? "bg-muted/60 text-foreground/80 border-border"
        : "bg-muted/30 text-muted-foreground border-border/60";
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

function StakesPill({ stakes }: { stakes: string }) {
  const cls =
    stakes === "high"
      ? "text-red-300 border-red-500/30"
      : stakes === "medium"
        ? "text-amber-300 border-amber-500/30"
        : "text-muted-foreground border-border/60";
  return <span className={`rounded-full border px-1.5 py-0.5 ${cls}`}>{stakes}</span>;
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className="rounded-full border border-border/60 px-1.5 py-0.5 font-mono">{status}</span>
  );
}
