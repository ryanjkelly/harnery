/**
 * Remote panels from the cross-machine presence cache (Codec roadmap item 2).
 *
 * The presence relay daemon (ADR 0016) already publishes each machine's live
 * sessions E2E-encrypted and caches peers' blobs at
 * `.harnery/presence/remote/<machine>.json`. This module reads that cache with
 * pure fs — deliberately NOT through `core/presence`'s merged reader, whose
 * git-refs floor shells git and would drag a process launcher into the codec
 * import graph (boundary test). Consequence, documented in the plan: remote
 * panels require the relay transport; the git-refs-only floor does not feed
 * this view.
 *
 * A presence blob is a projection of the remote machine's heartbeats, so
 * remote panels carry `projection` provenance, no expressive evidence
 * (expression stays neutral, no action trail), and honest freshness: a stale
 * blob degrades its panels to `unknown` presence before the machine drops.
 */

import fs from "node:fs";
import path from "node:path";

import { harneryDir } from "@/lib/coord-reader";

import {
  type CodecActionCategory,
  type CodecActionOutcome,
  type CodecActivity,
  type CodecLifecycle,
  type CodecPanelScene,
  type Confidence,
  FALLBACK_PACK,
  type Presented,
} from "./contracts";

/** Blob ages: fresh blobs light presence; older ones degrade; oldest drop. */
const BLOB_FRESH_MS = 120_000;
const BLOB_STALE_MS = 5 * 60_000;
const BLOB_DROP_MS = 10 * 60_000;
const DIGEST_FRESH_MS = 2 * 60_000;
const DIGEST_AGING_MS = 5 * 60_000;
/** Per-agent heartbeat freshness inside a fresh blob (mirrors local active). */
const AGENT_FRESH_MS = 5 * 60_000;
const MAX_LABEL = 120;

function present<T>(
  value: T,
  provenance: Presented<T>["provenance"],
  confidence: Confidence,
  observedAt: string,
  evidenceEventIds?: string[],
): Presented<T> {
  return {
    value,
    provenance,
    confidence,
    observed_at: observedAt,
    ...(evidenceEventIds?.length ? { evidence_event_ids: evidenceEventIds.slice(-3) } : {}),
  };
}

