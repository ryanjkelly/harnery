/**
 * Per-agent summary: identity registry entry + current activity state
 * (live heartbeat OR most-recent scratch archive). Server-side helper;
 * fed to `<AgentChipProvider>` so AgentChip popovers render with persona
 * metadata baked in (no client-side FS reads).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { type InstanceIdentity, coordRoot } from "./coord-reader";
import { type AgentIdentity, lookupByName } from "./identities";

export interface AgentSummary {
  /** Bare name without the `agent-` prefix. */
  name: string;
  /** Durable persona UUID (may be "" when identity lookup misses). */
  agent_id: string;
  state: "active" | "stale" | "unknown";
  last_seen: string | null;
  created_at: string;
  aliases: AgentIdentity["aliases"];
  instance_id?: string;
  session_id?: string;
  kind?: string | null;
  platform?: string | null;
  model?: string | null;
  started_at?: string;
  task?: string | null;
  last_tool?: string | null;
  last_tool_target?: string | null;
  files_touched?: string[];
  turn_summary?: string | null;
  /** For subagents (kind === "subagent"): the parent agent's display name,
   * resolved from the dispatching session. null when the parent has exited. */
  parent?: string | null;
  /** For subagents: the Agent-tool subagent type (Explore, general-purpose, …). */
  agent_type?: string | null;
}

const STALE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface ActivityState {
  state: "active" | "stale";
  last_seen: string;
  instance_id?: string;
  session_id?: string;
  kind?: string | null;
  platform?: string | null;
  model?: string | null;
  started_at?: string;
  task?: string | null;
  last_tool?: string | null;
  last_tool_target?: string | null;
  files_touched?: string[];
  turn_summary?: string | null;
}

function readActiveIndex(): {
  byName: Map<string, ActivityState>;
  idToName: Map<string, string>;
} {
  const out = new Map<string, ActivityState>();
  // EVERY heartbeat's instance_id → display name (no per-name dedupe): the
  // lookup table for resolving a subagent's session_id to its parent's name.
  const idToName = new Map<string, string>();
  const dir = path.join(coordRoot(), ".harnery", "active");
  if (!existsSync(dir)) return { byName: out, idToName };
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const hb = JSON.parse(readFileSync(path.join(dir, f), "utf-8")) as {
        instance_id?: string;
        name?: string;
        last_heartbeat?: string;
        started_at?: string;
        session_id?: string;
        kind?: string | null;
        platform?: string | null;
        model?: string | null;
        task?: string | null;
        last_tool?: string | null;
        last_tool_target?: string | null;
        files_touched?: string[];
        turn_summary?: string | null;
      };
      if (!hb.name) continue;
      if (hb.instance_id) idToName.set(hb.instance_id, hb.name);
      const bare = (
        hb.name.startsWith("agent-") ? hb.name.slice("agent-".length) : hb.name
      ).toLowerCase();
      const last_seen = hb.last_heartbeat ?? new Date().toISOString();
      const prior = out.get(bare);
      if (!prior || prior.last_seen < last_seen) {
        out.set(bare, {
          state: "active",
          last_seen,
          instance_id: hb.instance_id,
          session_id: hb.session_id,
          kind: hb.kind ?? null,
          platform: hb.platform ?? null,
          model: hb.model ?? null,
          started_at: hb.started_at,
          task: hb.task ?? null,
          last_tool: hb.last_tool ?? null,
          last_tool_target: hb.last_tool_target ?? null,
          files_touched: hb.files_touched ?? [],
          turn_summary: hb.turn_summary ?? null,
        });
      }
    } catch {
      /* skip unreadable */
    }
  }
  return { byName: out, idToName };
}

