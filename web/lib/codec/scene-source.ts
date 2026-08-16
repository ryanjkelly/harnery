/**
 * Server-side scene assembly: read the heartbeat snapshot and a bounded tail
 * of the canonical event log, sanitize at the ingestion boundary, and project
 * one CodecScene. Both codec routes call this; the browser never reduces raw
 * events.
 *
 * The tail is a fixed byte window, which is fine here (unlike a filtered
 * event feed) because every signal the projector folds is *latest-wins per
 * instance*: an older-than-window context sample or task_set simply leaves
 * that field `unknown`/projection-backed, which is the declared fallback.
 */

import fs from "node:fs";

import { eventsPath, readAgents } from "@/lib/coord-reader";

import type { CodecScene, CodecSourceEvidence } from "./contracts";
import { projectScene } from "./projector";
import { sanitizeLine } from "./sanitize";

/** How much of the log tail to fold. ~1KB/row → a few thousand recent rows. */
const TAIL_BYTES = 4_000_000;

export async function readSanitizedTail(filePath = eventsPath()): Promise<CodecSourceEvidence[]> {
  let text: string;
  try {
    const stat = await fs.promises.stat(filePath);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    if (start === 0) {
      text = await fs.promises.readFile(filePath, "utf8");
    } else {
      const fh = await fs.promises.open(filePath, "r");
      try {
        const length = stat.size - start;
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, start);
        text = buf.toString("utf8");
      } finally {
        await fh.close();
      }
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
  } catch {
    return []; // missing log = no event evidence; the snapshot still renders
  }

  const out: CodecSourceEvidence[] = [];
  for (const line of text.split("\n")) {
    const evidence = sanitizeLine(line);
    if (evidence) out.push(evidence);
  }
  return out;
}

export async function buildScene(now?: string): Promise<CodecScene> {
  const [snapshot, events] = [readAgents(), await readSanitizedTail()];
  return projectScene({ snapshot, events, ...(now ? { now } : {}) });
}

export function eventsFilePath(): string {
  return eventsPath();
}
