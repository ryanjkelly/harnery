/**
 * Shared category metadata for the scratchpad UI. Mirrors the
 * `SCRATCH_CATEGORIES` allowlist from `harnery/src/core/scratch/index.ts`
 * (the source of truth: the bash + bun CLIs both reject anything outside
 * it). Descriptions are the operator-facing tooltips.
 */

import type { ScratchCategory } from "@/lib/coord-writer";

type BadgeVariant =
  | "default"
  | "outline"
  | "secondary"
  | "muted"
  | "info"
  | "success"
  | "warning"
  | "destructive"
  | "accent";

export interface CategoryMeta {
  value: ScratchCategory;
  label: string;
  variant: BadgeVariant;
  short: string;
  long: string;
}

export const CATEGORY_META: readonly CategoryMeta[] = [
  {
    value: "note",
    label: "Note",
    variant: "muted",
    short: "Generic free-form observation.",
    long: "Default catch-all: anything worth remembering that doesn't fit the other categories. Use sparingly; the more specific category usually exists.",
  },
  {
    value: "plan",
    label: "Plan",
    variant: "outline",
    short: "What I'm about to do next.",
    long: "A near-term plan or approach. Reads as 'here's what I'm going to do', useful for peers to see before they start related work.",
  },
  {
    value: "decision",
    label: "Decision",
    variant: "default",
    short: "Committed choice + the why.",
    long: "A decision the agent committed to, with rationale. The why matters more than the what: captures judgment so future-you (or peers) can revisit context.",
  },
  {
    value: "blocker",
    label: "Blocker",
    variant: "destructive",
    short: "Stuck: can't proceed without something.",
    long: "Something preventing forward progress (missing access, broken dependency, unanswered question, etc.). Other agents reading the scratchpad should treat this as a request for help.",
  },
  {
    value: "question",
    label: "Question",
    variant: "warning",
    short: "Open question for the operator.",
    long: "An unresolved question pending operator (Ryan) input. Useful when the agent can keep working on unrelated parts but needs an answer to unblock one path.",
  },
  {
    value: "done",
    label: "Done",
    variant: "success",
    short: "Milestone or chunk completed.",
    long: "Notable completion, usually a meaningful chunk that's been shipped/committed. Different from per-message progress; this is for things worth surfacing later.",
  },
  {
    value: "handoff",
    label: "Handoff",
    variant: "secondary",
    short: "Message from / to another agent.",
    long: "Inter-agent communication. The `agents ping` command and the web UI's nudge box write these. Format is usually `from agent-X: <message>`.",
  },
] as const;

export const CATEGORY_BY_VALUE: Readonly<
  Record<ScratchCategory, CategoryMeta>
> = Object.fromEntries(
  CATEGORY_META.map((m) => [m.value, m]),
) as Record<ScratchCategory, CategoryMeta>;

export function categoryMeta(value: string): CategoryMeta {
  return (
    CATEGORY_BY_VALUE[value as ScratchCategory] ?? {
      value: value as ScratchCategory,
      label: value,
      variant: "muted",
      short: "Unknown category",
      long: `Category "${value}" is not in the canonical scratch category list. Likely an artifact of an older entry shape or a manual edit.`,
    }
  );
}
