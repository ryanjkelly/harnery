import type { WorkState } from "harnery/core/work/state";

export function WorkStateBadge({ state }: { state: WorkState }) {
  const tone =
    state === "succeeded"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : state === "blocked" || state === "cancelled"
        ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
        : state === "awaiting_approval" || state === "in_review"
          ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "border-border bg-muted text-muted-foreground";
  return (
    <span className={`rounded border px-1.5 py-0.5 text-xs ${tone}`}>
      {state.replaceAll("_", " ")}
    </span>
  );
}
