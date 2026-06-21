import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { coordEnv } from "../../../lib/env.ts";

/**
 * Resolve the canonical `instance_id` for the current hook invocation.
 *
 * Precedence:
 *
 *   1. `HARNERY_AGENT_COORD_OWNER` env var. Set by harness adapters when they know
 *      the owner identity at spawn time (Codex's apply_patch tool path uses
 *      this).
 *   2. Hook payload fields, in order: `agent_id` → `subagent_id` →
 *      `session_id` → `conversation_id`. agent_id wins for CC subagent
 *      events; session_id is the parent-shape default.
 *   3. PID-map lookup at `.harnery/pid-map/<pid>` for our own pid, then ppid
 *      chain (up to 20 hops).
 *
 * Returns null when nothing resolves. Callers must treat null as "no owner"
 * and skip the event (Phase 2 fail-safe; Phase 3 will mint a temporary owner
 * for orphan events).
 */
export function resolveOwner(opts: {
  payload: Record<string, unknown> | null;
  coordRoot: string;
}): { instance_id: string; source: "env" | "payload" | "pidmap-self" | "pidmap-ancestor" } | null {
  const env = coordEnv("AGENT_COORD_OWNER");
  if (env && env.length > 0) {
    return { instance_id: env, source: "env" };
  }

  if (opts.payload) {
    for (const key of ["agent_id", "subagent_id", "session_id", "conversation_id"] as const) {
      const v = opts.payload[key];
      if (typeof v === "string" && v.length > 0) {
        return { instance_id: v, source: "payload" };
      }
    }
  }

  // Pid-map ancestor walk. Start at own pid (the bash wrapper's bun child),
  // walk up through ppids. The pid-map is stamped keyed by the harness PID, so
  // we'll usually find it 1-3 hops up.
  const pidmap = join(opts.coordRoot, ".harnery", "pid-map");
  if (existsSync(pidmap)) {
    let pid = process.pid;
    let hops = 0;
    while (hops < 20) {
      const file = join(pidmap, String(pid));
      if (existsSync(file)) {
        try {
          const row = readFileSync(file, "utf8").trim();
          // Row shape: "<instance_id>" or "<instance_id>\t<platform>"
          const owner = row.split("\t")[0];
          if (owner && owner.length > 0) {
            return {
              instance_id: owner,
              source: hops === 0 ? "pidmap-self" : "pidmap-ancestor",
            };
          }
        } catch {
          /* keep walking */
        }
      }
      const ppid = readPpid(pid);
      if (!ppid || ppid === 0 || ppid === 1) break;
      pid = ppid;
      hops++;
    }
  }

  return null;
}

function readPpid(pid: number): number | null {
  // Linux/WSL: /proc/<pid>/status carries `PPid:`. Falls back to null on
  // macOS or any read failure; ancestor walk just terminates.
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    for (const line of status.split("\n")) {
      if (line.startsWith("PPid:")) {
        const n = Number(line.split(/\s+/)[1]);
        return Number.isFinite(n) ? n : null;
      }
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/**
 * Find the parent owner for a subagent invocation. The per-shell marker at
 * `.harnery/shells/<pid>` is set by `sub-agent-start` and removed by
 * `sub-agent-stop`.
 *
 * Phase 2 stub: the marker file isn't written yet, so we return null in most
 * cases. Phase 2 callers can pass through.
 */
export function readShellMarker(coordRoot: string, pid: number): string | null {
  const path = join(coordRoot, ".harnery", "shells", String(pid));
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Read the heartbeat-recorded `agent_id` for an owner if it exists. */
export function readAgentIdForOwner(coordRoot: string, instanceId: string): string | null {
  const path = join(coordRoot, ".harnery", "active", `${instanceId}.json`);
  if (!existsSync(path)) return null;
  try {
    const body = readFileSync(path, "utf8");
    const data = JSON.parse(body) as { agent_id?: string };
    return data.agent_id ?? null;
  } catch {
    return null;
  }
}

/** Diagnostic: list of pid-map entries (for debugging). */
export function listPidmap(coordRoot: string): Array<{ pid: number; owner: string }> {
  const dir = join(coordRoot, ".harnery", "pid-map");
  if (!existsSync(dir)) return [];
  const out: Array<{ pid: number; owner: string }> = [];
  for (const f of readdirSync(dir)) {
    const pid = Number(f);
    if (!Number.isFinite(pid)) continue;
    try {
      const row = readFileSync(join(dir, f), "utf8").trim();
      const owner = row.split("\t")[0];
      if (owner) out.push({ pid, owner });
    } catch {
      /* skip */
    }
  }
  return out;
}
