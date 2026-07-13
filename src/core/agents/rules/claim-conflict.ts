/**
 * File-claim verdict.
 *
 * Phase 5 cutover: PreToolUse routes Edit/Write/NotebookEdit through here.
 *
 * Two checks:
 *   1. Conflict: is the path already claimed by a fresh peer? Block with
 *      the peer's name in the reason.
 *   2. Ordering: if we already hold a claim on path A and want path
 *      B, B must sort > A lexicographically. Otherwise emit
 *      claim.conflict (ordering_violation) and block.
 *
 * Reads from `.harnery/active/<id>.json`, the single canonical heartbeat
 * location after Phase 8 collapsed the v1/v2 dual-write.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FRESHNESS_SECS = 600;

export type VerdictResult = {
  allow: boolean;
  exit_code: 0 | 2;
  rule: string;
  reason?: string;
};

interface PeerView {
  instance_id: string;
  name?: string;
  files_touched: string[];
  last_heartbeat: string;
  session_id: string;
  /** parent_instance_id from heartbeat, present for subagent rows. Used by
   *  the group-ownership check (sibling subagents + parent share a group
   *  and don't block each other's claims).
   */
  parent_instance_id?: string;
}

export interface ClaimRequest {
  rule: "claim";
  instance_id: string;
  session_id?: string;
  path: string; // canonical monorepo-relative path
  mode?: "read" | "write"; // default "write"
}

/**
 * Evaluate a file-claim. Returns deny when another fresh peer claims the
 * path, OR when this owner already holds a lower-sorted claim and the new
 * one would create a circular wait.
 */
