"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type {
  CodecComprehensionChoice,
  CodecComprehensionConfidence,
  CodecComprehensionPublicStudy,
  CodecComprehensionReceipt,
  CodecComprehensionResponse,
} from "@/lib/codec/comprehension";

import styles from "./codecComprehension.module.css";

export function CodecComprehensionStudy({ study }: { study: CodecComprehensionPublicStudy }) {
  const [started, setStarted] = useState(false);
  const [index, setIndex] = useState(0);
  const [choice, setChoice] = useState<CodecComprehensionChoice | null>(null);
  const [confidence, setConfidence] = useState<CodecComprehensionConfidence | null>(null);
  const [responses, setResponses] = useState<CodecComprehensionResponse[]>([]);
  const [receipt, setReceipt] = useState<CodecComprehensionReceipt | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);
  const trialStartedAt = useRef(0);
  const trial = study.trials[index];

  const begin = () => {
    const now = Date.now();
    startedAt.current = now;
    trialStartedAt.current = now;
    setStarted(true);
  };

  const advance = async () => {
    if (!trial || !choice || !confidence || submitting) return;
    const response: CodecComprehensionResponse = {
      trial_id: trial.trial_id,
      choice,
      confidence,
      response_ms: Math.min(10 * 60_000, Math.max(0, Date.now() - trialStartedAt.current)),
    };
    const nextResponses = [...responses, response];
    if (index < study.trials.length - 1) {
      setResponses(nextResponses);
      setChoice(null);
      setConfidence(null);
      setIndex(index + 1);
      trialStartedAt.current = Date.now();
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await fetch("/api/codec-evaluation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema_version: 1,
          study_id: study.study_id,
          total_duration_ms: Math.min(2 * 60 * 60_000, Math.max(0, Date.now() - startedAt.current)),
          responses: nextResponses,
        }),
      });
      const body = (await result.json()) as { receipt?: CodecComprehensionReceipt; error?: string };
      if (!result.ok || !body.receipt) throw new Error(body.error ?? "result could not be stored");
      setResponses(nextResponses);
      setReceipt(body.receipt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "result could not be stored");
    } finally {
      setSubmitting(false);
    }
  };

  if (receipt) {
    const share = receipt.summary.semantic_share_excluding_ties;
    return (
      <main className={styles.studyPage}>
        <div className={styles.pageGrid} aria-hidden />
        <section className={styles.resultPanel} aria-labelledby="codec-study-result">
          <p className={styles.kicker}>Study complete</p>
          <h1 id="codec-study-result">Your choices were recorded.</h1>
          <p className={styles.deck}>
            The receipt contains only controlled expression tokens, A/B choices, confidence, and
            response timing. It contains no task text, event content, or model reply.
          </p>
          <div className={styles.resultGrid}>
            <article>
              <span>Semantic portrait</span>
              <strong>{receipt.summary.semantic_preferred}</strong>
              <small>preferred</small>
            </article>
            <article>
              <span>Fallback portrait</span>
              <strong>{receipt.summary.comparison_preferred}</strong>
              <small>preferred</small>
            </article>
            <article>
              <span>No difference</span>
              <strong>{receipt.summary.same}</strong>
              <small>ties</small>
            </article>
          </div>
          <p className={styles.resultSentence}>
            {share === null
              ? "Every comparison was marked equally clear."
              : `The semantic portrait won ${Math.round(share * 100)}% of directional choices.`}
          </p>
          <p className={styles.receiptId}>Receipt {receipt.receipt_id}</p>
          <div className={styles.resultActions}>
            <Link href="/codec" prefetch={false}>
              Return to Codec
            </Link>
            <Link href="/codec/roster" prefetch={false}>
              Open roster lab
            </Link>
          </div>
        </section>
      </main>
    );
  }

  if (!started) {
    return (
      <main className={styles.studyPage}>
        <div className={styles.pageGrid} aria-hidden />
        <section className={styles.introPanel} aria-labelledby="codec-study-title">
          <p className={styles.kicker}>Blinded portrait check</p>
          <h1 id="codec-study-title">Do semantic expressions communicate more clearly?</h1>
          <p className={styles.deck}>
            Each trial shows two portraits of the same character. One uses the expression selected
            from an accepted semantic reading; the other uses its existing fallback. Their order is
            hidden and balanced.
          </p>
          <div className={styles.introFacts}>
            <span>{study.trials.length} comparisons</span>
            <span>{study.accepted_readings} accepted readings</span>
            <span>No model text stored</span>
          </div>
          <ol className={styles.instructions}>
            <li>Read the target state.</li>
            <li>Choose A, B, or equally clear.</li>
            <li>Rate how confident you are in that choice.</li>
          </ol>
          <button className={styles.primaryButton} type="button" onClick={begin}>
            Begin blinded test
          </button>
          <Link className={styles.backLink} href="/codec" prefetch={false}>
            Return to Codec
          </Link>
        </section>
      </main>
    );
  }

  if (!trial) return null;
  const progress = Math.round(((index + 1) / study.trials.length) * 100);
  return (
    <main className={styles.studyPage}>
      <div className={styles.pageGrid} aria-hidden />
      <section className={styles.trialShell} aria-labelledby="codec-trial-title">
        <header className={styles.trialHeader}>
          <div>
            <p className={styles.kicker}>Portrait comprehension</p>
            <p className={styles.progressLabel}>
              Trial {index + 1} of {study.trials.length}
            </p>
          </div>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label="Study progress"
          >
            <span style={{ width: `${progress}%` }} />
          </div>
        </header>

        <div className={styles.targetBlock}>
          <span>Which portrait better communicates</span>
          <h1 id="codec-trial-title">{humanize(trial.target_expression)}?</h1>
          <p>Judge the expression, not the rendering style or character design.</p>
        </div>

        <div className={styles.portraitGrid}>
          <PortraitOption
            label="A"
            imageUrl={trial.image_a_url}
            selected={choice === "a"}
            onChoose={() => setChoice("a")}
          />
          <PortraitOption
            label="B"
            imageUrl={trial.image_b_url}
            selected={choice === "b"}
            onChoose={() => setChoice("b")}
          />
        </div>

        <button
          type="button"
          className={cn(styles.tieButton, choice === "same" && styles.tieButtonSelected)}
          aria-pressed={choice === "same"}
          onClick={() => setChoice("same")}
        >
          Both are equally clear
        </button>

        <fieldset className={styles.confidenceField}>
          <legend>How confident are you?</legend>
          <div>
            {(["low", "medium", "high"] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={confidence === value}
                className={cn(confidence === value && styles.confidenceSelected)}
                onClick={() => setConfidence(value)}
              >
                {humanize(value)}
              </button>
            ))}
          </div>
        </fieldset>

        {error && <p className={styles.error}>{error}</p>}
        <button
          className={styles.primaryButton}
          type="button"
          disabled={!choice || !confidence || submitting}
          onClick={() => void advance()}
        >
          {submitting
            ? "Saving result…"
            : index === study.trials.length - 1
              ? "Finish and save"
              : "Next comparison"}
        </button>
      </section>
    </main>
  );
}

function PortraitOption({
  label,
  imageUrl,
  selected,
  onChoose,
}: {
  label: "A" | "B";
  imageUrl: string;
  selected: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(styles.portraitOption, selected && styles.portraitOptionSelected)}
      aria-pressed={selected}
      aria-label={`Choose portrait ${label}`}
      onClick={onChoose}
    >
      <span className={styles.optionLabel}>{label}</span>
      {/* biome-ignore lint/performance/noImgElement: runtime pack portraits are already optimized WebP assets */}
      <img src={imageUrl} alt={`Portrait option ${label}`} width={512} height={768} />
      <span className={styles.optionAction}>{selected ? "Selected" : `Choose ${label}`}</span>
    </button>
  );
}

function humanize(value: string): string {
  return value.replaceAll("-", " ");
}
