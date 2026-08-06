import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Scan a CC-style JSONL transcript for the `┌─ agent-` status-box prefix in
 * the most-recent assistant turn. Used by `turn.stop` events to populate
 * `status_box_present`.
 *
 * Cheap by default: caps the read at 256KB tailed from the file, since the
 * status box (if present) is always near the end of the most-recent turn.
 * Phase 2 doesn't try to fight the flush race: if the last assistant block
 * hasn't been written yet at Stop-hook time, status_box_present is `false`
 * and Phase 5 verdict path catches the race via a single retry.
 */
export function scanStatusBoxPresent(transcriptPath: string | undefined): boolean {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  const text = tailText(transcriptPath);
  if (text === undefined) return false;
  // The box is rendered as a text content block by the assistant; we look
  // for the prefix on any line of the trailing window.
  return text.includes("┌─ agent-");
}

/**
 * Resolve the agent's model from a CC-style JSONL transcript by reading the
 * most-recent assistant message's `message.model`. Claude Code's SessionStart
 * payload omits `model` (Codex + Cursor supply it directly), so this is the
 * fallback that lets `session.start` / `turn.stop` populate the heartbeat's
 * model field once the transcript has at least one assistant turn.
 *
 * Tail-reads the same 256KB window as the status-box scan and walks lines from
 * the end, returning the first real model id found. Synthetic placeholders
 * (`<synthetic>`) and empty values are skipped. Returns undefined when the
 * transcript is missing/empty (e.g. a fresh session's first SessionStart).
 */
export function scanTranscriptModel(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath || !existsSync(transcriptPath)) return undefined;
  const text = tailText(transcriptPath);
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
    if (!transcriptPath || !sessionId || !existsSync(transcriptPath)) return undefined;
    if (statSync(transcriptPath).size > FORK_SCAN_MAX_BYTES) return undefined;
    const own = readFileSync(transcriptPath, "utf8");
    const uuids = messageUuids(own);
    if (uuids.length === 0) return undefined;
    const sample = sampleEvenly(uuids, FORK_SAMPLE_SIZE);

    const dir = dirname(transcriptPath);
    const ownFile = basename(transcriptPath);
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