/**
 * Resolve a live subagent heartbeat's parent linkage. A subagent's heartbeat
 * carries `session_id` = the dispatching parent's instance_id (the subagent
 * runs inside the parent's session), so the parent's display name is one map
 * lookup away, with no event-log read required. Pure function so it's
 * unit-testable without a coordRoot.
 *
 * Returns null for non-subagents (caller spreads nothing; main-agent entries
 * keep `parent`/`agent_type` undefined exactly as before). For subagents it
 * always returns both fields: `parent` is null when the parent's heartbeat is
 *  gone (AgentChip renders that as "parent exited", a true statement at that
 * point), and `agent_type` is null when the durable identities map isn't
 * provided or has no record yet.
 *
 * READ-SIDE ONLY by design. An earlier attempt to make fresh agents visible by
 * adding a write-path projection (1d79a52) was reverted (70f739f) as redundant
 * dead weight; this helper takes the opposite route: the data is already on
 * disk, we just stopped dropping it at the merge.
 */
export function resolveSubagentLinkage(
  activity: {
    kind?: string | null;
    instance_id?: string;
    session_id?: string;
  },
  idToName: ReadonlyMap<string, string>,
  identities?: Record<string, InstanceIdentity>,
): { parent: string | null; agent_type: string | null } | null {
  if (activity.kind !== "subagent") return null;
  const sid = activity.session_id;
  // Guard the self-referential case (session_id === instance_id is the
  // main-agent shape; on a subagent it means a malformed heartbeat).
  const parentRaw =
    sid && sid !== activity.instance_id ? (idToName.get(sid) ?? null) : null;
  const parent = parentRaw
    ? parentRaw.startsWith("agent-")
      ? parentRaw.slice("agent-".length)
      : parentRaw
    : null;
  const agent_type =
    (activity.instance_id && identities?.[activity.instance_id]?.agent_type) || null;
  return { parent, agent_type };
}

