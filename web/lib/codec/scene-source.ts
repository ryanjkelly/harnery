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

import {
  type AgentsSnapshot,
  coordRoot,
  historyNameForInstance,
  readCachedAgentsForCodec,
} from "@/lib/coord-reader";
import { readDurableWork } from "@/lib/work-reader";
import { readWorkflowChildSessionsFromCache } from "@/lib/workflow-reader";
import {
  EVENT_V3_LIVE_RELATIVE_ROOT,
  type LiveDisplayRowV3,
  readLiveDisplayV3,
} from "../../../src/core/events/v3/live-feed";
import { nativeInstanceIdV3 } from "../../../src/core/events/v3/live-route-observer";
import { eventV3Paths } from "../../../src/core/events/v3/reader";
import { SEMANTIC_HARD_CALLS_PER_HOUR } from "../../../src/core/semantic/scheduler";
import { readSemanticServiceStatus } from "../../../src/core/semantic/service-status";

import { artifactOwnerInstanceIds } from "../artifact-browser";
import type { CodecScene, CodecSourceEvidence } from "./contracts";
import { allocateCharacters } from "./packs";
import { projectScene } from "./projector";
import { deriveRelationships } from "./relationships";
import { readRemotePresence } from "./remote-source";
import { sanitizeLine } from "./sanitize";
import { applySemanticReadModel } from "./semantic";
import { stripCodecSemantic } from "./semantic-contract";

/** How much of the log tail to fold. ~1KB/row → a few thousand recent rows. */
const TAIL_BYTES = 4_000_000;

interface SanitizedTailRow {
  event: CodecSourceEvidence;
  sourceBytes: number;
}

interface SanitizedTailCache {
  device: bigint;
  inode: bigint;
  size: number;
  partial: string;
  rows: SanitizedTailRow[];
  rowBytes: number;
}

const sanitizedTailCache = new Map<string, SanitizedTailCache>();

interface CachedLiveDisplayFile {
  size: number;
  modifiedAtMs: number;
  rows: LiveDisplayRowV3[];
}

const liveDisplayCache = new Map<string, Map<string, CachedLiveDisplayFile>>();
const LIVE_DISPLAY_HARD_TTL_MS = 60 * 60 * 1_000;

/** Cache unchanged append-only live-display files while rechecking row expiry
 * on every projection. A directory listing plus metadata checks replaces
 * reparsing hundreds of historical generation files every five seconds. */
export function listCachedLiveDisplayForCodec(
  root: string,
  now: Date = new Date(),
): LiveDisplayRowV3[] {
  const liveRoot = path.join(root, EVENT_V3_LIVE_RELATIVE_ROOT);
  let names: string[];
  try {
    names = fs.readdirSync(liveRoot).filter((name) => name.endsWith(".ndjson"));
  } catch {
    liveDisplayCache.delete(root);
    return [];
  }

  const files = liveDisplayCache.get(root) ?? new Map<string, CachedLiveDisplayFile>();
  liveDisplayCache.set(root, files);
  const present = new Set(names);
  const nowMs = now.getTime();
  const rows: LiveDisplayRowV3[] = [];

  for (const name of names) {
    const filePath = path.join(liveRoot, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      files.delete(name);
      continue;
    }
    const cached = files.get(name);
    let fileRows = cached?.rows ?? [];
    if (!cached || cached.size !== stat.size || cached.modifiedAtMs !== stat.mtimeMs) {
      const generationId = name.slice(0, -".ndjson".length);
      try {
        fileRows = readLiveDisplayV3(root, generationId, () => now);
      } catch {
        fileRows = [];
      }
      files.set(name, { size: stat.size, modifiedAtMs: stat.mtimeMs, rows: fileRows });
    }
    rows.push(
      ...fileRows.filter((row) => {
        const writtenAtMs = Date.parse(row.written_at);
        return Date.parse(row.expires_at) > nowMs && writtenAtMs + LIVE_DISPLAY_HARD_TTL_MS > nowMs;
      }),
    );
  }
  for (const name of files.keys()) {
    if (!present.has(name)) files.delete(name);
  }
  return rows;
}

async function readRange(filePath: string, start: number, length: number): Promise<Buffer> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === buffer.length ? buffer : buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function sanitizedRows(text: string): SanitizedTailRow[] {
  const rows: SanitizedTailRow[] = [];
  for (const line of text.split("\n")) {
    const event = sanitizeLine(line);
    if (event) rows.push({ event, sourceBytes: Buffer.byteLength(line, "utf8") + 1 });
  }
  return rows;
}

function trimTail(cache: SanitizedTailCache): void {
  while (cache.rowBytes > TAIL_BYTES && cache.rows.length > 1) {
    cache.rowBytes -= cache.rows.shift()?.sourceBytes ?? 0;
  }
}

