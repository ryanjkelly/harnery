import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Scan a CC-style JSONL transcript for the `┌─ agent-` status-box prefix in
 * the most-recent assistant turn. Used by `turn.completed` events to populate
 * `status_box_present`.
 *
 * Cheap by default: caps the read at 256KB tailed from the file, since the
 * status box (if present) is always near the end of the most-recent turn.
 * Phase 2 doesn't try to fight the flush race: if the last assistant block
 * hasn't been written yet at Stop-hook time, status_box_present is `false`
 * and Phase 5 verdict path catches the race via a single retry.
 */
export function scanStatusBoxPresent(transcriptPath: string | undefined): boolean {
  const readablePath = resolveTranscriptPath(transcriptPath);
  if (!readablePath) return false;
  const text = tailText(readablePath);
  if (text === undefined) return false;
  // The box is rendered as a text content block by the assistant; we look
  // for the prefix on any line of the trailing window.
  return text.includes("┌─ agent-");
}

/**
 * Scan a CC-style JSONL transcript for a needle in ASSISTANT message text
 * blocks only. Used by `turn.completed` to detect the suggested session name in the
 * reply.
 *
 * The row filter is load-bearing: the transcript tail also carries the needle
 * inside `tool_result` rows (the `agents set-task` JSON output) and hook
 * context rows, so a raw `includes()` over the tail — the way the status-box
 * scan works — would false-pass the moment set-task runs. Verified empirically
 * 2026-08-09 against a live transcript.
 *
 * Same 256KB tail window as the other scans; the window's first line may be a
 * truncated JSON row, which the per-line parse guard skips.
 */
export function scanAssistantTextIncludes(
  transcriptPath: string | undefined,
  needle: string,
): boolean {
  if (!needle) return false;
  const readablePath = resolveTranscriptPath(transcriptPath);
  if (!readablePath) return false;
  const text = tailText(readablePath);
  if (!text) return false;
  for (const line of text.split("\n")) {
    // Cheap gate before parsing: most lines don't contain the needle at all.
    if (!line.includes(needle)) continue;
    try {
      const row = JSON.parse(line) as {
        type?: unknown;
        message?: { content?: unknown };
      };
      if (row.type !== "assistant") continue;
      const content = row.message?.content;
      if (typeof content === "string") {
        if (content.includes(needle)) return true;
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as { type?: unknown; text?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.includes(needle)) {
          return true;
        }
      }
    } catch {
      // Truncated/partial line (tail-window start or flush race); skip it.
    }
  }
  return false;
}

/** Most recent user-visible assistant text across Claude Code and Codex JSONL. */
export function scanLatestAssistantText(transcriptPath: string | undefined): string | undefined {
  const readablePath = resolveTranscriptPath(transcriptPath);
  if (!readablePath) return undefined;
  const text = tailText(readablePath);
  if (!text) return undefined;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = parseTranscriptRow(lines[i]);
    if (!row) continue;
    const assistantText = assistantTextFromRow(row);
    // Claude Code appends the current tool_use-only assistant row before
    // PreToolUse fires. Skip rows with no user-visible text so the immediately
    // preceding fenced block remains discoverable.
    if (assistantText !== null && assistantText.trim().length > 0) return assistantText;
  }
  return undefined;
}

/**
 * Verify that the first assistant message after the set-task result begins
 * with the exact session-name block. This is the Stop-time fallback for a
 * correctly displayed name followed by no further tool call. A name printed
 * after later work does not pass.
 */
export function scanSessionNameDisplayedImmediately(
  transcriptPath: string | undefined,
  name: string,
  startsWithBlock: (text: string, expectedName: string) => boolean,
): boolean {
  if (!name) return false;
  const readablePath = resolveTranscriptPath(transcriptPath);
  if (!readablePath) return false;
  const text = tailText(readablePath);
  if (!text) return false;
  let sawMintResult = false;
  for (const line of text.split("\n")) {
    if (!sawMintResult) {
      if (line.includes(name) && line.includes("suggested_session_name")) sawMintResult = true;
      continue;
    }
    const row = parseTranscriptRow(line);
    if (!row) continue;
    const assistantText = assistantTextFromRow(row);
    if (assistantText !== null) return startsWithBlock(assistantText, name);
  }
  return false;
}

