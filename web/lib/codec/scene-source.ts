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
import path from "node:path";

import { type AgentsSnapshot, coordRoot, readAgents } from "@/lib/coord-reader";
import { readDurableWork } from "@/lib/work-reader";
import { readWorkflowChildSessions } from "@/lib/workflow-reader";
import { readEventV3ControlState } from "../../../src/core/events/v3/control";
import {
  EVENT_V3_LIVE_RELATIVE_ROOT,
  type LiveDisplayRowV3,
  listLiveDisplayV3,
} from "../../../src/core/events/v3/live-feed";
import { readLedgerV3 } from "../../../src/core/events/v3/reader";
import { eventV3Paths } from "../../../src/core/events/v3/writer";

import type { CodecScene, CodecSourceEvidence } from "./contracts";
import { allocateCharacters } from "./packs";
import { projectScene } from "./projector";
import { deriveRelationships } from "./relationships";
import { readRemotePanels } from "./remote-source";
import { sanitizeEvent, sanitizeLine } from "./sanitize";
import { applySuggestions } from "./suggestions";

/** How much of the log tail to fold. ~1KB/row → a few thousand recent rows. */
const TAIL_BYTES = 4_000_000;

async function readOneSanitizedTail(filePath: string): Promise<CodecSourceEvidence[]> {
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

export async function readSanitizedTail(filePath?: string): Promise<CodecSourceEvidence[]> {
  if (filePath) return readSanitizedTails([filePath]);

  const root = coordRoot();
  const control = readEventV3ControlState(root);
  if (control.state !== "candidate" && control.state !== "active") return [];

  const ledger = readLedgerV3(root);
  if (!ledger.complete) return [];
  const rows = ledger.events
    .map(({ event }) => sanitizeEvent(event))
    .filter((event): event is CodecSourceEvidence => event !== null);
  const sliced = rows.slice(-Math.max(1, Math.floor(TAIL_BYTES / 1_000)));
  try {
    return applyLiveFeedOverlay(sliced, listLiveDisplayV3(root));
  } catch {
    return sliced;
  }
}

export async function readSanitizedTails(filePaths: string[]): Promise<CodecSourceEvidence[]> {
  const rows = (await Promise.all(filePaths.map(readOneSanitizedTail))).flat();
  rows.sort(
    (left, right) =>
      Date.parse(left.ts) - Date.parse(right.ts) || left.event_id.localeCompare(right.event_id),
  );
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.event_id)) return false;
    seen.add(row.event_id);
    return true;
  });
}

export interface CodecSceneSource {
  snapshot: AgentsSnapshot;
  events: CodecSourceEvidence[];
}

export async function readSceneSource(): Promise<CodecSceneSource> {
  return { snapshot: readAgents(), events: await readSanitizedTail() };
}

export async function buildScene(now?: string, source?: CodecSceneSource): Promise<CodecScene> {
  const { snapshot, events } = source ?? (await readSceneSource());
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
  // projection; a registry failure leaves the fallback pack in place. Remote
  // panels are excluded — pack assets are machine-local, and binding a local
  // pack to a remote session would burn roster slots on portraits that can
  // never render. Offline and unknown panels keep the fallback letter pack
  // so the six-character roster stays on live sessions.
  try {
    const localLive = scene.panels.filter((p) => !p.machine && p.presence.value === "online");
    const characters = allocateCharacters(
      localLive.map((p) => p.instance_id),
      scene.generated_at,
    );
    for (const panel of localLive) {
      const assigned = characters.get(panel.instance_id);
      if (assigned) panel.character = assigned;
    }
  } catch {
    // fallback pack stands
  }
  // Relationship edges: parentage plus provable durable-work dependencies.
  // Failure means no lines, never a degraded scene.
  try {
    const root = coordRoot();
    const items = readDurableWork(root).map((r) => ({
      id: r.projection.id,
      state: r.projection.state,
      dependencies: r.intent.dependencies ?? [],
      unresolved_dependencies: r.projection.unresolved_dependencies ?? [],
      ...(r.projection.latest_run_id ? { latest_run_id: r.projection.latest_run_id } : {}),
    }));
    scene.relationships = deriveRelationships(scene.panels, items, (runId) =>
      readWorkflowChildSessions(root, runId).map((c) => c.sessionId),
    );
  } catch {
    scene.relationships = [];
  }
  return scene;
}

export function eventsFilePaths(): string[] {
  const root = coordRoot();
  const control = readEventV3ControlState(root);
  if (control.state === "candidate" || control.state === "active") {
    const paths = eventV3Paths(root);
    const watched = [paths.active, paths.catalog];
    const liveRoot = path.join(root, EVENT_V3_LIVE_RELATIVE_ROOT);
    if (fs.existsSync(liveRoot)) watched.push(liveRoot);
    return watched;
  }
  return [];
}

const MAX_OVERLAY_CHARS = 120;

function clampOverlay(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_OVERLAY_CHARS
    ? `${trimmed.slice(0, MAX_OVERLAY_CHARS - 1)}…`
    : trimmed;
}

/** Attach unexpired live-display intent onto matching evidence event ids. */
export function applyLiveFeedOverlay(
  events: readonly CodecSourceEvidence[],
  overlays: readonly LiveDisplayRowV3[],
): CodecSourceEvidence[] {
  const byEvent = new Map<string, LiveDisplayRowV3>();
  for (const row of overlays) {
    if (!row.intent_display) continue;
    byEvent.set(row.event_id, row);
  }
  if (byEvent.size === 0) return [...events];
  return events.map((event) => {
    const row = byEvent.get(event.event_id);
    if (!row?.intent_display) return event;
    const intent = clampOverlay(row.intent_display);
    if (!intent) return event;
    return { ...event, intent, live_overlay: true };
  });
}

/** Drop every feed-derived display value before relay publication. */
export function stripLiveFeedOverlay(scene: CodecScene): CodecScene {
  return {
    ...scene,
    panels: scene.panels.map((panel) => {
      if (!panel.focus_bubble?.value.live_overlay) return panel;
      const { focus_bubble: _overlay, ...rest } = panel;
      return rest;
    }),
  };
}
