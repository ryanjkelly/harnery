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
import { eventV3Paths, readLedgerV3 } from "../../../src/core/events/v3/reader";
import { SEMANTIC_HARD_CALLS_PER_HOUR } from "../../../src/core/semantic/scheduler";
import { readSemanticServiceStatus } from "../../../src/core/semantic/service-status";

import { artifactOwnerInstanceIds } from "../artifact-browser";
import type { CodecScene, CodecSourceEvidence } from "./contracts";
import { allocateCharacters } from "./packs";
import { projectScene } from "./projector";
import { deriveRelationships } from "./relationships";
import { readRemotePresence } from "./remote-source";
import { sanitizeEvent, sanitizeLine } from "./sanitize";
import { applySemanticReadModel } from "./semantic";
import { stripCodecSemantic } from "./semantic-contract";

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
  let scene = projectScene({ snapshot, events, ...(now ? { now } : {}) });
  // Optional semantic meaning is a separate validated presentation channel.
  // It may fill only low-information fields and never weakens the scene.
  try {
    const canonicalInstanceByPanel = new Map(
      [...snapshot.active, ...snapshot.stale, ...snapshot.terminal].map((row) => [
        row.instance_id,
        row.v3_instance_id ?? row.instance_id,
      ]),
    );
    applySemanticReadModel(
      scene,
      events,
      coordRoot(),
      now ? new Date(now) : new Date(),
      canonicalInstanceByPanel,
    );
  } catch {
    // deterministic scene stands
  }
  try {
    const status = readSemanticServiceStatus(coordRoot());
    scene.semantic_service = {
      running: status.running,
      stale: status.stale,
      state: status.record?.state ?? "not-started",
      pending_count: status.pending_count,
      model_calls: status.record?.model_calls ?? 0,
      rolling_calls: status.rolling_calls ?? {
        used: 0,
        limit: SEMANTIC_HARD_CALLS_PER_HOUR,
        available: SEMANTIC_HARD_CALLS_PER_HOUR,
      },
      routes: status.routes ?? [],
      rolling_usage: status.rolling_usage ?? {
        call_count: 0,
        outcomes: { accepted: 0, invalid: 0, unavailable: 0, deferred: 0 },
        native_tokens: {},
        estimated_tokens: {},
        invalid_reasons: {},
        unreported_calls: 0,
        breakdowns: [],
      },
      process_usage: status.process_usage ?? {
        call_count: 0,
        outcomes: { accepted: 0, invalid: 0, unavailable: 0, deferred: 0 },
        native_tokens: {},
        estimated_tokens: {},
        invalid_reasons: {},
        unreported_calls: 0,
        breakdowns: [],
      },
      ...(status.newest_successful_pass
        ? { newest_successful_pass: status.newest_successful_pass }
        : {}),
      ...(status.record?.last_error_code ? { last_error_code: status.record.last_error_code } : {}),
    };
  } catch {
    // Service health is optional; opening Codec never starts or repairs it.
  }
  // Remote panels from peer machines' presence blobs (relay cache). Local
  // panels win instance-id collisions: the local view is closer to the
  // source when the same session is observed twice.
  try {
    const remote = readRemotePresence(now ? new Date(now) : new Date());
    scene = {
      ...mergeRemotePanels(scene, remote.panels),
      remote_machines: remote.machines,
    };
  } catch {
    // local scene stands
  }
  // Artifact ownership is a local presentation capability. One bounded index
  // scan serves every card; no recursive inventory work and no per-card scan.
  try {
    const artifactOwners = artifactOwnerInstanceIds(coordRoot());
    for (const panel of scene.panels) {
      if (!panel.machine && artifactOwners.has(panel.instance_id)) {
        panel.has_artifact_workspace = true;
      }
    }
  } catch {
    // Missing or unreadable artifacts simply omit the Browse affordance.
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

/** Merge sparse relay panels without letting remote or duplicate rows replace
 * a closer local observation. Team ambience remains local-only because remote
 * presence blobs do not carry the evidence needed for that inference. */
export function mergeRemotePanels(
  scene: CodecScene,
  remotePanels: ReadonlyArray<CodecScene["panels"][number]>,
): CodecScene {
  const panels = [...scene.panels];
  const occupiedIds = new Set(panels.map((panel) => panel.instance_id));
  for (const panel of remotePanels) {
    if (occupiedIds.has(panel.instance_id)) continue;
    occupiedIds.add(panel.instance_id);
    panels.push(panel);
  }
  return { ...scene, panels };
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

// Match the V3 live-display contract so Codec does not pre-truncate valid
// intent text. The UI owns visual overflow with an edge fade.
const MAX_OVERLAY_CHARS = 240;

function clampOverlay(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_OVERLAY_CHARS ? trimmed.slice(0, MAX_OVERLAY_CHARS) : trimmed;
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

/** Drop local #intent history, artifact ownership, exact context counts, image
 * blob references, and every feed-derived focus value before relay publication. */
export function stripLiveFeedOverlay(scene: CodecScene): CodecScene {
  const { semantic_service: _semanticService, ...relaySafeScene } = scene;
  return {
    ...relaySafeScene,
    panels: scene.panels.map((panel) => {
      const {
        intent_history: _localIntents,
        has_artifact_workspace: _localArtifactOwnership,
        ...withoutLocalPresentation
      } = panel;
      let sanitized: CodecScene["panels"][number] = stripCodecSemantic(withoutLocalPresentation);
      if (sanitized.context_usage) {
        const {
          used_tokens: _usedTokens,
          limit_tokens: _limitTokens,
          remaining_tokens: _remainingTokens,
          ...percentages
        } = sanitized.context_usage.value;
        sanitized = {
          ...sanitized,
          context_usage: { ...sanitized.context_usage, value: percentages },
        };
      }
      if (sanitized.artifact_cue?.value.image_hash) {
        const {
          image_hash: _imageHash,
          image_media_type: _imageMediaType,
          image_bytes: _imageBytes,
          ...artifactLabel
        } = sanitized.artifact_cue.value;
        sanitized = {
          ...sanitized,
          artifact_cue: { ...sanitized.artifact_cue, value: artifactLabel },
        };
      }
      if (!sanitized.focus_bubble?.value.live_overlay) return sanitized;
      const { focus_bubble: _overlay, ...withoutOverlay } = sanitized;
      return withoutOverlay;
    }),
  };
}
