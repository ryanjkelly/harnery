"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  type HelperLimitPair,
  type HelperLimitReport,
  isHelperLimitReport,
  limitOptions,
} from "@/lib/helper-limit";
import { TONE } from "@/lib/tone";

export type SaveResult =
  | { ok: true; report: HelperLimitReport | null }
  | { ok: false; error: string };

/**
 * POST one change to the helper limit route. `limit` null removes the
 * person's choice; an empty pair is an explicit "no limit". Never throws.
 */
export async function saveHelperLimit(
  limit: HelperLimitPair | null,
  fetchImpl: typeof fetch = fetch,
): Promise<SaveResult> {
  try {
    const res = await fetchImpl("/api/devtools/helper-limit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error =
        body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : "The helper limit could not be saved.";
      return { ok: false, error };
    }
    return { ok: true, report: isHelperLimitReport(body) ? body : null };
  } catch {
    return {
      ok: false,
      error: "The helper limit could not be saved: the dashboard did not answer.",
    };
  }
}

/** The pair the two dropdowns describe; an empty value means "No limit". */
export function pairFromSelection(model: string, effort: string): HelperLimitPair {
  const pair: HelperLimitPair = {};
  if (model) pair.max_model = model;
  if (effort) pair.max_effort = effort;
  return pair;
}

/**
 * The "All my projects" row of the Tools page's helper agent block: a Model
 * and an Effort dropdown that save at once, plus "Use project default" when
 * the person has a choice saved and the project has a default to fall back to.
 * A failed save restores the previous selection and says why.
 */
export function HelperLimitControl({
  ladders,
  user,
  hasProjectDefault,
}: {
  ladders: HelperLimitReport["ladders"];
  user: HelperLimitPair | null;
  hasProjectDefault: boolean;
}) {
  const router = useRouter();
  const [model, setModel] = useState(user?.max_model ?? "");
  const [effort, setEffort] = useState(user?.max_effort ?? "");
  const [hasChoice, setHasChoice] = useState(user !== null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function apply(next: HelperLimitPair | null, nextModel: string, nextEffort: string) {
    const previous = { model, effort, hasChoice };
    setModel(nextModel);
    setEffort(nextEffort);
    setSaving(true);
    setError(null);
    setMessage(null);
    const result = await saveHelperLimit(next);
    setSaving(false);
    if (!result.ok) {
      setModel(previous.model);
      setEffort(previous.effort);
      setHasChoice(previous.hasChoice);
      setError(result.error);
      return;
    }
    const report = result.report;
    if (report) {
      setModel(report.user?.max_model ?? "");
      setEffort(report.user?.max_effort ?? "");
      setHasChoice(report.user !== null);
      setMessage(`Saved. ${report.summary}`);
    } else {
      setHasChoice(next !== null);
      setMessage("Saved.");
    }
    startTransition(() => router.refresh());
  }

  const selectClass =
    "rounded-md border border-border bg-background px-1.5 py-0.5 text-xs text-foreground outline-none focus:border-ring disabled:opacity-50";

  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex items-center gap-1.5 text-muted-foreground">
          Model
          <select
            aria-label="Highest model for helper agents"
            value={model}
            disabled={saving}
            onChange={(e) =>
              apply(pairFromSelection(e.target.value, effort), e.target.value, effort)
            }
            className={selectClass}
          >
            {limitOptions(ladders.models).map((o) => (
              <option key={o.value || "none"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          Effort
          <select
            aria-label="Highest effort for helper agents"
            value={effort}
            disabled={saving}
            onChange={(e) => apply(pairFromSelection(model, e.target.value), model, e.target.value)}
            className={selectClass}
          >
            {limitOptions(ladders.efforts).map((o) => (
              <option key={o.value || "none"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {hasChoice ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => apply(null, "", "")}
            className="font-medium text-primary hover:underline disabled:opacity-50"
          >
            {hasProjectDefault ? "Use project default" : "Remove my choice"}
          </button>
        ) : null}
        {saving ? <span className="text-muted-foreground">Saving…</span> : null}
      </div>
      {!hasChoice && !saving ? (
        <p className="text-muted-foreground">
          {hasProjectDefault
            ? "Not set. The project default applies."
            : "Not set. Choose a model or effort to limit helpers."}
        </p>
      ) : null}
      {message && !saving ? <p className={TONE.done.text}>{message}</p> : null}
      {error ? <p className={TONE.danger.text}>{error}</p> : null}
    </div>
  );
}
