/**
 * Agent persona identity registry: read-side mirror.
 *
 * Identities live at `.harnery/identities/<agent_id>.json` and provide the
 * UUID → display name + alias history mapping. Used by AgentChip + the
 * agent-summary builder so every name surfaced in the UI carries durable
 * persona metadata.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { coordRoot } from "./coord-reader";

export interface AgentIdentity {
  schema_version: 1;
  agent_id: string;
  name: string;
  aliases: Array<{ name: string; retired_at: string }>;
  created_at: string;
}

function identitiesDir(): string {
  return path.join(coordRoot(), ".harnery", "identities");
}

function readIdentityFile(fp: string): AgentIdentity | null {
  try {
    const parsed = JSON.parse(readFileSync(fp, "utf-8")) as AgentIdentity;
    if (parsed.schema_version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function bareName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("agent-") ? trimmed.slice("agent-".length) : trimmed;
}

export function displayName(name: string): string {
  return name.startsWith("agent-") ? name : `agent-${name}`;
}

export function lookupById(agentId: string): AgentIdentity | null {
  if (!agentId) return null;
  const fp = path.join(identitiesDir(), `${agentId}.json`);
  if (!existsSync(fp)) return null;
  return readIdentityFile(fp);
}

export function lookupByName(name: string): AgentIdentity | null {
  const dir = identitiesDir();
  if (!existsSync(dir)) return null;
  const wanted = bareName(name).toLowerCase();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const id = readIdentityFile(path.join(dir, f));
    if (!id) continue;
    if (id.name.toLowerCase() === wanted) return id;
    for (const alias of id.aliases) {
      if (alias.name.toLowerCase() === wanted) return id;
    }
  }
  return null;
}

export function listIdentities(): AgentIdentity[] {
  const dir = identitiesDir();
  if (!existsSync(dir)) return [];
  const out: AgentIdentity[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const id = readIdentityFile(path.join(dir, f));
    if (id) out.push(id);
  }
  out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return out;
}