export function evaluateClaim(coordRoot: string, req: ClaimRequest): VerdictResult {
  const peers = readPeers(coordRoot);
  const myPeer = peers.find((p) => p.instance_id === req.instance_id);

  // Group-ownership exclusion ("Option B" semantics): the parent
  // session and all subagents under it share a group; claims within the
  // group don't block each other. Compute the group root for the calling
  // instance_id, then exclude any peer in the same group from the conflict
  // scan. session_id from the payload is the parent_owner for subagents.
  const groupRoot = computeGroupRoot(peers, req.instance_id, req.session_id);
  const inMyGroup = (p: PeerView): boolean =>
    p.instance_id === req.instance_id ||
    p.instance_id === groupRoot ||
    p.parent_instance_id === groupRoot ||
    (p.parent_instance_id !== undefined && p.parent_instance_id === req.instance_id);

  const otherPeers = peers.filter((p) => !inMyGroup(p));

  // Conflict scan: any other fresh peer claiming this exact path?
  const conflict = otherPeers.find(
    (p) => isFresh(p.last_heartbeat) && p.files_touched.includes(req.path),
  );
  if (conflict) {
    // Self-heal probe: if the file is committed-clean (exists in the repo AND has no uncommitted
    // changes), the peer's claim is stale (worker crashed without releasing) →
    // prune the claim from their heartbeat and allow the edit. Skips when the
    // file doesn't exist (intent-to-create claim); that surface IS load-bearing.
    if (isFileCommittedClean(coordRoot, req.path)) {
      pruneClaimFromPeer(coordRoot, conflict.instance_id, req.path);
      // Fall through to ordering check + allow.
    } else {
      return {
        allow: false,
        exit_code: 2,
        rule: "claim.conflict",
        reason: `File ${req.path} is currently being edited by agent-${conflict.name ?? conflict.instance_id.slice(0, 8)}. Wait for them to finish or pick a different file. Set HARNERY_AGENT_COORD_OFF=1 to bypass (not recommended).`,
      };
    }
  }

  // Ordering check: if we hold any claim with path < req.path, fine.
  // Otherwise the new claim would create a backward-edge in the dependency
  // graph and risk deadlock. Only applies when a fresh peer genuinely CONTENDS
  // with us — i.e. holds a path that also sits in our own footprint (held
  // claims ∪ the path we're now requesting). A wait-for cycle is a
  // strongly-connected set of agents linked by shared files; if no fresh peer
  // shares any file with our footprint, we're in a disjoint component of the
  // resource graph and cannot be part of any cycle, so sorted-order acquisition
  // buys nothing and the block is pure false-positive friction. Sharing a file
  // is the necessary condition for a cycle through this agent, so this narrowing
  // leaves the deadlock-prevention invariant intact for genuine contention while
  // removing the dominant real-world cost — a peer editing unrelated files
  // walling off every backward-order edit. (Single-agent flow can't deadlock
  // with itself and never arms, since there are no other peers to contend.)
  const myFootprint = new Set<string>(myPeer?.files_touched ?? []);
  myFootprint.add(req.path);
  const hasContendingPeer = otherPeers.some(
    (p) => isFresh(p.last_heartbeat) && p.files_touched.some((f) => myFootprint.has(f)),
  );
  // Re-editing a path already in our own files_touched acquires no new lock
  // edge, so it can't create a circular wait — the ordering rule must not block
  // it. Without this exemption, an agent that edits a higher-sorting file and
  // then makes a second pass over an already-held lower-sorting file gets a
  // spurious ordering_violation (the dominant friction source under concurrency:
  // both agent-Gibson holding README.md and agent-Ophelia holding AGENTS.md were
  // blocked re-editing those held files after touching a higher path, 2026-07-03).
  const alreadyHeld = myPeer?.files_touched.includes(req.path) ?? false;
  if (hasContendingPeer && myPeer && myPeer.files_touched.length > 0 && !alreadyHeld) {
    // Only ACTIVE (uncommitted) edits should constrain lock ordering. A claim on
    // a committed-clean file is a finished edit, not a held lock, so it must not
    // wall off a lower-sorted acquisition. Without this, a long session
    // accumulates committed claims that block every earlier-sorted path — pure
    // friction, no deadlock risk (the file isn't being touched). Mirrors the
    // peer stale-claim self-heal above. The git probes run only on the
    // would-block path (claims sorting after req.path), staying off the hot path.
    const blockers = myPeer.files_touched.filter((p) => req.path < p);
    if (blockers.length > 0) {
      const activeBlockers = blockers.filter((p) => !isFileCommittedClean(coordRoot, p));
      if (activeBlockers.length > 0) {
        const highest = [...activeBlockers].sort().at(-1)!;
        return {
          allow: false,
          exit_code: 2,
          rule: "claim.ordering_violation",
          reason: `Cannot acquire ${req.path}: you already hold ${highest}, which sorts after it (claim ordering rule: acquire paths in sorted order to prevent deadlock between concurrent agents). Fix by editing in sorted order, or by committing ${highest} first, since a committed-clean file no longer blocks and is auto-pruned.`,
        };
      }
      // Every blocker is a finished (committed-clean) edit: prune them so they
      // stop constraining future acquisitions, then fall through to allow.
      for (const p of blockers) pruneClaimFromPeer(coordRoot, req.instance_id, p);
    }
  }

  // Acquire the claim: atomic check-and-set. Adds req.path to my
  // files_touched if not already present.
  if (req.mode !== "read") {
    addClaimToOwner(coordRoot, req.instance_id, req.path);
  }

  return { allow: true, exit_code: 0, rule: "claim.pass" };
}

/**
 * Add `relPath` to the owner's heartbeat `files_touched` array (idempotent;
 * no-op if already present). Atomic temp + rename. If the owner has no
 * heartbeat yet (subagent that hasn't been initialized), creates a minimal one.
 */
