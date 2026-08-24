"use client";

import type {
  SemanticPhase,
  SemanticReviewConfidence,
  SemanticReviewExpression,
  SemanticReviewFieldVerdict,
  SemanticReviewOverallVerdict,
  SemanticReviewPortraitVerdict,
  SemanticReviewReceiptV1,
  SemanticReviewResponseV1,
  SemanticReviewStudyCandidateV1,
  SemanticReviewStudyV1,
  SemanticReviewTransitionVerdict,
} from "harnery/core/semantic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Attention } from "@/components/Attention";
import { cn } from "@/lib/cn";

import styles from "./semanticInferenceReview.module.css";

const OVERALL_OPTIONS = ["correct", "close", "wrong", "unsure"] as const;
const FIELD_OPTIONS = ["correct", "wrong", "unsure"] as const;
const PORTRAIT_OPTIONS = ["helpful", "neutral", "misleading"] as const;
const TRANSITION_OPTIONS = ["real-change", "flicker", "unsure"] as const;
const CONFIDENCE_OPTIONS = ["low", "medium", "high"] as const;
const PHASE_OPTIONS: SemanticPhase[] = [
  "orienting",
  "researching",
  "planning",
  "implementing",
  "verifying",
  "coordinating",
  "waiting",
  "recovering",
  "wrapping-up",
  "unknown",
];
const EXPRESSION_OPTIONS: SemanticReviewExpression[] = [
  "none",
  "focused",
  "curious",
  "deliberating",
  "investigating",
  "building",
  "coordinating",
  "planning",
  "verifying",
  "weighing",
  "wrapping-up",
];

interface DraftResponse {
  overall?: SemanticReviewOverallVerdict;
  phase?: SemanticReviewFieldVerdict;
  expected_phase?: SemanticPhase;
  expression?: SemanticReviewFieldVerdict;
  expected_expression?: SemanticReviewExpression;
  portrait_usefulness?: SemanticReviewPortraitVerdict;
  transition?: SemanticReviewTransitionVerdict;
  confidence?: SemanticReviewConfidence;
}

