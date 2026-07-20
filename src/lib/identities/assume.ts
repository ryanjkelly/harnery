/**
 * Bind a live session to a durable agent persona.
 *
 * The operation is serialized because "is this name live?" and "claim it"
 * must be one critical section. Authoritative state is written twice on
 * purpose: `.name-history` heals a missing heartbeat, while the canonical
 * `identity.assumed` event makes replay and derived readers converge.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { emitAndProject } from "../../core/agents/cli-emit.ts";
import { type Heartbeat, readHeartbeat } from "../../core/agents/state/heartbeat-writer.ts";
import { recordNameAssumption } from "../../core/agents/state/names.ts";
import { coordFreshnessSeconds } from "../../core/config.ts";
import { readRemoteMachines } from "../../core/presence/index.ts";
import { type AgentIdentity, bareName, ensureIdentity, lookupById, lookupByName } from "./index.ts";

const ASSUME_LOCK = "identity-assume.lock";
const ASSUME_LOCK_STALE_MS = 30_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IdentityAssumeErrorCode =
  | "identity_busy"
  | "identity_in_use"
  | "identity_not_found"
  | "invalid_identity"
  | "no_heartbeat"
  | "not_session"
  | "projection_failed";

export class IdentityAssumeError extends Error {
  constructor(
    public readonly code: IdentityAssumeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IdentityAssumeError";
  }
}

export interface IdentityConflict {
  instance_id: string;
  name: string;
  scope: "local" | "remote";
  machine?: string;
}

export interface IdentityAssumeResult {
  changed: boolean;
  instance_id: string;
  session_id: string;
  previous_name: string | null;
  previous_agent_id: string | null;
  name: string;
  agent_id: string;
  identity_created: boolean;
  event_id: string | null;
}

function heartbeatIsFresh(hb: Heartbeat, cutoffMs: number): boolean {
  const ts = Date.parse(hb.last_heartbeat);
  return Number.isFinite(ts) && ts >= cutoffMs;
}

/** Best-effort collision read across local heartbeats and cached remote
 * presence. No network call occurs; absent presence degrades to local-only. */
export function findIdentityConflict(
  coordRoot: string,
  instanceId: string,
  name: string,
  nowMs = Date.now(),
): IdentityConflict | null {
  const wanted = name.toLowerCase();
  const cutoffMs = nowMs - coordFreshnessSeconds(coordRoot) * 1000;
  const activeDir = join(coordRoot, ".harnery", "active");
  if (existsSync(activeDir)) {
    for (const file of readdirSync(activeDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const hb = JSON.parse(readFileSync(join(activeDir, file), "utf8")) as Heartbeat;
        if (hb.instance_id === instanceId || !heartbeatIsFresh(hb, cutoffMs)) continue;
        if ((hb.name ?? "").toLowerCase() === wanted) {
          return { instance_id: hb.instance_id, name: hb.name ?? name, scope: "local" };
        }
      } catch {
        // Malformed heartbeats are handled by stale sweep, not this command.
      }
    }
  }

  for (const remote of readRemoteMachines(coordRoot)) {
    for (const agent of remote.agents) {
      if (agent.instance_id === instanceId) continue;
      if ((agent.name ?? "").toLowerCase() === wanted) {
        return {
          instance_id: agent.instance_id,
          name: agent.name ?? name,
          scope: "remote",
          machine: remote.machine,
        };
      }
    }
  }
  return null;
}

function resolveTarget(
  coordRoot: string,
  input: string,
): {
  identity: AgentIdentity | null;
  name: string;
} {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new IdentityAssumeError("invalid_identity", "identity name cannot be empty");
  }
  if (UUID_RE.test(trimmed)) {
    const identity = lookupById(trimmed, coordRoot);
    if (!identity) {
      throw new IdentityAssumeError(
        "identity_not_found",
        `no durable identity matching '${trimmed}'`,
      );
    }
    return { identity, name: identity.name };
  }

  const name = bareName(trimmed);
  if (!name) {
    throw new IdentityAssumeError("invalid_identity", "identity name cannot be empty");
  }
  const existing = lookupByName(name, coordRoot);
  return { identity: existing, name: existing?.name ?? name };
}

