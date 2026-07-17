/**
 * Presence blob: the per-machine payload published to
 * `refs/harnery/presence/<machine>` (ADR 0016). One blob describes every live
 * session on this machine; peers render it in their agents list / status box /
 * peer table, labeled by machine.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMachineLabel } from "../../lib/machine.ts";

/** Mirror of the local heartbeat freshness window (commands/agents.ts). */
const FRESHNESS_SECS = 600;

/** Caps that bound the blob to ~1-2KB regardless of local state. */
const MAX_AGENTS = 20;
const MAX_FILES_PER_AGENT = 10;

export interface PresenceAgent {
  instance_id: string;
  name?: string;
  kind?: string;
  session_id?: string;
  platform?: string;
  task?: string;
  turn_summary?: string;
  files_touched?: string[];
  last_tool?: string;
  started_at?: string;
  last_heartbeat?: string;
}

export interface PresenceBlob {
  v: 1;
  machine: string;
  published_at: string;
  agents: PresenceAgent[];
}

export interface BuiltBlob {
  blob: PresenceBlob;
  /** Stable hash of the semantically-relevant projection — the change
   * detector that decides whether a publish is worth a push. */
  basisHash: string;
  json: string;
}

/**
 * Build this machine's presence blob from `.harnery/active/` heartbeats.
 * Includes live sessions + subagents; excludes kind=transient stubs (they are
 * fold-artifacts of the local claim model, not sessions) and anything past the
 * freshness window.
 */
export function buildPresenceBlob(coordRoot: string, now: Date = new Date()): BuiltBlob {
  const machine = resolveMachineLabel();
  const agents: PresenceAgent[] = [];
  const activeDir = join(coordRoot, ".harnery", "active");
  const cutoffMs = now.getTime() - FRESHNESS_SECS * 1000;

  if (existsSync(activeDir)) {
    for (const f of readdirSync(activeDir)) {
      if (!f.endsWith(".json")) continue;
      let hb: Record<string, unknown>;
      try {
        hb = JSON.parse(readFileSync(join(activeDir, f), "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof hb.instance_id !== "string") continue;
      if ((hb.kind as string | undefined) === "transient") continue;
      const ts = Date.parse((hb.last_heartbeat as string | undefined) ?? "");
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;
      agents.push({
        instance_id: hb.instance_id,
        name: strOr(hb.name),
        kind: strOr(hb.kind),
        session_id: strOr(hb.session_id),
        platform: strOr(hb.platform),
        task: strOr(hb.task),
        turn_summary: clamp(strOr(hb.turn_summary), 160),
        files_touched: Array.isArray(hb.files_touched)
          ? (hb.files_touched as string[]).slice(0, MAX_FILES_PER_AGENT)
          : undefined,
        last_tool: strOr(hb.last_tool),
        started_at: strOr(hb.started_at),
        last_heartbeat: strOr(hb.last_heartbeat),
      });
    }
  }

  agents.sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  const capped = agents.slice(0, MAX_AGENTS);

  const blob: PresenceBlob = {
    v: 1,
    machine,
    published_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    agents: capped,
  };

  // Basis: the fields whose change should trigger a re-publish. Timestamps
  // and last_tool are excluded (pure churn); task/turn_summary/files are the
  // signal peers actually read.
  const basis = capped.map((a) => ({
    i: a.instance_id,
    n: a.name ?? null,
    k: a.kind ?? null,
    t: a.task ?? null,
    s: a.turn_summary ?? null,
    f: [...(a.files_touched ?? [])].sort(),
  }));
  const basisHash = createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);

  return { blob, basisHash, json: JSON.stringify(blob) };
}

function strOr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function clamp(v: string | undefined, max: number): string | undefined {
  if (!v) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}