/** Read a bounded validated tail once, then validate only newly appended
 * complete rows while the active file keeps the same identity. */
export async function readIncrementalSanitizedTail(
  filePath: string,
): Promise<CodecSourceEvidence[]> {
  const stat = await fs.promises.stat(filePath, { bigint: true });
  const size = Number(stat.size);
  const cached = sanitizedTailCache.get(filePath);
  if (cached && cached.device === stat.dev && cached.inode === stat.ino && size >= cached.size) {
    if (size > cached.size) {
      const appended = await readRange(filePath, cached.size, size - cached.size);
      const text = cached.partial + appended.toString("utf8");
      const finalNewline = text.lastIndexOf("\n");
      if (finalNewline >= 0) {
        const complete = text.slice(0, finalNewline + 1);
        const added = sanitizedRows(complete);
        cached.rows.push(...added);
        cached.rowBytes += added.reduce((sum, row) => sum + row.sourceBytes, 0);
        cached.partial = text.slice(finalNewline + 1);
        trimTail(cached);
      } else {
        cached.partial = text;
      }
      cached.size = size;
    }
    return cached.rows.map((row) => row.event);
  }

  const start = Math.max(0, size - TAIL_BYTES);
  let text = (await readRange(filePath, start, size - start)).toString("utf8");
  if (start > 0) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  }
  const finalNewline = text.lastIndexOf("\n");
  const complete = finalNewline >= 0 ? text.slice(0, finalNewline + 1) : "";
  const partial = finalNewline >= 0 ? text.slice(finalNewline + 1) : text;
  const rows = sanitizedRows(complete);
  const next: SanitizedTailCache = {
    device: stat.dev,
    inode: stat.ino,
    size,
    partial,
    rows,
    rowBytes: rows.reduce((sum, row) => sum + row.sourceBytes, 0),
  };
  trimTail(next);
  sanitizedTailCache.set(filePath, next);
  return next.rows.map((row) => row.event);
}

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
  // Codec is a presentation projection, not an authority reader. Reading the
  // complete ledger here retained every parsed event and re-sanitized the
  // entire history on every scene refresh. The active authority can grow to
  // tens of megabytes, while the projector explicitly needs only a bounded
  // latest-wins tail. Each retained row still crosses sanitizeEvent's full V3
  // contract validator; malformed and partial final frames fail closed.
  const activePath = eventV3Paths(root).active;
  if (!fs.existsSync(activePath)) return [];
  const rows = await readIncrementalSanitizedTail(activePath);
  try {
    return applyLiveFeedOverlay(rows, listCachedLiveDisplayForCodec(root));
  } catch {
    return rows;
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
  const [snapshot, events] = await Promise.all([
    Promise.resolve(readCachedAgentsForCodec()),
    readSanitizedTail(),
  ]);
  return { snapshot, events };
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
  try {
    for (const panel of scene.panels) {
      if (panel.machine) continue;
      const hist = historyNameForInstance(panel.instance_id);
      if (!hist) continue;
      const shortId = nativeInstanceIdV3(panel.instance_id).slice(0, 8);
      if (!panel.identity.display_name.trim() || panel.identity.display_name === shortId) {
        panel.identity.display_name = hist;
      }
    }
  } catch {
    // History is optional presentation; the short-id fallback stands.
  }
  // Character assignment is presentation metadata layered on after the pure
  // projection; a registry failure leaves the fallback pack in place. Every
  // visible panel receives a local presentation pack, including remote,
  // offline, and unknown-presence sessions. Pack assets are served by this
  // dashboard, so the source machine does not need to own the selected pack.
  try {
    const characters = allocateCharacters(
      scene.panels.map((panel) => ({
        instance_id: panel.instance_id,
        display_name: panel.identity.display_name,
      })),
      scene.generated_at,
    );
    for (const panel of scene.panels) {
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
    const cachedChildren = [...snapshot.active, ...snapshot.stale, ...snapshot.terminal];
    const items = readDurableWork(root).map((r) => ({
      id: r.projection.id,
      state: r.projection.state,
      dependencies: r.intent.dependencies ?? [],
      unresolved_dependencies: r.projection.unresolved_dependencies ?? [],
      ...(r.projection.latest_run_id ? { latest_run_id: r.projection.latest_run_id } : {}),
    }));
    scene.relationships = deriveRelationships(scene.panels, items, (runId) =>
      readWorkflowChildSessionsFromCache(root, runId, cachedChildren).map((c) => c.sessionId),
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
  const paths = eventV3Paths(root);
  const watched = [paths.active, paths.catalog];
  const liveRoot = path.join(root, EVENT_V3_LIVE_RELATIVE_ROOT);
  if (fs.existsSync(liveRoot)) watched.push(liveRoot);
  return watched;
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