function acquireLock(coordRoot: string): () => void {
  const dir = join(coordRoot, ".harnery");
  const path = join(dir, ASSUME_LOCK);
  mkdirSync(dir, { recursive: true });
  const token = `${process.pid}:${randomUUID()}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, token, { encoding: "utf8", flag: "wx" });
      return () => {
        try {
          if (readFileSync(path, "utf8") === token) unlinkSync(path);
        } catch {
          // The critical section completed; a missing lock needs no recovery.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > ASSUME_LOCK_STALE_MS) {
          unlinkSync(path);
          continue;
        }
      } catch {
        continue;
      }
      break;
    }
  }
  throw new IdentityAssumeError(
    "identity_busy",
    "another identity assumption is in progress; retry in a moment",
  );
}

function harnessOf(platform: string | undefined): "claude-code" | "cursor" | "codex" {
  if (platform === "cursor") return "cursor";
  if (platform === "codex") return "codex";
  return "claude-code";
}

/** Assume `target` for one live main session. Safe to retry. */
export function assumeIdentity(
  coordRoot: string,
  instanceId: string,
  target: string,
): IdentityAssumeResult {
  const release = acquireLock(coordRoot);
  try {
    const hb = readHeartbeat(coordRoot, instanceId);
    if (!hb) {
      throw new IdentityAssumeError(
        "no_heartbeat",
        `no live heartbeat for instance '${instanceId}'`,
      );
    }
    if (hb.kind && hb.kind !== "session") {
      throw new IdentityAssumeError(
        "not_session",
        `identity assumption is limited to main sessions (current kind: ${hb.kind})`,
      );
    }

    const targetIdentity = resolveTarget(coordRoot, target);
    const conflict = findIdentityConflict(coordRoot, instanceId, targetIdentity.name);
    if (conflict) {
      const where = conflict.scope === "remote" ? ` on ${conflict.machine}` : "";
      throw new IdentityAssumeError(
        "identity_in_use",
        `agent-${targetIdentity.name} is already live${where} (${conflict.instance_id}); end or stale-sweep that session before assuming the identity`,
      );
    }
    const identity = targetIdentity.identity ?? ensureIdentity(targetIdentity.name, coordRoot);
    const created = !targetIdentity.identity;

    const previousName = hb.name || null;
    const previousAgentId = hb.agent_id || null;
    const history = recordNameAssumption(
      coordRoot,
      instanceId,
      identity.name,
      identity.agent_id,
      "session",
    );
    const changed =
      history.changed || previousName !== identity.name || previousAgentId !== identity.agent_id;
    if (!changed) {
      return {
        changed: false,
        instance_id: instanceId,
        session_id: hb.session_id,
        previous_name: previousName,
        previous_agent_id: previousAgentId,
        name: identity.name,
        agent_id: identity.agent_id,
        identity_created: false,
        event_id: null,
      };
    }

    const emitted = emitAndProject(
      {
        event_type: "identity.assumed",
        instance_id: instanceId,
        session_id: hb.session_id,
        harness: harnessOf(hb.platform),
        data: {
          name: identity.name,
          agent_id: identity.agent_id,
          ...(previousName ? { previous_name: previousName } : {}),
          ...(previousAgentId ? { previous_agent_id: previousAgentId } : {}),
        },
      },
      { coordRoot },
    );
    if (!emitted?.projected) {
      throw new IdentityAssumeError(
        "projection_failed",
        "the durable name binding was recorded but event projection failed; rerun the command to heal it",
      );
    }

    const projected = readHeartbeat(coordRoot, instanceId);
    if (projected?.name !== identity.name || projected.agent_id !== identity.agent_id) {
      throw new IdentityAssumeError(
        "projection_failed",
        "identity.assumed was emitted but the heartbeat did not converge; rerun the command",
      );
    }
    return {
      changed: true,
      instance_id: instanceId,
      session_id: hb.session_id,
      previous_name: previousName,
      previous_agent_id: previousAgentId,
      name: identity.name,
      agent_id: identity.agent_id,
      identity_created: created,
      event_id: emitted.envelope.event_id,
    };
  } finally {
    release();
  }
}