function readScratchIndex(): Map<string, ActivityState> {
  const out = new Map<string, ActivityState>();
  const dir = path.join(coordRoot(), ".harnery", "scratch", "archived");
  if (!existsSync(dir)) return out;
  const cutoff = Date.now() - STALE_WINDOW_MS;
  const re = /-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.md$/;
  for (const f of readdirSync(dir)) {
    const m = f.match(re);
    if (!m) continue;
    const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
    const ts = Date.parse(iso);
    if (Number.isNaN(ts) || ts < cutoff) continue;
    try {
      const head = readFileSync(path.join(dir, f), "utf-8").slice(0, 200);
      const nameMatch = head.match(/^#\s+Scratchpad:\s+agent-([A-Za-z][A-Za-z0-9_-]*)/m);
      if (!nameMatch) continue;
      const bare = nameMatch[1].toLowerCase();
      const prior = out.get(bare);
      if (!prior || prior.last_seen < iso) {
        out.set(bare, { state: "stale", last_seen: iso });
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Durable per-name session metadata that outlives the heartbeat. */
export interface SessionMeta {
  platform: string | null;
  /** The model the agent last used (from its newest session's turn.stops). */
  model: string | null;
}

/**
 * name → {platform, model} fallback from durable `session.start` identities
 * (newest session wins per bare name, as a unit, never mixing fields across
 * sessions). Heartbeats carry both while live, but they die with the heartbeat;
 * scratch-archive stale entries have neither, so "which harness/model was
 * Celeste on?" goes unanswered exactly when the operator needs it (routing a
 * prompt to a not-currently-running agent). Exported pure for tests.
 */
export function sessionMetaByName(
  identities?: Record<string, InstanceIdentity>,
): Map<string, SessionMeta> {
  const newest = new Map<string, { ts: string; meta: SessionMeta }>();
  if (!identities) return new Map();
  for (const id of Object.values(identities)) {
    if (id.kind !== "session" || (!id.platform && !id.model)) continue;
    const bare = (
      id.name.startsWith("agent-") ? id.name.slice("agent-".length) : id.name
    ).toLowerCase();
    const ts = id.last_ts ?? id.started_at ?? "";
    const prior = newest.get(bare);
    if (!prior || prior.ts < ts) {
      newest.set(bare, {
        ts,
        meta: { platform: id.platform ?? null, model: id.model ?? null },
      });
    }
  }
  return new Map(Array.from(newest, ([k, v]) => [k, v.meta] as const));
}

export function buildAgentSummaryMap(
  names: Iterable<string>,
  identities?: Record<string, InstanceIdentity>,
): Record<string, AgentSummary> {
  const { byName: active, idToName } = readActiveIndex();
  const stale = readScratchIndex();
  const metaFallback = sessionMetaByName(identities);
  const out: Record<string, AgentSummary> = {};
  for (const raw of names) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const bare = (
      trimmed.startsWith("agent-") ? trimmed.slice("agent-".length) : trimmed
    ).toLowerCase();
    if (out[bare]) continue;
    const identity = lookupByName(trimmed);
    const activity = active.get(bare) ?? stale.get(bare);
    // Render a card from live/recent activity even when the durable identity
    // registry has no entry: it lags (newly-minted personas may not be written
    // yet), and without this fallback an active agent shows as plain text with
    // no hover card at all. When there is NEITHER an identity nor any activity,
    // emit no entry at all (not an "unknown" sentinel): AgentChip treats a
    // missing entry and a `state: "unknown"` entry identically (both → plain
    // text), so the sentinel carries no information; its only effect was to
    // CLOBBER a richer lower-priority card in a layered merge. The /images feed
    // spreads this map LAST (highest priority) over `buildObservedAgentSummaries`;
    // an agent that's in the feed but has no live heartbeat / recent scratch /
    // identity (e.g. un-healed agent-Zoe, scratch since pruned) would otherwise
    // lose its synthesized observed card to this sentinel. Skipping lets the
    // observed/ended/subagent layers survive while still letting real
    // identity/activity data here win when present.
    if (!identity && !activity) continue;
    const displayBare = identity
      ? identity.name
      : trimmed.startsWith("agent-")
        ? trimmed.slice("agent-".length)
        : trimmed;
    // A running subagent's live entry wins the page-level summary merge over
    // the buildSubagentSummaries entry (the layering spreads this map last),
    // so it must carry the parent linkage itself; otherwise a LIVE subagent
    // renders "parent exited" for its entire runtime and only resolves to
    // "of agent-X" at exit, when its heartbeat is deleted and the identity-
    // derived entry stops being clobbered (the observed minutes-long lag).
    const linkage = activity ? resolveSubagentLinkage(activity, idToName, identities) : null;
    out[bare] = {
      name: displayBare,
      agent_id: identity?.agent_id ?? "",
      state: activity?.state ?? "stale",
      last_seen: activity?.last_seen ?? null,
      created_at: identity?.created_at ?? "",
      aliases: identity?.aliases ?? [],
      instance_id: activity?.instance_id,
      session_id: activity?.session_id,
      kind: activity?.kind,
      platform: activity?.platform ?? metaFallback.get(bare)?.platform ?? null,
      model: activity?.model ?? metaFallback.get(bare)?.model ?? null,
      started_at: activity?.started_at,
      task: activity?.task,
      last_tool: activity?.last_tool,
      last_tool_target: activity?.last_tool_target,
      files_touched: activity?.files_touched,
      turn_summary: activity?.turn_summary,
      ...(linkage ?? {}),
    };
  }
  return out;
}

/**
 * active main agents: instance_id → display name, for subagent-parent
 * resolution. A subagent runs under its dispatcher's session id, so matching a
 * subagent's `session_id` to a live heartbeat's `instance_id` names its parent.
 */
function activeInstanceNames(): Map<string, string> {
  const idToName = new Map<string, string>();
  const activeDir = path.join(coordRoot(), ".harnery", "active");
  if (!existsSync(activeDir)) return idToName;
  for (const f of readdirSync(activeDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const hb = JSON.parse(readFileSync(path.join(activeDir, f), "utf-8")) as {
        instance_id?: string;
        name?: string;
      };
      if (hb.instance_id && hb.name) idToName.set(hb.instance_id, hb.name);
    } catch {
      /* skip */
    }
  }
  return idToName;
}

/**
 * Build AgentSummary entries for subagents (Agent-tool dispatches: Explore,
 * etc.), keyed by bare name, so their names render as hover-card chips like
 * main agents. Subagents don't write heartbeats; identity + parent come from
 * the `subagent.start` records in the shared `identities` map (see
 * `readInstanceIdentities`). The parent is resolved by matching the start
 * event's `session_id` to an active main agent's `instance_id`, null when that
 * parent has since exited. Most-recent start wins on a repeated name
 * (identities iterate in chronological log order).
 */
export function buildSubagentSummaries(
  identities: Record<string, InstanceIdentity>,
): Record<string, AgentSummary> {
  const out: Record<string, AgentSummary> = {};
  const idToName = activeInstanceNames();
  for (const id of Object.values(identities)) {
    if (id.kind !== "subagent") continue;
    const parent = id.session_id ? (idToName.get(id.session_id) ?? null) : null;
    out[id.name.toLowerCase()] = {
      name: id.name,
      agent_id: "",
      // "active" while the dispatching parent is still live; else historical.
      state: parent ? "active" : "stale",
      last_seen: id.last_ts ?? null,
      created_at: "",
      aliases: [],
      instance_id: id.instance_id,
      kind: "subagent",
      agent_type: id.agent_type ?? null,
      parent,
    };
  }
  return out;
}

/**
 * Build AgentSummary entries for main agents whose session has ended, from the
 * durable `session.start` records (`kind === "session"`) in the shared
 * `identities` map. Keyed by bare name so AgentChip resolves them like live
 * agents; most-recent session wins per name.
 *
 * These are the lowest-priority summary source: the live/scratch map from
 * `buildAgentSummaryMap` overrides any agent that is still around, so this only
 * fills in agents that have since exited. State is "stale", carrying the durable
 * identity (name, platform, when the session started) without the live-only
 * fields (task, files, model) that vanish with the heartbeat.
 *
 * `instance_id` IS included: the standalone `/agents/[id]` page now resolves
 * ended agents from the durable log via `readEndedAgent` (read-only view), so
 * the hover card's "Open" button links there instead of dead-ending at a 404.
 * The live-only mutation actions (heal / pidmap / kill) stay disabled for a
 * non-active card; AgentChip gates them on `state === "active"`, not merely on
 * the presence of an instance_id.
 */
export function buildEndedAgentSummaries(
  identities: Record<string, InstanceIdentity>,
): Record<string, AgentSummary> {
  const out: Record<string, AgentSummary> = {};
  const newestTs = new Map<string, string>();
  for (const id of Object.values(identities)) {
    if (id.kind !== "session") continue;
    const bare = (
      id.name.startsWith("agent-") ? id.name.slice("agent-".length) : id.name
    ).toLowerCase();
    const ts = id.last_ts ?? id.started_at ?? "";
    const prior = newestTs.get(bare);
    if (prior !== undefined && prior >= ts) continue;
    newestTs.set(bare, ts);
    out[bare] = {
      name: id.name.startsWith("agent-") ? id.name.slice("agent-".length) : id.name,
      agent_id: "",
      state: "stale",
      last_seen: id.last_ts ?? null,
      created_at: "",
      aliases: [],
      instance_id: id.instance_id,
      kind: "session",
      platform: id.platform ?? null,
      model: id.model ?? null,
      started_at: id.started_at ?? undefined,
    };
  }
  return out;
}

/**
 * Last-resort hover-card summaries for agents that appear in some feed but have
 * neither a live heartbeat nor a `session.start`/`subagent.start` identity in
 * the log, e.g. an agent whose hooks dropped a beat so its `session.start`
 * never landed and its heartbeat has since been pruned. We still KNOW the agent
 * exists (it left the rows we're rendering), so synthesize a minimal "stale"
 * card from whatever the row carries: a resolved display name, the most-recent
 * activity timestamp, and (optionally) instance_id + platform.
 *
 * Layer this LOWEST priority: `buildAgentSummaryMap` (live/scratch) and the
 * identity-derived builders override it whenever richer data exists. The point
 * is only to guarantee that a name we're already displaying never falls all the
 * way back to plain text with no card.
 *
 * Input is a list of `{ name, last_seen, instance_id?, platform? }` observations
 * (one or more per agent); newest `last_seen` wins per bare name.
 */
export function buildObservedAgentSummaries(
  observed: Iterable<{
    name: string;
    last_seen: string;
    instance_id?: string;
    platform?: string | null;
  }>,
): Record<string, AgentSummary> {
  const out: Record<string, AgentSummary> = {};
  for (const o of observed) {
    if (!o.name) continue;
    const bare = (
      o.name.startsWith("agent-") ? o.name.slice("agent-".length) : o.name
    ).toLowerCase();
    if (!bare) continue;
    const prior = out[bare];
    if (prior && (prior.last_seen ?? "") >= (o.last_seen ?? "")) continue;
    out[bare] = {
      name: o.name.startsWith("agent-") ? o.name.slice("agent-".length) : o.name,
      agent_id: "",
      state: "stale",
      last_seen: o.last_seen || null,
      created_at: "",
      aliases: [],
      instance_id: o.instance_id,
      platform: o.platform ?? null,
    };
  }
  return out;
}

export interface KnownAgent {
  name: string;
  state: "active" | "stale";
  last_seen: string;
}

const KNOWN_AGENT_STALE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Union of currently-active heartbeats + recently-archived scratchpads,
 * deduped by name. Used by the steward picker.
 */
export function listKnownAgents(): KnownAgent[] {
  const root = coordRoot();
  const activeDir = path.join(root, ".harnery", "active");
  const archiveDir = path.join(root, ".harnery", "scratch", "archived");
  const byName = new Map<string, KnownAgent>();

  if (existsSync(activeDir)) {
    for (const f of readdirSync(activeDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const hb = JSON.parse(readFileSync(path.join(activeDir, f), "utf-8")) as {
          name?: string;
          last_heartbeat?: string;
        };
        if (!hb.name) continue;
        const name = hb.name.startsWith("agent-") ? hb.name : `agent-${hb.name}`;
        const last_seen = hb.last_heartbeat ?? new Date().toISOString();
        const existing = byName.get(name);
        if (!existing || existing.state !== "active") {
          byName.set(name, { name, state: "active", last_seen });
        }
      } catch {
        /* skip */
      }
    }
  }

  const cutoff = Date.now() - KNOWN_AGENT_STALE_WINDOW_MS;
  if (existsSync(archiveDir)) {
    const re = /-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.md$/;
    for (const f of readdirSync(archiveDir)) {
      const m = f.match(re);
      if (!m) continue;
      const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
      const ts = Date.parse(iso);
      if (Number.isNaN(ts) || ts < cutoff) continue;
      try {
        const head = readFileSync(path.join(archiveDir, f), "utf-8").slice(0, 200);
        const nameMatch = head.match(/^#\s+Scratchpad:\s+(agent-[A-Za-z][A-Za-z0-9_-]*)/m);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        const existing = byName.get(name);
        if (existing) {
          if (existing.state === "stale" && iso > existing.last_seen) {
            existing.last_seen = iso;
          }
        } else {
          byName.set(name, { name, state: "stale", last_seen: iso });
        }
      } catch {
        /* skip */
      }
    }
  }

  return Array.from(byName.values()).sort((a, b) => {
    if (a.state !== b.state) return a.state === "active" ? -1 : 1;
    return b.last_seen.localeCompare(a.last_seen);
  });
}