export function SemanticInferenceReview() {
  const [study, setStudy] = useState<SemanticReviewStudyV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [started, setStarted] = useState(false);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<DraftResponse>({});
  const [responses, setResponses] = useState<SemanticReviewResponseV1[]>([]);
  const [receipt, setReceipt] = useState<SemanticReviewReceiptV1 | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);
  const candidateStartedAt = useRef(0);

  const loadStudy = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/codec-semantic-review", { cache: "no-store" });
      const body = (await response.json()) as {
        study?: SemanticReviewStudyV1;
        error?: string;
      };
      if (!response.ok || !body.study) {
        throw new Error(body.error ?? "semantic review could not be prepared");
      }
      setStudy(body.study);
      setStarted(false);
      setIndex(0);
      setDraft({});
      setResponses([]);
      setReceipt(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "semantic review could not be prepared");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStudy();
  }, [loadStudy]);

  const begin = () => {
    const now = Date.now();
    startedAt.current = now;
    candidateStartedAt.current = now;
    setStarted(true);
  };

  const current = study?.candidates[index];
  const complete = current ? draftComplete(draft, current.transition_required) : false;

  const advance = async () => {
    if (!study || !current || !complete || submitting) return;
    const response: SemanticReviewResponseV1 = {
      candidate_id: current.candidate.candidate_id,
      overall: draft.overall!,
      phase: draft.phase!,
      ...(draft.phase === "wrong" ? { expected_phase: draft.expected_phase! } : {}),
      expression: draft.expression!,
      ...(draft.expression === "wrong" ? { expected_expression: draft.expected_expression! } : {}),
      portrait_usefulness: draft.portrait_usefulness!,
      ...(current.transition_required ? { transition: draft.transition! } : {}),
      confidence: draft.confidence!,
      response_ms: Math.min(10 * 60_000, Math.max(0, Date.now() - candidateStartedAt.current)),
    };
    const nextResponses = [...responses, response];
    if (index < study.candidates.length - 1) {
      setResponses(nextResponses);
      setIndex((value) => value + 1);
      setDraft({});
      candidateStartedAt.current = Date.now();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await fetch("/api/codec-semantic-review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema_version: 1,
          study_id: study.study_id,
          total_duration_ms: Math.min(2 * 60 * 60_000, Math.max(0, Date.now() - startedAt.current)),
          responses: nextResponses,
        }),
      });
      const body = (await result.json()) as {
        receipt?: SemanticReviewReceiptV1;
        error?: string;
      };
      if (!result.ok || !body.receipt) {
        throw new Error(body.error ?? "semantic review could not be stored");
      }
      setResponses(nextResponses);
      setReceipt(body.receipt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "semantic review could not be stored");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <ReviewShell>
        <section className={styles.messagePanel} aria-live="polite">
          <p className={styles.kicker}>Semantic inference review</p>
          <h1>Preparing accepted readings…</h1>
          <p>The queue is being frozen from the local semantic reader.</p>
        </section>
      </ReviewShell>
    );
  }

  if (!study) {
    return (
      <ReviewShell>
        <section className={styles.messagePanel} role="alert">
          <p className={styles.kicker}>Semantic inference review</p>
          <h1>The review queue is unavailable.</h1>
          <p>{error ?? "The local semantic reader did not return a review set."}</p>
          <div className={styles.actions}>
            <button type="button" onClick={() => void loadStudy()}>
              Try again
            </button>
            <Link href="/codec" prefetch={false}>
              Return to Codec
            </Link>
          </div>
        </section>
      </ReviewShell>
    );
  }

  if (receipt) {
    return (
      <ReviewShell>
        <section className={styles.resultPanel} aria-labelledby="semantic-review-result">
          <p className={styles.kicker}>Review complete</p>
          <h1 id="semantic-review-result">The labels were recorded.</h1>
          <p className={styles.deck}>
            The receipt keeps controlled verdicts, corrections, model identity, phase, expression,
            confidence, and timing. It does not keep task text, evidence prose, or semantic prose.
          </p>
          <div className={styles.resultGrid}>
            <ResultStat label="Correct" value={receipt.summary.overall.correct} />
            <ResultStat label="Close" value={receipt.summary.overall.close} />
            <ResultStat label="Wrong" value={receipt.summary.overall.wrong} />
            <ResultStat label="Unsure" value={receipt.summary.overall.unsure} />
          </div>
          <p className={styles.receiptId}>Receipt {receipt.receipt_id}</p>
          <div className={styles.actions}>
            <Link href="/codec" prefetch={false}>
              Return to Codec
            </Link>
            <button type="button" onClick={() => void loadStudy()}>
              Review next set
            </button>
          </div>
        </section>
      </ReviewShell>
    );
  }

  if (study.candidates.length === 0) {
    return (
      <ReviewShell>
        <section className={styles.messagePanel}>
          <p className={styles.kicker}>Semantic inference review</p>
          <h1>No accepted readings are waiting.</h1>
          <p>
            New candidates appear automatically when the live semantic reader accepts fresh
            evidence. Previously reviewed candidates stay out of the queue.
          </p>
          <div className={styles.queueFacts}>
            <span>{study.total_candidate_count} captured</span>
            <span>{study.reviewed_candidate_count} reviewed</span>
            <span>0 pending</span>
          </div>
          <div className={styles.actions}>
            <button type="button" onClick={() => void loadStudy()}>
              Refresh queue
            </button>
            <Link href="/codec" prefetch={false}>
              Return to Codec
            </Link>
          </div>
        </section>
      </ReviewShell>
    );
  }

  if (!started) {
    return (
      <ReviewShell>
        <Attention
          request={{
            key: `semantic-review-${study.study_id}`,
            label: `${study.candidates.length} semantic reading(s) to review`,
          }}
        />
        <section className={styles.introPanel} aria-labelledby="semantic-review-title">
          <p className={styles.kicker}>Semantic inference review</p>
          <h1 id="semantic-review-title">Does the reader understand the work?</h1>
          <p className={styles.deck}>
            Compare each accepted interpretation with the bounded source facts that produced it.
            Your labels will tell us where the prompt, vocabulary, or expression mapping needs to
            change.
          </p>
          <div className={styles.queueFacts}>
            <span>{study.candidates.length} in this set</span>
            <span>{study.pending_candidate_count} pending</span>
            <span>{study.reviewed_candidate_count} reviewed</span>
          </div>
          <ol className={styles.instructions}>
            <li>Read the source facts without assuming the model is right.</li>
            <li>Judge the overall meaning, phase, and expression separately.</li>
            <li>Use “unsure” when the evidence does not support a confident label.</li>
          </ol>
          <p className={styles.privacyNote}>
            Candidate context stays local for seven days. Saved receipts contain controlled labels
            and opaque hashes, not the task or model prose shown here.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primaryButton}
              data-semantic-review-start
              onClick={begin}
            >
              Begin meaning review
            </button>
            <Link href="/codec" prefetch={false}>
              Return to Codec
            </Link>
          </div>
        </section>
      </ReviewShell>
    );
  }

  if (!current) return null;
  const progress = Math.round(((index + 1) / study.candidates.length) * 100);
  return (
    <ReviewShell>
      <section className={styles.reviewPanel} aria-labelledby="semantic-review-headline">
        <header className={styles.reviewHeader}>
          <div>
            <p className={styles.kicker}>Meaning review</p>
            <p className={styles.progressLabel}>
              Reading {index + 1} of {study.candidates.length}
            </p>
          </div>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label="Review progress"
          >
            <span style={{ width: `${progress}%` }} />
          </div>
        </header>

        <div data-semantic-review-context className={styles.contextGrid}>
          <SourceFacts item={current} />
          <ProposedMeaning item={current} />
        </div>

        {current.previous && current.transition_required && (
          <section className={styles.previousPanel} aria-label="Previous accepted reading">
            <div>
              <p className={styles.sectionLabel}>Previous accepted reading</p>
              <strong>{current.previous.proposal.headline.value}</strong>
              <p>{current.previous.proposal.summary.value}</p>
            </div>
            <div className={styles.previousTokens}>
              <Token label="Phase" value={current.previous.proposal.phase.value} />
              <Token
                label="Expression"
                value={current.previous.proposal.expression_cue?.value ?? "none"}
              />
            </div>
          </section>
        )}

        <div data-semantic-review-questions className={styles.questions}>
          <ChoiceField
            legend="How accurate is the overall interpretation?"
            value={draft.overall}
            options={OVERALL_OPTIONS}
            onChange={(overall) => setDraft((value) => ({ ...value, overall }))}
          />
          <ChoiceField
            legend={`Is “${humanize(current.candidate.proposal.phase.value)}” the right phase?`}
            value={draft.phase}
            options={FIELD_OPTIONS}
            onChange={(phase) =>
              setDraft((value) => ({
                ...value,
                phase,
                ...(phase === "wrong" ? {} : { expected_phase: undefined }),
              }))
            }
          />
          {draft.phase === "wrong" && (
            <CorrectionSelect
              label="What phase should it be?"
              value={draft.expected_phase}
              options={PHASE_OPTIONS}
              onChange={(expected_phase) => setDraft((value) => ({ ...value, expected_phase }))}
            />
          )}
          <ChoiceField
            legend={`Is “${humanize(current.candidate.proposal.expression_cue?.value ?? "no expression cue")}” the right expression choice?`}
            value={draft.expression}
            options={FIELD_OPTIONS}
            onChange={(expression) =>
              setDraft((value) => ({
                ...value,
                expression,
                ...(expression === "wrong" ? {} : { expected_expression: undefined }),
              }))
            }
          />
          {draft.expression === "wrong" && (
            <CorrectionSelect
              label="What expression should it use?"
              value={draft.expected_expression}
              options={EXPRESSION_OPTIONS}
              onChange={(expected_expression) =>
                setDraft((value) => ({ ...value, expected_expression }))
              }
            />
          )}
          <ChoiceField
            legend="Would this expression choice make the Codec portrait more useful?"
            value={draft.portrait_usefulness}
            options={PORTRAIT_OPTIONS}
            onChange={(portrait_usefulness) =>
              setDraft((value) => ({ ...value, portrait_usefulness }))
            }
          />
          {current.transition_required && (
            <ChoiceField
              legend="Does the change from the previous reading reflect real work or flicker?"
              value={draft.transition}
              options={TRANSITION_OPTIONS}
              onChange={(transition) => setDraft((value) => ({ ...value, transition }))}
            />
          )}
          <ChoiceField
            legend="How confident are you in this review?"
            value={draft.confidence}
            options={CONFIDENCE_OPTIONS}
            onChange={(confidence) => setDraft((value) => ({ ...value, confidence }))}
          />
        </div>

        {error && <p className={styles.error}>{error}</p>}
        <footer className={styles.reviewFooter}>
          <span>{complete ? "Ready to record" : "Answer each question to continue"}</span>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!complete || submitting}
            onClick={() => void advance()}
          >
            {submitting
              ? "Saving labels…"
              : index === study.candidates.length - 1
                ? "Finish and save"
                : "Next reading"}
          </button>
        </footer>
      </section>
    </ReviewShell>
  );
}

