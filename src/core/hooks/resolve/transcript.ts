import { existsSync, statSync } from "node:fs";

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