/**
 * Resolve a transcript path at the adapter boundary. Windows-native Codex can
 * send `C:\...` while the managed hook executes inside WSL, where the same
 * file is mounted at `/mnt/c/...`.
 */
export function transcriptPathCandidates(transcriptPath: string | undefined): string[] {
  if (!transcriptPath) return [];
  const candidates = [transcriptPath];
  const windowsDrive = /^([A-Za-z]):[\\/](.*)$/.exec(transcriptPath);
  if (windowsDrive) {
    candidates.push(
      `/mnt/${windowsDrive[1]!.toLowerCase()}/${windowsDrive[2]!.replaceAll("\\", "/")}`,
    );
  }
  return [...new Set(candidates)];
}

function resolveTranscriptPath(transcriptPath: string | undefined): string | undefined {
  return transcriptPathCandidates(transcriptPath).find((candidate) => existsSync(candidate));
}

function parseTranscriptRow(line: string | undefined): Record<string, unknown> | null {
  if (!line?.trim()) return null;
  try {
    const row = JSON.parse(line) as unknown;
    return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** null means this row is not an assistant message; an empty string is one with no text. */
function assistantTextFromRow(row: Record<string, unknown>): string | null {
  if (row.type === "assistant") {
    const message = objectValue(row.message);
    return textFromContent(message?.content);
  }

  if (row.type === "response_item") {
    const payload = objectValue(row.payload);
    if (payload?.type !== "message" || payload.role !== "assistant") return null;
    return textFromContent(payload.content);
  }

  if (row.type === "event_msg") {
    const payload = objectValue(row.payload);
    if (payload?.type !== "agent_message") return null;
    return typeof payload.message === "string" ? payload.message : "";
  }

  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const value = objectValue(block);
    if (!value) continue;
    if ((value.type === "text" || value.type === "output_text") && typeof value.text === "string") {
      parts.push(value.text);
    }
  }
  return parts.join("\n");
}

/**
 * Resolve the agent's model from a CC-style JSONL transcript by reading the
 * most-recent assistant message's `message.model`. Claude Code's SessionStart
 * payload omits `model` (Codex + Cursor supply it directly), so this is the
 * fallback that lets `session.started` / `turn.completed` populate the cache's
 * model field once the transcript has at least one assistant turn.
 *
 * Tail-reads the same 256KB window as the status-box scan and walks lines from
 * the end, returning the first real model id found. Synthetic placeholders
 * (`<synthetic>`) and empty values are skipped. Returns undefined when the
 * transcript is missing/empty (e.g. a fresh session's first SessionStart).
 */
export function scanTranscriptModel(transcriptPath: string | undefined): string | undefined {
  const readablePath = resolveTranscriptPath(transcriptPath);
  if (!readablePath) return undefined;
  const text = tailText(readablePath);
  if (!text) return undefined;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line?.includes('"model"')) continue;
    try {
      const obj = JSON.parse(line) as {
        message?: { model?: unknown };
        model?: unknown;
      };
      const model = obj.message?.model ?? obj.model;
      if (typeof model === "string" && model.length > 0 && !model.startsWith("<")) {
        return model;
      }
    } catch {
      // Partial/truncated first line of the tail window; skip it.
    }
  }
  return undefined;
}

const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
/** Skip absurdly large transcripts rather than buffering them. */
const FORK_SCAN_MAX_BYTES = 128 * 1024 * 1024;
/** How many message uuids to sample across the fork's copied prefix. */
const FORK_SAMPLE_SIZE = 24;

