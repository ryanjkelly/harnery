/**
 * Agent persona identity registry: per-agent durable UUIDs.
 *
 * The coord layer has two id concepts that get confused:
 *   - `instance_id`: Claude Code session UUID (fresh per session). Lives at
 *     `.harnery/active/<instance_id>.json` as the heartbeat filename.
 *   - `agent_id` (this module): durable per-AGENT-PERSONA UUID. Stable
 *     across sessions; same UUID for every Maya session, regardless of
 *     how many times she restarts Claude Code.
 *
 * Storage: `.harnery/identities/<agent_id>.json`, one file per persona.
 * The filename IS the id so reverse lookup is O(1) by id; forward lookup
 * by name is a scan (small directory, ~100 personas tops in practice).
 *
 * Used as the canonical identifier in:
 *   - Council manifests (`created_by_id`, `steward_id`, `member_ids[]`)
 *   - Council body filenames (`<agent_id>.md` not `<name>.md`)
 *   - Session events ndjson (new `agent_id` field alongside `agent_name`)
 *   - Heartbeats (new `agent_id` field; existing CC subagent-call id
 *     renamed to `subagent_call_id`)
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { monorepoRoot } from "../../core/agents/index.ts";

export const IDENTITY_SCHEMA_VERSION = 1 as const;

export interface AgentIdentity {
  schema_version: 1;
  /** Persistent persona UUID. v4. */
  agent_id: string;
  /** Current display name (e.g. "Maya", without the "agent-" prefix). */
  name: string;
  /** Prior names this identity has been known by. Updated by renameIdentity(). */
  aliases: Array<{ name: string; retired_at: string }>;
  /** UTC ISO-8601 timestamp of first mint. */
  created_at: string;
}

function identitiesDir(): string | null {
  const root = monorepoRoot();
  if (!root) return null;
  return resolve(root, ".harnery", "identities");
}

function ensureDir(): string {
  const dir = identitiesDir();
  if (!dir) throw new Error("not in an agent session; no monorepo root");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function identityPath(agentId: string): string {
  return resolve(ensureDir(), `${agentId}.json`);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function readIdentityFile(path: string): AgentIdentity | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AgentIdentity;
    if (parsed.schema_version !== IDENTITY_SCHEMA_VERSION) {
      throw new Error(
        `identity ${path}: unsupported schema_version=${parsed.schema_version} (expected ${IDENTITY_SCHEMA_VERSION})`,
      );
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Strip an "agent-" prefix if present. The registry stores bare names. */
export function bareName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("agent-") ? trimmed.slice("agent-".length) : trimmed;
}

/** Re-add the "agent-" prefix for display contexts. */
export function displayName(name: string): string {
  return name.startsWith("agent-") ? name : `agent-${name}`;
}

/** Read one identity by id. Null if missing. */
export function lookupById(agentId: string): AgentIdentity | null {
  const dir = identitiesDir();
  if (!dir) return null;
  const fp = resolve(dir, `${agentId}.json`);
  if (!existsSync(fp)) return null;
  return readIdentityFile(fp);
}

/** Read one identity by display name (case-insensitive on bare name).
 * Scans the directory; O(N) on identity count. */
export function lookupByName(name: string): AgentIdentity | null {
  const dir = identitiesDir();
  if (!dir || !existsSync(dir)) return null;
  const wanted = bareName(name).toLowerCase();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const id = readIdentityFile(resolve(dir, f));
    if (!id) continue;
    if (id.name.toLowerCase() === wanted) return id;
    for (const alias of id.aliases) {
      if (alias.name.toLowerCase() === wanted) return id;
    }
  }
  return null;
}

/** All known identities, sorted by created_at ascending. */
export function listIdentities(): AgentIdentity[] {
  const dir = identitiesDir();
  if (!dir || !existsSync(dir)) return [];
  const out: AgentIdentity[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const id = readIdentityFile(resolve(dir, f));
    if (id) out.push(id);
  }
  out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return out;
}

/**
 * Find an identity by name, or mint one. Returns the resolved identity.
 * Idempotent: calling twice with the same name returns the same record.
 *
 * Mint path: generates a fresh uuid v4, writes the file atomically (tmp +
 * rename), returns the new identity. Race-safe: if two processes mint
 * simultaneously, both files land (different ids), but lookupByName will
 * surface whichever happened to be read first; the second is orphaned.
 * For agent personas (added at human cadence) this race is theoretical.
 */
export function ensureIdentity(name: string): AgentIdentity {
  const existing = lookupByName(name);
  if (existing) return existing;
  const id: AgentIdentity = {
    schema_version: IDENTITY_SCHEMA_VERSION,
    agent_id: randomUUID(),
    name: bareName(name),
    aliases: [],
    created_at: nowIso(),
  };
  writeIdentity(id);
  return id;
}

/** Persist an identity (tmp + rename). Creates the dir if missing. */
export function writeIdentity(id: AgentIdentity): void {
  ensureDir();
  const fp = identityPath(id.agent_id);
  const tmp = `${fp}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(id, null, 2)}\n`, "utf8");
  renameSync(tmp, fp);
}

/**
 * Rename an existing identity. The prior name lands in aliases[] so name
 * lookup still resolves correctly. The agent_id is stable across renames,
 * which is the whole point of the registry.
 */
export function renameIdentity(agentId: string, newName: string): AgentIdentity {
  const existing = lookupById(agentId);
  if (!existing) {
    throw new Error(`renameIdentity: no identity matching '${agentId}'`);
  }
  const bare = bareName(newName);
  if (existing.name === bare) return existing;
  const next: AgentIdentity = {
    ...existing,
    name: bare,
    aliases: [...existing.aliases, { name: existing.name, retired_at: nowIso() }],
  };
  writeIdentity(next);
  return next;
}

/**
 * Resolve a string to an agent_id. Accepts:
 *   - A UUID (already an id), verified to exist in registry
 *   - A display name (e.g. "agent-Maya" or "Maya"), resolved via lookupByName
 * Returns null when the input is neither a known id nor a known name.
 *
 * Does NOT mint. Callers that want mint-on-miss should call ensureIdentity()
 * with a name, then use the returned agent_id.
 */
export function resolveAgentId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // UUID shape check, relaxed; we only need the lookupById to confirm.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    const byId = lookupById(trimmed);
    if (byId) return byId.agent_id;
  }
  const byName = lookupByName(trimmed);
  return byName ? byName.agent_id : null;
}
