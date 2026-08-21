/**
 * Detect the entity type of a free-text input in the ⌘K palette and suggest
 * navigation targets. Regex-only and offline on purpose: names and slugs
 * (agent names, council/decision slugs) already match their catalog sections
 * via normal search, so this parser only handles the opaque identifier forms
 * a person pastes rather than types — workflow run ids, instance UUIDs, and
 * repo file paths.
 */

export type IdSuggestionKind = "workflow" | "agent" | "file";

export interface IdSuggestion {
  label: string;
  /** For workflow/agent: the in-app href. For file: the repo-relative path. */
  target: string;
  kind: IdSuggestionKind;
}

/** UUID with hyphens (any version — instance ids are UUIDv7). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Workflow run id, e.g. wf-2026-08-04T09-42-58-146Z-458566. */
const WF_RE = /^wf-[a-z0-9-]{6,}$/i;

/** A repo-relative path: contains a slash, or ends in a known-ish extension. */
const PATHLIKE_RE =
  /^(?:[\w.-]+\/)+[\w.-]+$|^[\w-]+\.(md|ts|tsx|js|jsx|json|jsonc|yml|yaml|css|html|txt|sh|py|php|csv|ndjson|svg|png|jpg|jpeg|webp|pdf)$/i;

export function parseIdInput(input: string): IdSuggestion[] {
  const q = input.trim();
  if (!q) return [];

  if (WF_RE.test(q)) {
    return [
      {
        label: `Open workflow run ${q}`,
        target: `/workflows/${encodeURIComponent(q)}`,
        kind: "workflow",
      },
    ];
  }

  if (UUID_RE.test(q)) {
    return [
      {
        label: `Open agent session ${q}`,
        target: `/agents/${encodeURIComponent(q)}`,
        kind: "agent",
      },
    ];
  }

  if (PATHLIKE_RE.test(q) && !q.startsWith("http")) {
    return [
      {
        label: `Open file ${q}`,
        target: q.replace(/^\.?\//, ""),
        kind: "file",
      },
    ];
  }

  return [];
}
