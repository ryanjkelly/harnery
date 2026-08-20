/**
 * The suggested session name is a small display protocol, not ordinary prose.
 * Keep its exact block and pending-state rules in one adapter-neutral module so
 * prompt context, PostToolUse injection, and PreToolUse enforcement cannot
 * drift apart.
 */

export interface SessionNameDisplayState {
  suggested_session_name?: string;
  session_name_seen_for?: string;
}

export const SESSION_NAME_DISPLAY_NOTE =
  "Next, before any prose or another tool call, send suggested_session_name verbatim by itself in a fenced code block.";

export function sessionNameDisplayPending(
  row: SessionNameDisplayState | null | undefined,
): string | null {
  const name = row?.suggested_session_name;
  if (!name || row?.session_name_seen_for === name) return null;
  return name;
}

export function sessionNameDisplayBlock(name: string): string {
  return `\`\`\`\n${name}\n\`\`\``;
}

export function sessionNameDisplayInstruction(name: string): string {
  return [
    "Session name display required.",
    "Before any prose or another tool call, send this exact fenced block as your next assistant text:",
    "",
    sessionNameDisplayBlock(name),
    "",
    "Do not put commentary before the block. Harnery will reject tool calls until it is shown.",
  ].join("\n");
}

/**
 * Accept the exact unlabelled block Harnery requests. `text` and `plaintext`
 * are tolerated for older prompts, but the code block may contain only the
 * suggested name and must be the first non-whitespace user-facing content.
 */
export function assistantTextStartsWithSessionNameBlock(text: string, name: string): boolean {
  if (!text || !name) return false;
  const normalized = text.replace(/\r\n?/g, "\n").trimStart();
  const match = /^```(?:text|plaintext)?[ \t]*\n([^\n]*)\n```(?:[ \t]*(?:\n|$))/.exec(normalized);
  return match?.[1] === name;
}

/**
 * The display latch must not block the two coordination commands that can
 * repair a turn or close it cleanly. Keep this intentionally narrower than
 * "any harn command" and reject shell control syntax before matching.
 */
export function isSessionNameRemediationCommand(
  command: string | undefined,
  binName: string,
): boolean {
  if (!command || !binName) return false;
  const body = command.replace(/^(?:[ \t]*#\s*intent:[^\n]*\n)+/i, "").trim();
  if (!body || /[\n;&|<>`$]/.test(body)) return false;
  const escapedBin = binName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^(?:codex-wsl\\s+--\\s+)?${escapedBin}\\s+agents\\s+(?:set-task|status)(?:\\s+.*)?$`,
  );
  return pattern.test(body);
}