/**
 * Detect the parent session of a forked CC conversation from its transcript.
 *
 * Empirical basis (verified 2026-08-05 against `claude --resume <id>
 * --fork-session`): the fork copies the parent's rows into a new
 * `<new-session-id>.jsonl`, rewriting every row's `sessionId` to the new id
 * but PRESERVING each copied message row's `uuid`. So a sibling transcript in
 * the same project directory that contains the fork's message uuids is an
 * ancestor of the fork.
 *
 * Ancestor vs. parent: a grandparent (when the parent was itself a fork)
 * shares the fork's early uuids too, but only the true parent contains the
 * whole copied prefix. At detection time the fork's transcript is almost
 * entirely copied prefix, so uuids sampled across the whole file separate the
 * two: score candidates by containment, highest wins.
 *
 * Sibling forks force a second rule: a PRIOR fork of the same parent also
 * contains the whole copied prefix, so it ties the true parent on score. The
 * sibling additionally carries its own post-fork turns, which the parent
 * lacks, so among tied scores the MINIMAL container (fewest message rows)
 * wins. A wrong pick under this rule stays within the ancestry (grandparent
 * at worst); a recency tie-break can name a non-ancestor sibling (observed
 * 2026-08-05 with two probes forked off one parent).
 *
 * Fail-soft by design: any read error, an unflushed transcript, or no
 * qualifying sibling returns undefined, which downgrades the caller to the
 * no-lineage behavior. Never throws.
 */
export function detectForkParent(
  transcriptPath: string | undefined,
  sessionId: string,
): string | undefined {
  try {
    if (!sessionId) return undefined;
    const readablePath = resolveTranscriptPath(transcriptPath);
    if (!readablePath) return undefined;
    if (statSync(readablePath).size > FORK_SCAN_MAX_BYTES) return undefined;
    const own = readFileSync(readablePath, "utf8");
    const uuids = messageUuids(own);
    if (uuids.length === 0) return undefined;
    const sample = sampleEvenly(uuids, FORK_SAMPLE_SIZE);

    const dir = dirname(readablePath);
    const ownFile = basename(readablePath);
    let best: { id: string; score: number; rows: number; mtimeMs: number } | null = null;
    for (const file of readdirSync(dir)) {
      if (file === ownFile || !SESSION_FILE_RE.test(file)) continue;
      const candidateId = file.slice(0, -".jsonl".length);
      if (candidateId === sessionId) continue;
      const path = join(dir, file);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.size > FORK_SCAN_MAX_BYTES) continue;
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      // Cheap gate before scoring: an ancestor must contain the fork's first
      // copied message uuid (the copy always starts at the beginning).
      if (!text.includes(sample[0]!)) continue;
      let score = 0;
      for (const u of sample) if (text.includes(u)) score++;
      if (score < Math.max(1, Math.ceil(sample.length / 2))) continue;
      const rows = messageUuids(text).length;
      const wins =
        !best ||
        score > best.score ||
        (score === best.score &&
          (rows < best.rows || (rows === best.rows && stat.mtimeMs < best.mtimeMs)));
      if (wins) best = { id: candidateId, score, rows, mtimeMs: stat.mtimeMs };
    }
    return best?.id;
  } catch {
    return undefined;
  }
}

/** Message-row uuids (user/assistant rows only), in file order. */
function messageUuids(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"uuid"')) continue;
    try {
      const row = JSON.parse(line) as { type?: unknown; uuid?: unknown };
      if (row.type !== "user" && row.type !== "assistant") continue;
      if (typeof row.uuid === "string" && row.uuid.length > 0) out.push(row.uuid);
    } catch {
      // Truncated/partial line (flush race); skip it.
    }
  }
  return out;
}

/** Up to <n> items spread evenly across the list, always including the first. */
function sampleEvenly(items: string[], n: number): string[] {
  if (items.length <= n) return items;
  const out: string[] = [];
  const step = items.length / n;
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]!);
  return out;
}

/** Tail-read up to 256KB from the end of a file as UTF-8, or undefined on error. */
function tailText(path: string): string | undefined {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - 256 * 1024);
    const fd = require("node:fs").openSync(path, "r");
    const buf = Buffer.alloc(size - start);
    require("node:fs").readSync(fd, buf, 0, buf.length, start);
    require("node:fs").closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return undefined;
  }
}
