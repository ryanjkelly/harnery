/**
 * Human labels for the coord layer's `platform` values (written by heartbeats
 * and `session.start` events). Pure module, safe to import from both server
 * and client components.
 */
const HARNESS_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "OpenAI Codex",
  cursor: "Cursor",
};

/** "claude_code" → "Claude Code"; unknown values pass through verbatim. */
export function harnessLabel(platform: string | null | undefined): string | null {
  if (!platform) return null;
  return HARNESS_LABELS[platform] ?? platform;
}
