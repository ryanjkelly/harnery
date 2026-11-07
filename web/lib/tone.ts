/**
 * The dashboard's state colour grammar, in one place.
 *
 * Every status pill, banner, callout and section accent picks a `Tone`
 * instead of hand-writing Tailwind colour classes. The meanings are fixed:
 *
 * - `act`     sky: the operator should act now, or something is working live
 * - `done`    emerald: finished successfully
 * - `warn`    amber: needs attention, but nothing is broken yet
 * - `danger`  red (the --destructive token): failed, blocked, or invalid
 * - `accent`  purple: a highlighted but neutral category
 * - `neutral` muted: waiting, idle, stale, or inert
 *
 * Do not invent new state colours in components; add a tone here instead.
 */
export type Tone = "act" | "done" | "warn" | "danger" | "accent" | "neutral";

export interface ToneClasses {
  /** Bordered soft surface for pills and badges. */
  pill: string;
  /** Bordered soft surface for banners, callouts and notices. */
  surface: string;
  /** Text colour alone, for icons and inline emphasis. */
  text: string;
  /** Solid dot or bar colour. */
  dot: string;
  /** Left accent border for a section or row. */
  accentBorder: string;
}

export const TONE: Record<Tone, ToneClasses> = {
  act: {
    pill: "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
    surface: "border-sky-500/30 bg-sky-500/5 text-foreground",
    text: "text-sky-600 dark:text-sky-400",
    dot: "bg-sky-500",
    accentBorder: "border-l-sky-500/70",
  },
  done: {
    pill: "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    surface: "border-emerald-500/30 bg-emerald-500/5 text-foreground",
    text: "text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
    accentBorder: "border-l-emerald-500/70",
  },
  warn: {
    pill: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    surface: "border-amber-500/30 bg-amber-500/5 text-foreground",
    text: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
    accentBorder: "border-l-amber-500/70",
  },
  danger: {
    pill: "border-destructive/50 bg-destructive/10 text-destructive dark:bg-destructive/15",
    surface: "border-destructive/30 bg-destructive/5 text-foreground",
    text: "text-destructive",
    dot: "bg-destructive",
    accentBorder: "border-l-destructive/70",
  },
  accent: {
    pill: "border-purple-500/50 bg-purple-500/10 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300",
    surface: "border-purple-500/30 bg-purple-500/5 text-foreground",
    text: "text-purple-600 dark:text-purple-400",
    dot: "bg-purple-500",
    accentBorder: "border-l-purple-500/70",
  },
  neutral: {
    pill: "border-border/60 bg-muted text-muted-foreground",
    surface: "border-border bg-card text-muted-foreground",
    text: "text-muted-foreground",
    dot: "bg-muted-foreground/60",
    accentBorder: "border-l-border",
  },
};

/** Look up a tone from a state value, falling back to `neutral`. */
export function toneFor<S extends string>(state: S, map: Partial<Record<S, Tone>>): Tone {
  return map[state] ?? "neutral";
}

/** Render a snake_case or kebab-case state as words: `awaiting_approval` → `awaiting approval`. */
export function stateLabel(state: string): string {
  return state.replace(/[_-]+/g, " ");
}