function ReviewShell({ children }: { children: React.ReactNode }) {
  return (
    <main data-semantic-review className={styles.reviewPage}>
      <div className={styles.pageGrid} aria-hidden />
      {children}
    </main>
  );
}

function SourceFacts({ item }: { item: SemanticReviewStudyCandidateV1 }) {
  const evidence = item.candidate.evidence;
  return (
    <section className={styles.sourceCard} aria-labelledby="semantic-source-facts">
      <header>
        <div>
          <p className={styles.sectionLabel}>Bounded source facts</p>
          <h2 id="semantic-source-facts">What the ledger says</h2>
        </div>
        <time dateTime={evidence.observed_through_ts}>
          {formatTime(evidence.observed_through_ts)}
        </time>
      </header>
      <dl className={styles.factList}>
        <Fact label="Task" value={evidence.task ?? "No task declared"} />
        <Fact label="Lifecycle" value={humanize(evidence.lifecycle ?? "unknown")} />
        <Fact label="Intent" value={humanize(evidence.intent ?? "none observed")} />
        <Fact label="Operation" value={evidence.operation?.label ?? "No active operation"} />
        <Fact
          label="Waits"
          value={
            evidence.waits.length > 0
              ? evidence.waits.map((wait) => humanize(wait.kind)).join(", ")
              : "None"
          }
        />
        <Fact label="Attention" value={observationText(evidence.attention) ?? "None"} />
      </dl>
      <div className={styles.recentFacts}>
        <p className={styles.sectionLabel}>Recent observations</p>
        {evidence.recent.length > 0 ? (
          <ol>
            {evidence.recent.map((observation) => (
              <li key={JSON.stringify(observation)}>
                <span>{humanize(observation.kind)}</span>
                <strong>{observationText(observation) ?? "Observed"}</strong>
                <time dateTime={observation.observed_at}>
                  {formatTime(observation.observed_at)}
                </time>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.emptyFact}>No recent bounded observations.</p>
        )}
      </div>
    </section>
  );
}

function ProposedMeaning({ item }: { item: SemanticReviewStudyCandidateV1 }) {
  const { candidate } = item;
  const proposal = candidate.proposal;
  return (
    <section className={styles.proposalCard} aria-labelledby="semantic-review-headline">
      <header>
        <div>
          <p className={styles.sectionLabel}>Accepted model reading</p>
          <p className={styles.modelLine}>
            {modelName(candidate.source.configured_model)} · {humanize(candidate.source.harness)}
          </p>
        </div>
        <span className={styles.attestation}>{humanize(candidate.source.model_attestation)}</span>
      </header>
      <h2 id="semantic-review-headline">{proposal.headline.value}</h2>
      <p className={styles.proposalSummary}>{proposal.summary.value}</p>
      <div className={styles.tokenGrid}>
        <Token label="Phase" value={proposal.phase.value} confidence={proposal.phase.confidence} />
        <Token
          label="Expression"
          value={proposal.expression_cue?.value ?? "none"}
          confidence={proposal.expression_cue?.confidence ?? "abstained"}
        />
      </div>
      <dl className={styles.meaningDetails}>
        {proposal.purpose && <Fact label="Purpose" value={proposal.purpose.value} />}
        {proposal.recent_result && (
          <Fact label="Recent result" value={proposal.recent_result.value} />
        )}
        {proposal.attention && <Fact label="Attention" value={proposal.attention.value} />}
        {proposal.next_step && <Fact label="Predicted next" value={proposal.next_step.value} />}
        {proposal.tags && <Fact label="Tags" value={proposal.tags.value.join(", ")} />}
      </dl>
      <p className={styles.modelId}>Resolved model: {candidate.source.resolved_model_id}</p>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Token({
  label,
  value,
  confidence,
}: {
  label: string;
  value: string;
  confidence?: string;
}) {
  return (
    <div className={styles.token}>
      <span>{label}</span>
      <strong>{humanize(value)}</strong>
      {confidence && <small>{humanize(confidence)}</small>}
    </div>
  );
}

function ChoiceField<T extends string>({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string;
  value: T | undefined;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className={styles.choiceField}>
      <legend>{legend}</legend>
      <div>
        {options.map((option) => (
          <button
            type="button"
            key={option}
            aria-pressed={value === option}
            className={cn(value === option && styles.choiceSelected)}
            onClick={() => onChange(option)}
          >
            {humanize(option)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function CorrectionSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <label className={styles.correctionField}>
      <span>{label}</span>
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value as T)}>
        <option value="" disabled>
          Choose a controlled label
        </option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option === "none" ? "No expression cue" : humanize(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ResultStat({ label, value }: { label: string; value: number }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>reading{value === 1 ? "" : "s"}</small>
    </article>
  );
}

function draftComplete(draft: DraftResponse, transitionRequired: boolean): boolean {
  return Boolean(
    draft.overall &&
      draft.phase &&
      (draft.phase !== "wrong" || draft.expected_phase) &&
      draft.expression &&
      (draft.expression !== "wrong" || draft.expected_expression) &&
      draft.portrait_usefulness &&
      (!transitionRequired || draft.transition) &&
      draft.confidence,
  );
}

function observationText(
  observation: { label?: string; outcome?: string; error_class?: string; kind: string } | undefined,
): string | undefined {
  if (!observation) return undefined;
  return [observation.label, observation.outcome, observation.error_class]
    .filter((value): value is string => Boolean(value))
    .map(humanize)
    .join(" · ");
}

function modelName(model: string): string {
  if (model === "gpt-5.6-luna") return "GPT-5.6 Luna";
  if (model === "haiku-4.5") return "Haiku 4.5";
  if (model === "composer-2.5") return "Composer 2.5";
  return model;
}

function humanize(value: string): string {
  return value.replaceAll("-", " ");
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
