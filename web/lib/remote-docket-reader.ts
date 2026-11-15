/**
 * Read side for other machines' shared dockets (ADR 0255). The dashboard shows
 * them read-only: resolution, claims, reviews and approval answers happen only
 * on the machine that filed the item.
 *
 * Everything here reads the locally fetched `refs/harnery/docket/*` through the
 * core readers. It never fetches, never writes a ref, and never throws into a
 * page render: any failure degrades to an empty snapshot with a reason.
 */

import { presenceEnabled } from "../../src/core/config";
import {
  type DocketApproval,
  type DocketDecision,
  docketContact,
  docketShareEnabled,
  docketSourceLabel,
  parseDocketBlob,
  type RemoteDocket,
  readRemoteDockets,
} from "../../src/core/presence/docket";
import { DOCKET_REF_PREFIX, readMachineRefs } from "../../src/core/presence/git";
import { readRemoteMachines } from "../../src/core/presence/index";
import { coordRoot } from "./coord-reader";

export type { DocketApproval, DocketDecision };

/** Where a remote item came from, flattened for rendering. */
export interface RemoteSource {
  /** Ref component the blob was read from; used in links. */
  ref: string;
  /** Display label, disambiguated when two machines share a label. */
  label: string;
  publishedAt: string;
  ageSecs: number;
  stale: boolean;
  /** Agent name to ping about items from this machine, or null when none is known. */
  contact: string | null;
}

export interface RemoteDecisionRow {
  decision: DocketDecision;
  source: RemoteSource;
}

export interface RemoteApprovalRow {
  approval: DocketApproval;
  source: RemoteSource;
}

export interface RemoteMachineSummary extends RemoteSource {
  decisions: number;
  approvals: number;
  /** Items the publisher dropped to stay under its size cap. */
  truncated: number;
}

export interface RemoteDocketSnapshot {
  /** Presence carries the docket refs; off means nothing can arrive. */
  presence: boolean;
  /** Whether this machine publishes its own docket (`decision.share`). */
  sharing: boolean;
  machines: RemoteMachineSummary[];
  /** Waiting on a human on another machine. Never raises local attention. */
  waiting: RemoteDecisionRow[];
  /** Recently changed, not waiting. */
  recent: RemoteDecisionRow[];
  approvals: RemoteApprovalRow[];
  /** Ref names whose blob could not be parsed. */
  malformed: string[];
  /** Set when reading failed outright; the rest of the snapshot is empty. */
  error: string | null;
}

const EMPTY: Omit<RemoteDocketSnapshot, "presence" | "sharing" | "error"> = {
  machines: [],
  waiting: [],
  recent: [],
  approvals: [],
  malformed: [],
};

/** Injection seam for tests; production callers use the defaults. */
export interface RemoteDocketDeps {
  root?: string;
  now?: Date;
  presenceEnabled?: (root: string) => boolean;
  docketShareEnabled?: (root: string) => boolean;
  readRemoteDockets?: (root: string, opts: { now?: Date }) => RemoteDocket[];
  readDocketRefs?: (root: string) => Array<{ machine: string; message: string }>;
  readPresenceAgents?: (
    root: string,
  ) => Array<{ machine: string; agents: Array<{ name?: string }> }>;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function readRemoteDocketSnapshot(deps: RemoteDocketDeps = {}): RemoteDocketSnapshot {
  let root: string;
  try {
    root = deps.root ?? coordRoot();
  } catch (e) {
    return { ...EMPTY, presence: false, sharing: false, error: message(e) };
  }
  const presence = safe(() => (deps.presenceEnabled ?? presenceEnabled)(root), false);
  const sharing = safe(() => (deps.docketShareEnabled ?? docketShareEnabled)(root), false);
  if (!presence) return { ...EMPTY, presence, sharing, error: null };

  try {
    const dockets = (deps.readRemoteDockets ?? readRemoteDockets)(root, { now: deps.now });
    const refs = safe(
      () => (deps.readDocketRefs ?? ((r: string) => readMachineRefs(r, DOCKET_REF_PREFIX)))(root),
      [],
    );
    const malformed = refs.filter((r) => parseDocketBlob(r.message) === null).map((r) => r.machine);
    const presenceAgents = safe(
      () =>
        (deps.readPresenceAgents ?? ((r: string) => readRemoteMachines(r, { includeStale: true })))(
          root,
        ),
      [],
    );

    const machines: RemoteMachineSummary[] = [];
    const waiting: RemoteDecisionRow[] = [];
    const recent: RemoteDecisionRow[] = [];
    const approvals: RemoteApprovalRow[] = [];
    for (const d of dockets) {
      const agents =
        presenceAgents.find((m) => m.machine === d.ref || m.machine === d.machine)?.agents ?? [];
      const base: Omit<RemoteSource, "contact"> = {
        ref: d.ref,
        label: docketSourceLabel(d),
        publishedAt: d.published_at,
        ageSecs: d.age_secs,
        stale: d.stale,
      };
      const machineContact = docketContact(undefined, agents);
      machines.push({
        ...base,
        contact: machineContact,
        decisions: d.decisions.length,
        approvals: d.approvals.length,
        truncated: d.truncated.waiting + d.truncated.recent + d.truncated.approvals,
      });
      for (const decision of d.decisions) {
        const row = {
          decision,
          source: { ...base, contact: docketContact(decision.filed_by, agents) },
        };
        (decision.waiting ? waiting : recent).push(row);
      }
      for (const approval of d.approvals) {
        approvals.push({ approval, source: { ...base, contact: machineContact } });
      }
    }
    waiting.sort((a, b) => byStakesThenAge(a.decision, b.decision));
    recent.sort((a, b) => stamp(b.decision).localeCompare(stamp(a.decision)));
    approvals.sort((a, b) => a.approval.requested_at.localeCompare(b.approval.requested_at));
    return { presence, sharing, machines, waiting, recent, approvals, malformed, error: null };
  } catch (e) {
    return { ...EMPTY, presence, sharing, error: message(e) };
  }
}

/** One remote decision by id; `ref` pins the source machine when given. */
export function findRemoteDecisionRow(
  snap: RemoteDocketSnapshot,
  id: string,
  ref?: string,
): RemoteDecisionRow | null {
  let best: RemoteDecisionRow | null = null;
  for (const row of [...snap.waiting, ...snap.recent]) {
    if (row.decision.decision_id !== id) continue;
    if (ref && row.source.ref !== ref) continue;
    if (!best || row.source.ageSecs < best.source.ageSecs) best = row;
  }
  return best;
}

/** Shell command that reaches the owner of a remote item, or null. */
export function reachCommand(binName: string, source: RemoteSource): string | null {
  return source.contact ? `${binName} agents ping ${source.contact} "<message>"` : null;
}

export function remoteDecisionHref(row: RemoteDecisionRow): string {
  return `/decisions/${encodeURIComponent(row.decision.decision_id)}?from=${encodeURIComponent(row.source.ref)}`;
}

const STAKES_RANK: Record<string, number> = { high: 3, medium: 2, small: 1 };

function byStakesThenAge(a: DocketDecision, b: DocketDecision): number {
  const rank = (STAKES_RANK[b.stakes] ?? 1) - (STAKES_RANK[a.stakes] ?? 1);
  return rank !== 0 ? rank : a.filed_at.localeCompare(b.filed_at);
}

function stamp(d: DocketDecision): string {
  return d.updated_at ?? d.filed_at;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
