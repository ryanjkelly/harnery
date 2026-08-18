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
  type CodecActivity,
  type CodecLifecycle,
  type CodecPanelScene,
  type Confidence,
  FALLBACK_PACK,
  type Presented,
} from "./contracts";

/** Blob ages: fresh blobs light presence; older ones degrade; oldest drop. */
const BLOB_FRESH_MS = 120_000;
const BLOB_DROP_MS = 10 * 60_000;
/** Per-agent heartbeat freshness inside a fresh blob (mirrors local active). */
const AGENT_FRESH_MS = 5 * 60_000;
const MAX_LABEL = 120;

function present<T>(
  value: T,
  provenance: Presented<T>["provenance"],
  confidence: Confidence,
  observedAt: string,
): Presented<T> {
  return { value, provenance, confidence, observed_at: observedAt };
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
      panels.push({
        instance_id: instanceId,
        identity: {
          display_name: clampLabel(raw.name) ?? instanceId.slice(0, 8),
          ...(task ? { task: present(task, "projection", "medium", publishedAt) } : {}),
        },
        machine,
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
        context_band: present("unknown", "unknown", "low", publishedAt),
        progress_rhythm: present("unknown", "unknown", "low", publishedAt),
        recent_actions: [],
        character: { ...FALLBACK_PACK }, // pack assets are machine-local
        updated_at: publishedAt,
      });
    }
  }
  return panels;
}
