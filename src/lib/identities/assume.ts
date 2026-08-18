/**
 * Bind a live session to a durable agent persona.
 *
 * The operation is serialized because "is this name live?" and "claim it"
 * must be one critical section. Authoritative state is written twice on
 * purpose: `.name-history` heals a missing heartbeat, while the canonical
 * `identity.assumed` event makes replay and derived readers converge.
 *
 * Local collision policy: a fresh heartbeat alone is not enough to block.
 * If the namesake has no live pid-map process (crashed session, healed
 * zombie, or abandoned adapter), reclaim that heartbeat and continue.
 * Refuse only when another process is still alive, or when cached remote
 * presence reports the name.
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

import { recordLiveIdentityChangeV2 } from "../../core/agents/live-authority-v2.ts";
import { recordLiveSweepObservationV2 } from "../../core/agents/live-lifecycle-v2.ts";
import { type Heartbeat, readHeartbeat } from "../../core/agents/state/heartbeat-writer.ts";
import { resolveForkAncestry } from "../../core/agents/state/names.ts";
import { instanceHasLivePid, removePidmapRowsForInstance } from "../../core/agents/state/pidmap.ts";
import { coordFreshnessSeconds } from "../../core/config.ts";
import { readRemoteMachines } from "../../core/presence/index.ts";
import { type AgentIdentity, bareName, ensureIdentity, lookupById, lookupByName } from "./index.ts";

const ASSUME_LOCK = "identity-assume.lock";
const ASSUME_LOCK_STALE_MS = 30_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IdentityAssumeErrorCode =
  | "identity_busy"
  | "identity_in_use"
  | "identity_is_ancestor"
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
  /** Prior local holder swept because it had no live process. */
  reclaimed_instance_id: string | null;
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

/**
 * Drop a local namesake whose adapter process is gone. Fresh heartbeats can
 * linger after a crash (or after heartbeat heal without a live pid-map), and
 * `identity assume` is the supported takeover path — operators should not
 * need a separate kill/sweep step.
 */
export function reclaimAbandonedLocalConflict(
  coordRoot: string,
  conflict: IdentityConflict,
): boolean {
  if (conflict.scope !== "local") return false;
  if (instanceHasLivePid(coordRoot, conflict.instance_id)) return false;

  const hbPath = join(coordRoot, ".harnery", "active", `${conflict.instance_id}.json`);
  let adapter: "claude-code" | "cursor" | "codex" = "claude-code";
  let sessionId = conflict.instance_id;
  let ageSecs: number | undefined;
  if (existsSync(hbPath)) {
    try {
      const hb = JSON.parse(readFileSync(hbPath, "utf8")) as Heartbeat;
      adapter = adapterOf(hb.platform);
      sessionId = hb.session_id || conflict.instance_id;
      const ts = Date.parse(hb.last_heartbeat);
      if (Number.isFinite(ts)) ageSecs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    } catch {
      /* content unreadable — still reclaim the file */
    }
    try {
      unlinkSync(hbPath);
    } catch {
      return false;
    }
  }
  removePidmapRowsForInstance(coordRoot, conflict.instance_id);
  recordLiveSweepObservationV2({
    coordRoot,
    owner: conflict.instance_id,
    nativeSessionId: sessionId,
    adapter,
    observation: "stale_heartbeat",
    ageMs: Math.max(0, (ageSecs ?? 0) * 1_000),
  });
  return true;
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

function adapterOf(platform: string | undefined): "claude-code" | "cursor" | "codex" {
  if (platform === "cursor") return "cursor";
  if (platform === "codex") return "codex";
  return "claude-code";
}

/** Assume `target` for one live main session. Safe to retry. */
export function assumeIdentity(
  coordRoot: string,
  instanceId: string,
  target: string,
  opts?: { forceAncestor?: boolean },
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

    // Recorded-fork-lineage guard: a branched session inherits a transcript
    // full of its ancestor's name, so "assume <ancestor>" is far more likely
    // a confused fork trusting its scrollback than a legitimate role handoff.
    // The liveness check below cannot catch this once the ancestor exits;
    // lineage can. --force-ancestor is the deliberate-successor escape hatch.
    if (!opts?.forceAncestor) {
      const ancestor = resolveForkAncestry(coordRoot, instanceId).find(
        (a) => (a.name ?? "").toLowerCase() === targetIdentity.name.toLowerCase(),
      );
      if (ancestor) {
        throw new IdentityAssumeError(
          "identity_is_ancestor",
          `agent-${targetIdentity.name} is this session's fork ancestor (${ancestor.instance_id}): ` +
            `this conversation was branched from that session, so its name in your context is ` +
            `inherited history, not your role. If you are deliberately succeeding it, rerun with --force-ancestor.`,
        );
      }
    }
    let reclaimedInstanceId: string | null = null;
    let conflict = findIdentityConflict(coordRoot, instanceId, targetIdentity.name);
    if (conflict && reclaimAbandonedLocalConflict(coordRoot, conflict)) {
      reclaimedInstanceId = conflict.instance_id;
      conflict = findIdentityConflict(coordRoot, instanceId, targetIdentity.name);
    }
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
    const changed = previousName !== identity.name || previousAgentId !== identity.agent_id;
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
        reclaimed_instance_id: reclaimedInstanceId,
      };
    }

    const emitted = recordLiveIdentityChangeV2({
      coordRoot,
      owner: instanceId,
      nativeSessionId: hb.session_id,
      adapter: adapterOf(hb.platform),
      name: identity.name,
      identityId: identity.agent_id,
    });

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
      event_id:
        emitted.state === "recorded" && emitted.result.state === "recorded"
          ? emitted.result.event.event_id
          : null,
      reclaimed_instance_id: reclaimedInstanceId,
    };
  } finally {
    release();
  }
}