function addClaimToOwner(coordRoot: string, instanceId: string, relPath: string): void {
  const activeDir = join(coordRoot, ".harnery", "active");
  if (!existsSync(activeDir)) return;
  const path = join(activeDir, `${instanceId}.json`);
  if (!existsSync(path)) {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const minimal = {
      schema_version: 1,
      instance_id: instanceId,
      session_id: instanceId,
      files_touched: [relPath],
      started_at: now,
      last_heartbeat: now,
    };
    try {
      const tmp = `${path}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(minimal, null, 2), "utf8");
      renameSync(tmp, path);
    } catch {
      /* silent */
    }
    return;
  }
  try {
    const body = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const files = (body.files_touched as string[] | undefined) ?? [];
    if (files.includes(relPath)) return;
    body.files_touched = [...files, relPath];
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(body, null, 2), "utf8");
    renameSync(tmp, path);
  } catch {
    /* silent */
  }
}

function readPeers(coordRoot: string): PeerView[] {
  const out: PeerView[] = [];
  const path = join(coordRoot, ".harnery", "active");
  if (!existsSync(path)) return out;
  for (const f of readdirSync(path)) {
    if (!f.endsWith(".json")) continue;
    try {
      const hb = JSON.parse(readFileSync(join(path, f), "utf8")) as {
        instance_id?: string;
        name?: string;
        session_id?: string;
        files_touched?: string[];
        last_heartbeat?: string;
        parent_instance_id?: string;
        parent_session_id?: string;
      };
      if (!hb.instance_id) continue;
      // Derive parent_instance_id: explicit field first, then infer from
      // session_id-differs-from-instance_id (the subagent shape:
      // instance_id is the agent_id, session_id is the parent session).
      const inferredParent =
        hb.parent_instance_id ??
        hb.parent_session_id ??
        (hb.session_id && hb.session_id !== hb.instance_id ? hb.session_id : undefined);
      out.push({
        instance_id: hb.instance_id,
        name: hb.name,
        session_id: hb.session_id ?? hb.instance_id,
        files_touched: hb.files_touched ?? [],
        last_heartbeat: hb.last_heartbeat ?? "",
        parent_instance_id: inferredParent,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Compute the group root for `instanceId`. For a parent session it's instanceId
 * itself. For a subagent it's the parent_instance_id from the heartbeat
 * (stamped on subagent heartbeats). When session_id is
 * supplied and differs from instanceId (Claude Code's `session_id != agent_id`
 * shape for subagents), that's the group root too.
 */
function computeGroupRoot(peers: PeerView[], instanceId: string, sessionId?: string): string {
  // If we have a peer entry, its parent_instance_id is authoritative.
  const myPeer = peers.find((p) => p.instance_id === instanceId);
  if (myPeer?.parent_instance_id) return myPeer.parent_instance_id;
  // Fallback to session_id (parent's instance_id for subagents).
  if (sessionId && sessionId !== instanceId) return sessionId;
  // I am the group root.
  return instanceId;
}

function isFresh(lastHeartbeat: string): boolean {
  if (!lastHeartbeat) return false;
  const ts = Date.parse(lastHeartbeat);
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) / 1000 <= FRESHNESS_SECS;
}

/**
 * Check if a monorepo-relative path is committed-clean: file exists in the
 * repo, is tracked, AND `git diff HEAD -- path` shows no uncommitted
 * modifications. Untracked files are NOT committed-clean: `git diff HEAD`
 * exits 0 on an untracked path (because git ignores it), so we have to
 * positively confirm tracking via `git ls-files` before trusting the diff.
 *
 * Returns false when:
 *  - file doesn't exist (intent-to-create, preserve the claim)
 *  - file is untracked (peer wrote it, hasn't staged yet, preserve the claim)
 *  - any git op fails (treat as dirty, fail-safe)
 *  - diff shows non-empty output (genuinely dirty)
 */
function isFileCommittedClean(coordRoot: string, relPath: string): boolean {
  // Tolerate either path form: files_touched can hold absolute-under-coordRoot
  // entries (legacy file-tracking) or canonical monorepo-relative ones.
  const rel = relPath.startsWith(`${coordRoot}/`) ? relPath.slice(coordRoot.length + 1) : relPath;
  const abs = join(coordRoot, rel);
  if (!existsSync(abs)) return false;
  try {
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], {
      cwd: coordRoot,
      encoding: "utf8",
      timeout: 2000,
    });
    if (tracked.status !== 0) return false;
    const result = spawnSync("git", ["diff", "--quiet", "HEAD", "--", rel], {
      cwd: coordRoot,
      encoding: "utf8",
      timeout: 2000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Remove a stale claim from a peer's heartbeat. Atomic temp + rename. Silent
 * on failure.
 */
function pruneClaimFromPeer(coordRoot: string, instanceId: string, relPath: string): void {
  const path = join(coordRoot, ".harnery", "active", `${instanceId}.json`);
  if (!existsSync(path)) return;
  try {
    const body = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const files = (body.files_touched as string[] | undefined) ?? [];
    const next = files.filter((p) => p !== relPath);
    if (next.length === files.length) return;
    body.files_touched = next;
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(body, null, 2), "utf8");
    renameSync(tmp, path);
  } catch {
    /* silent */
  }
}
