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
import { allocateCharacters } from "./packs";
import { projectScene } from "./projector";
import { readRemotePanels } from "./remote-source";
import { sanitizeLine } from "./sanitize";
import { applySuggestions } from "./suggestions";

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
  const scene = projectScene({ snapshot, events, ...(now ? { now } : {}) });
  // Optional styler suggestions: read-only merge of validated, expiring
  // low-confidence styling into fallback-valued channels. Failure = no
  // styling, never a degraded scene.
  try {
    applySuggestions(scene, events);
  } catch {
    // deterministic scene stands
  }
  // Remote panels from peer machines' presence blobs (relay cache). Local
  // panels win instance-id collisions: the local view is closer to the
  // source when the same session is observed twice.
  try {
    const localIds = new Set(scene.panels.map((p) => p.instance_id));
    for (const panel of readRemotePanels()) {
      if (!localIds.has(panel.instance_id)) scene.panels.push(panel);
    }
  } catch {
    // local scene stands
  }
  // Character assignment is presentation metadata layered on after the pure
  // projection; a registry failure leaves the fallback pack in place.
  try {
    const characters = allocateCharacters(
      scene.panels.map((p) => p.instance_id),
      scene.generated_at,
    );
    for (const panel of scene.panels) {
      const assigned = characters.get(panel.instance_id);
      if (assigned) panel.character = assigned;
    }
  } catch {
    // fallback pack stands
  }
  return scene;
}

export function eventsFilePath(): string {
  return eventsPath();
}