function clampLabel(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const t = v.trim();
  return t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL - 1)}…` : t;
}

/** Read every peer machine's cached presence blob and render remote panels. */
export function readRemotePanels(now = new Date(), root = harneryDir()): CodecPanelScene[] {
  const dir = path.join(root, "presence", "remote");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no relay cache = no remote panels, never an error
  }

  const nowMs = now.getTime();
  const panels: CodecPanelScene[] = [];

  for (const file of files.sort()) {
    let blob: Record<string, unknown>;
    try {
      blob = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (blob?.v !== 1 || typeof blob.machine !== "string" || !Array.isArray(blob.agents)) {
      continue; // fail closed on unknown blob versions
    }
    const publishedMs = Date.parse(String(blob.published_at ?? ""));
    if (!Number.isFinite(publishedMs) || nowMs - publishedMs > BLOB_DROP_MS) continue;
    const blobFresh = nowMs - publishedMs <= BLOB_FRESH_MS;
    const relayAgeMs = Math.max(0, nowMs - publishedMs);
    const machine = clampLabel(blob.machine) ?? "remote";
    const publishedAt = new Date(publishedMs).toISOString();

    for (const raw of blob.agents as Array<Record<string, unknown>>) {
      const instanceId = typeof raw.instance_id === "string" ? raw.instance_id : undefined;
      if (!instanceId) continue;

      const hbMs = Date.parse(String(raw.last_heartbeat ?? ""));
      const agentFresh = Number.isFinite(hbMs) && nowMs - hbMs <= AGENT_FRESH_MS;
      const online = blobFresh && agentFresh;

      const activityRaw = raw.activity;
      const activity: CodecActivity =
        activityRaw === "working"
          ? "working"
          : activityRaw === "needs_input"
            ? "needs-input"
            : activityRaw === "idle"
              ? "idle"
              : "unknown";

      const lifecycleRaw = raw.task_state;
      const lifecycle: CodecLifecycle =
        lifecycleRaw === "active" || lifecycleRaw === "blocked" || lifecycleRaw === "done"
          ? lifecycleRaw
          : "unknown";

      const task = clampLabel(raw.task);
      const codec = record(raw.codec);
      const codecValid = codec?.schema_version === 1;
      const codecObservedAt = codecValid ? iso(codec.observed_at) : undefined;
      const codecAgeMs = codecObservedAt
        ? Math.max(0, nowMs - Date.parse(codecObservedAt))
        : undefined;
      const operationRaw = codecValid ? record(codec.operation) : undefined;
      const operationCategory = actionCategory(operationRaw?.category);
      const operationLabel = clampLabel(operationRaw?.label);
      const operationEventId = eventId(operationRaw?.event_id);
      const operationObservedAt = iso(operationRaw?.observed_at) ?? publishedAt;
      const contextRaw = codecValid ? record(codec.context) : undefined;
      const contextPercent = boundedPercent(contextRaw?.used_percent);
      const contextEventId = eventId(contextRaw?.event_id);
      const contextObservedAt = iso(contextRaw?.observed_at) ?? publishedAt;
      const recentActions = codecValid
        ? (Array.isArray(codec.recent_actions) ? codec.recent_actions : [])
            .map((action) => remoteAction(action))
            .filter((action): action is NonNullable<typeof action> => action !== undefined)
            .slice(-3)
        : [];
      panels.push({
        instance_id: instanceId,
        identity: {
          display_name: clampLabel(raw.name) ?? instanceId.slice(0, 8),
          ...(task ? { task: present(task, "projection", "medium", publishedAt) } : {}),
        },
        machine,
        remote_source: {
          relay: present(
            {
              state:
                relayAgeMs <= BLOB_FRESH_MS
                  ? "fresh"
                  : relayAgeMs <= BLOB_STALE_MS
                    ? "aging"
                    : "stale",
              age_ms: relayAgeMs,
            },
            "projection",
            blobFresh ? "high" : "medium",
            publishedAt,
          ),
          ...(codecObservedAt && codecAgeMs !== undefined
            ? {
                digest: present(
                  {
                    state:
                      codecAgeMs <= DIGEST_FRESH_MS
                        ? "fresh"
                        : codecAgeMs <= DIGEST_AGING_MS
                          ? "aging"
                          : "stale",
                    age_ms: codecAgeMs,
                  },
                  "projection",
                  codecAgeMs <= DIGEST_FRESH_MS ? "high" : "medium",
                  codecObservedAt,
                ),
              }
            : {}),
        },
        presence: online
          ? present("online", "projection", "medium", publishedAt)
          : present("unknown", "projection", "low", publishedAt),
        activity: present(
          activity,
          activity === "unknown" ? "unknown" : "projection",
          online ? "high" : "low",
          publishedAt,
        ),
        // The blob cannot distinguish a declared task_state from its
        // compatibility default, so remote lifecycle never claims better
        // than medium confidence.
        lifecycle: present(lifecycle, "projection", "medium", publishedAt),
        expression: present("neutral", "projection", "high", publishedAt),
        attention: present("none", "projection", "high", publishedAt),
        context_band:
          contextPercent === undefined
            ? present("unknown", "unknown", "low", publishedAt)
            : present(
                contextPercent >= 85 ? "low" : contextPercent >= 65 ? "reduced" : "ample",
                "projection",
                contextRaw?.confidence === "exact" ? "high" : "medium",
                contextObservedAt,
                contextEventId ? [contextEventId] : undefined,
              ),
        progress_rhythm: present("unknown", "unknown", "low", publishedAt),
        recent_actions: recentActions,
        ...(operationRaw && operationCategory && operationLabel && operationEventId
          ? {
              operation: present(
                { category: operationCategory, label: operationLabel, state: "active" as const },
                "projection",
                "medium",
                operationObservedAt,
                [operationEventId],
              ),
            }
          : {}),
        character: { ...FALLBACK_PACK }, // pack assets are machine-local
        updated_at: publishedAt,
      });
    }
  }
  return panels;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function eventId(value: unknown): string | undefined {
  return typeof value === "string" && /^evt_[a-zA-Z0-9_-]+$/.test(value) ? value : undefined;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function boundedPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function actionCategory(value: unknown): CodecActionCategory | undefined {
  return value === "research" ||
    value === "diagnostic" ||
    value === "build" ||
    value === "edit" ||
    value === "test" ||
    value === "coordinate" ||
    value === "other"
    ? value
    : undefined;
}

function remoteAction(value: unknown):
  | {
      category: CodecActionCategory;
      outcome: CodecActionOutcome;
      event_id: string;
      observed_at: string;
    }
  | undefined {
  const action = record(value);
  const category = actionCategory(action?.category);
  const outcome = action?.outcome;
  const id = eventId(action?.event_id);
  const observedAt = iso(action?.observed_at);
  if (
    !category ||
    (outcome !== "ok" && outcome !== "error" && outcome !== "unknown") ||
    !id ||
    !observedAt
  ) {
    return undefined;
  }
  return { category, outcome, event_id: id, observed_at: observedAt };
}
