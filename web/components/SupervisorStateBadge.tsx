import type { SupervisorState } from "harnery/core/supervisor/state";

export function SupervisorStateBadge({ state }: { state: SupervisorState }) {
  const tone =
    state === "succeeded"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : state === "blocked" || state === "budget_exhausted"
        ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
        : state === "awaiting_attention"
          ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : state === "running"
            ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
            : "border-border bg-muted text-muted-foreground";
  return (
    <span className={`rounded border px-1.5 py-0.5 text-xs ${tone}`}>
      {state.replaceAll("_", " ")}
    </span>
  );
}
