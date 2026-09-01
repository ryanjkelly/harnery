/**
 * The suggested session name is a small display protocol, not ordinary prose.
 * Keep its exact block and pending-state rules in one adapter-neutral module so
 * prompt context, PostToolUse injection, and PreToolUse enforcement cannot
 * drift apart.
 */

export interface SessionNameDisplayState {
  suggested_session_name?: string;
  session_name_seen_for?: string;
  session_name_display_requested_for?: string;
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

/**
 * Every title whose exact display satisfies the current latch.
 *
 * The pending title always counts. The title the agent was last instructed to
 * display also counts, because the harness — not the agent — is what changed
 * the target after asking. Accepting it costs nothing the operator can see: a
 * clean one-line block did open that reply. Refusing it left Cursor sessions
 * permanently latched, since no Cursor surface can re-open a missed window.
 */
export function sessionNameDisplayAcceptedNames(
  row: SessionNameDisplayState | null | undefined,
): string[] {
  const pending = sessionNameDisplayPending(row);
  if (!pending) return [];
  const requested = row?.session_name_display_requested_for;
  return requested && requested !== pending ? [pending, requested] : [pending];
}

/**
 * Match assistant text against any accepted title and report which one closed
 * the latch, so a drifted display can be stamped against the pending title and
 * logged as drift rather than silently discarded.
 */
export function matchSessionNameDisplay(
  row: SessionNameDisplayState | null | undefined,
  text: string | undefined,
  startsWithBlock: (
    text: string,
    expectedName: string,
  ) => boolean = assistantTextStartsWithSessionNameBlock,
): { pending: string; displayed: string } | null {
  if (!text) return null;
  const accepted = sessionNameDisplayAcceptedNames(row);
  const pending = accepted[0];
  if (!pending) return null;
  const displayed = accepted.find((candidate) => startsWithBlock(text, candidate));
  return displayed ? { pending, displayed } : null;
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

export function sessionNameDisplayRecoveryInstruction(name: string, binName: string): string {
  return [
    sessionNameDisplayInstruction(name),
    "",
    `If that exact block was already shown but the gate still rejects tools, run \`${binName} agents suggest-name --json\` as the only tool call. That read-only command is exempt and creates a fresh verification boundary.`,
  ].join("\n");
}

/**
 * A PostToolUse result should announce the display protocol only when that
 * exact tool call minted or retried the current suggestion. The coordination row keeps
 * the suggestion pending until transcript evidence catches up, so checking
 * the row alone would re-announce the same name after every later tool.
 *
 * Adapter responses vary between a direct command envelope and wrapper
 * objects whose `output`/content field contains the JSON as one line. Walk
 * both shapes, but require the command's explicit mint flag as well as the
 * exact current name. Ordinary status output can carry the name without
 * activating the display ritual.
 */
export function toolResponseMintedSessionName(response: unknown, name: string): boolean {
  if (!name) return false;
  return responseContainsSessionNameMint(response, name, new Set<object>(), 0);
}

function responseContainsSessionNameMint(
  value: unknown,
  name: string,
  seen: Set<object>,
  depth: number,
): boolean {
  if (depth > 8 || value === null || value === undefined) return false;

  if (typeof value === "string") {
    const candidates = [value.trim(), ...value.split(/\r?\n/).map((line) => line.trim())];
    for (const candidate of candidates) {
      if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
      try {
        if (
          responseContainsSessionNameMint(JSON.parse(candidate) as unknown, name, seen, depth + 1)
        ) {
          return true;
        }
      } catch {
        // Wrapper prose and partial JSON are not authoritative mint evidence.
      }
    }
    return false;
  }

  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => responseContainsSessionNameMint(item, name, seen, depth + 1));
  }

  const row = value as Record<string, unknown>;
  if (
    row.suggested_session_name === name &&
    (row.first_of_session === true || row.name_reminted === true || row.session_name_retry === true)
  ) {
    return true;
  }

  return Object.values(row).some((item) =>
    responseContainsSessionNameMint(item, name, seen, depth + 1),
  );
}

/**
 * A leading fenced block whose only line is the suggested name.
 *
 * What the contract protects is what the operator sees: the reply opens with a
 * code block containing exactly the title, so it renders as one clean
 * copy-pasteable line. The fence's info string changes none of that, so any
 * single-word language tag passes. Restricting it to `text`/`plaintext` meant a
 * model that wrote ```txt or ```markdown produced a display the operator could
 * read perfectly while the latch refused to close — and since nothing else can
 * close a Cursor latch, that mismatch stranded the whole session.
 *
 * Still exact in every load-bearing way: the block is the first user-facing
 * content, holds one line, and that line equals the name. The backreference
 * requires the closing fence to match the opening run, so a longer fence cannot
 * be closed by a shorter one.
 */
const LEADING_SESSION_NAME_BLOCK =
  /^(`{3,})[ \t]*[A-Za-z0-9_.+#-]*[ \t]*\n([^\n]*)\n\1[ \t]*(?:\n|$)/;

export function assistantTextStartsWithSessionNameBlock(text: string, name: string): boolean {
  if (!text || !name) return false;
  const normalized = text.replace(/\r\n?/g, "\n").trimStart();
  return LEADING_SESSION_NAME_BLOCK.exec(normalized)?.[2] === name;
}

/**
 * A trailing stream redirect to `/dev/null` or another descriptor. Agents append
 * these habitually when capturing output, and unlike a pipe or `&&` they cannot
 * smuggle a second command, so they must not disable the remediation exemption
 * below. Deliberately excludes redirects to a named file.
 */
const BENIGN_REDIRECT_SUFFIX = /\s*[012]?>>?\s*(?:&[012]|\/dev\/null)\s*$/;

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
  let body = command.replace(/^(?:[ \t]*#\s*intent:[^\n]*\n)+/i, "").trim();

  // Strip benign trailing redirects before the control-syntax check. Without
  // this, `<bin> agents status --end-turn 2>&1` fails the `&` test, which
  // disables the one exemption that can close a latched turn and leaves the
  // session unable to satisfy either the latch or the end-of-turn rule.
  for (let next = body.replace(BENIGN_REDIRECT_SUFFIX, "").trim(); next !== body; ) {
    body = next;
    next = body.replace(BENIGN_REDIRECT_SUFFIX, "").trim();
  }

  if (!body || /[\n;&|<>`$]/.test(body)) return false;
  const escapedBin = binName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^(?:codex-wsl\\s+--\\s+)?${escapedBin}\\s+agents\\s+(?:set-task|status|suggest-name)(?:\\s+.*)?$`,
  );
  return pattern.test(body);
}
