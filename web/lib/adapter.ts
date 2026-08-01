/**
 * Human labels for the coord layer's `platform` values (written by heartbeats
 * and `session.start` events). Pure module, safe to import from both server
 * and client components.
 */
const ADAPTER_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "OpenAI Codex",
  cursor: "Cursor",
};

/** "claude_code" → "Claude Code"; unknown values pass through verbatim. */
export function adapterLabel(platform: string | null | undefined): string | null {
  if (!platform) return null;
  return ADAPTER_LABELS[platform] ?? platform;
}
