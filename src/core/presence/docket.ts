/**
 * Shared docket (ADR 0255): a read-only, cross-machine copy of each machine's
 * decision docket and parked run approvals, carried on the presence git-refs
 * transport (ADR 0016).
 *
 * Decisions and approvals live in the filing machine's `.harnery/`, which is
 * never committed. With `decision.share: true` in the project config, each
 * machine publishes a bounded docket blob to `refs/harnery/docket/<machine>`:
 * every decision still waiting on a human, every pending approval, and
 * manifests of recently changed decisions. Other machines fetch the namespace
 * with presence and render those items labelled with their source machine.
 *
 * Authority never moves: resolution, approval, and denial still happen only on
 * the filing machine. Every entry point here is fail-silent. A malformed blob
 * is dropped, a failed push or fetch leaves local behavior unchanged, and
 * nothing in this module throws into a hook.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DecisionManifest,
  isTerminal,
  listDecisions,
  showDecision,
} from "../../lib/decision/index.ts";
import { coordEnv } from "../../lib/env.ts";
import { resolveMachineLabel } from "../../lib/machine.ts";
import { presenceEnabled, stripJsonComments } from "../config.ts";
import { listWorkflowApprovals, type WorkflowApproval } from "../run/approvals.ts";
import {
  DOCKET_REF_PREFIX,
  hasOrigin,
  pushMachineRef,
  readMachineRefs,
  sanitizeRefComponent,
  writePresenceCommit,
} from "./git.ts";

export const DOCKET_BLOB_VERSION = 1 as const;

/** Caps that bound one docket blob regardless of local state. */
export interface DocketLimits {
  waiting: number;
  recent: number;
  approvals: number;
  recentDays: number;
  bytes: number;
  question: number;
  context: number;
  summary: number;
  brief: number;
  reason: number;
}

export const DOCKET_LIMITS: Readonly<DocketLimits> = {
  waiting: 50,
  recent: 50,
  approvals: 30,
  /** A decision counts as recently changed for this long after its last update. */
  recentDays: 14,
  /** Hard ceiling on the serialized blob. */
  bytes: 48 * 1024,
  /** Per-field clamps. */
  question: 300,
  context: 600,
  summary: 280,
  brief: 2_000,
  reason: 300,
};

/** Re-publish at least this often so peers can tell "unchanged" from "gone". */
const KEEPALIVE_SECS = 1_800;
const MIN_PUSH_INTERVAL_SECS = 15;
/** A docket older than this is flagged stale (its machine stopped publishing). */
export const DOCKET_STALE_SECS = 3 * KEEPALIVE_SECS;
/** A docket older than this is not shown at all. */
const DOCKET_EXPIRE_SECS = 14 * 24 * 3600;

export interface DocketDecision {
  decision_id: string;
  question: string;
  tier: number;
  stakes: string;
  status: string;
  /** Tier 2, unresolved, not terminal: a human still has to rule on it. */
  waiting: boolean;
  filed_at: string;
  updated_at?: string;
  filed_by?: string;
  claimed_by?: string;
  context?: string;
  default_taken?: string;
  /** Short recommendation text once resolved. */
  resolution_summary?: string;
  resolved_by?: string;
  resolved_at?: string;
  review_verdict?: string;
  /** Clamped brief body; dropped first when the blob is over its byte cap. */
  brief?: string;
  brief_truncated?: boolean;
}

export interface DocketApproval {
  id: string;
  run_id: string;
  status: string;
  requested_at: string;
  addressed_to: string;
  phase: string;
  action: string;
  reason?: string;
}

export interface DocketTruncation {
  waiting: number;
  recent: number;
  approvals: number;
  briefs: number;
}

export interface DocketBlob {
  v: typeof DOCKET_BLOB_VERSION;
  kind: "docket";
  machine: string;
  /** Random per-clone id; tells two machines with the same label apart. */
  machine_id: string;
  published_at: string;
  /** True when this machine turned sharing off; peers show nothing from it. */
  withdrawn?: boolean;
  decisions: DocketDecision[];
  approvals: DocketApproval[];
  truncated: DocketTruncation;
}

// ─── Config ─────────────────────────────────────────────────────────────────

/**
 * Whether this machine publishes its docket. Project config
 * `{ "decision": { "share": true } }`; default off because decision text can
 * be sensitive. `HARNERY_DOCKET_SHARE=1|0` overrides per process. Requires
 * presence, whose transport carries the blob.
 */
export function docketShareEnabled(coordRoot: string): boolean {
  try {
    if (!presenceEnabled(coordRoot)) return false;
    const env = coordEnv("DOCKET_SHARE");
    if (env === "1") return true;
    if (env === "0") return false;
    const raw = readFileSync(join(coordRoot, ".harnery", "config.jsonc"), "utf8");
    const parsed = JSON.parse(stripJsonComments(raw)) as { decision?: { share?: unknown } };
    return parsed?.decision?.share === true;
  } catch {
    return false;
  }
}

// ─── Local state ────────────────────────────────────────────────────────────

interface DocketState {
  basis_hash?: string;
  pushed_at?: string;
  /** Ref component this machine last published under (may carry a suffix). */
  ref?: string;
  /** Whether the last publish carried items (vs empty or withdrawn). */
  had_items?: boolean;
  withdrawn?: boolean;
}

function presenceDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "presence");
}

function statePath(coordRoot: string): string {
  return join(presenceDir(coordRoot), "docket-state.json");
}

function readState(coordRoot: string): DocketState {
  try {
    return JSON.parse(readFileSync(statePath(coordRoot), "utf8")) as DocketState;
  } catch {
    return {};
  }
}

function writeState(coordRoot: string, state: DocketState): void {
  try {
    mkdirSync(presenceDir(coordRoot), { recursive: true });
    const p = statePath(coordRoot);
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, p);
  } catch {
    /* best-effort */
  }
}

/** This clone's stable random id, created on first use. */
export function docketMachineId(coordRoot: string): string {
  const p = join(presenceDir(coordRoot), "docket-machine-id");
  try {
    const existing = readFileSync(p, "utf8").trim();
    if (/^[a-f0-9]{12}$/.test(existing)) return existing;
  } catch {
    /* create below */
  }
  const id = randomBytes(6).toString("hex");
  try {
    mkdirSync(presenceDir(coordRoot), { recursive: true });
    writeFileSync(p, `${id}\n`, "utf8");
  } catch {
    /* an unwritable dir still gets a per-process id */
  }
  return id;
}

// ─── Build ──────────────────────────────────────────────────────────────────

export interface BuildDocketOptions {
  now?: Date;
  machine?: string;
  machineId?: string;
  limits?: Partial<DocketLimits>;
}

export interface BuiltDocket {
  blob: DocketBlob;
  basisHash: string;
  json: string;
}

/** Build this machine's docket blob from its local decisions and approvals. */
export function buildDocketBlob(coordRoot: string, opts: BuildDocketOptions = {}): BuiltDocket {
  const limits = { ...DOCKET_LIMITS, ...(opts.limits ?? {}) };
  const now = opts.now ?? new Date();
  const recentCutoff = now.getTime() - limits.recentDays * 24 * 3600 * 1000;
  const truncated: DocketTruncation = { waiting: 0, recent: 0, approvals: 0, briefs: 0 };

  let manifests: DecisionManifest[] = [];
  try {
    manifests = listDecisions(coordRoot, { includeArchived: true });
  } catch {
    manifests = [];
  }
  const waitingRows: DecisionManifest[] = [];
  const recentRows: DecisionManifest[] = [];
  for (const m of manifests) {
    if (isWaiting(m)) {
      waitingRows.push(m);
      continue;
    }
    const touched = Date.parse(m.updated_at ?? m.filed_at ?? "");
    if (Number.isFinite(touched) && touched >= recentCutoff) recentRows.push(m);
  }
  // Waiting: highest stakes first, then longest open. Recent: newest first.
  waitingRows.sort(byStakesThenAge);
  recentRows.sort((a, b) => stamp(b).localeCompare(stamp(a)));
  truncated.waiting = Math.max(0, waitingRows.length - limits.waiting);
  truncated.recent = Math.max(0, recentRows.length - limits.recent);

  const decisions: DocketDecision[] = [
    ...waitingRows.slice(0, limits.waiting).map((m) => projectDecision(coordRoot, m, true, limits)),
    ...recentRows.slice(0, limits.recent).map((m) => projectDecision(coordRoot, m, false, limits)),
  ];

  let pending: WorkflowApproval[] = [];
  try {
    pending = listWorkflowApprovals(coordRoot, { status: "pending" });
  } catch {
    pending = [];
  }
  pending.sort((a, b) => a.request.requested_at.localeCompare(b.request.requested_at));
  truncated.approvals = Math.max(0, pending.length - limits.approvals);
  const approvals = pending.slice(0, limits.approvals).map((a) => projectApproval(a, limits));

  const blob: DocketBlob = {
    v: DOCKET_BLOB_VERSION,
    kind: "docket",
    machine: opts.machine ?? resolveMachineLabel(),
    machine_id: opts.machineId ?? docketMachineId(coordRoot),
    published_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    decisions,
    approvals,
    truncated,
  };
  fitToByteCap(blob, limits.bytes);

  const basis = {
    d: blob.decisions.map((d) => [d.decision_id, d.status, d.tier, d.stakes, d.updated_at ?? null]),
    a: blob.approvals.map((a) => [a.id, a.status]),
    t: blob.truncated,
    b: blob.decisions.map((d) => (d.brief ? d.brief.length : 0)),
  };
  const basisHash = createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);
  return { blob, basisHash, json: JSON.stringify(blob) };
}

/** Drop briefs (lowest priority first), then recent, then waiting, until it fits. */
function fitToByteCap(blob: DocketBlob, maxBytes: number): void {
  const size = (): number => Buffer.byteLength(JSON.stringify(blob), "utf8");
  if (size() <= maxBytes) return;
  for (let i = blob.decisions.length - 1; i >= 0 && size() > maxBytes; i--) {
    const d = blob.decisions[i];
    if (d?.brief) {
      delete d.brief;
      d.brief_truncated = true;
      blob.truncated.briefs++;
    }
  }
  while (size() > maxBytes && blob.decisions.length > 0) {
    const last = blob.decisions.pop();
    if (last?.waiting) blob.truncated.waiting++;
    else blob.truncated.recent++;
  }
  while (size() > maxBytes && blob.approvals.length > 0) {
    blob.approvals.pop();
    blob.truncated.approvals++;
  }
}

function isWaiting(m: DecisionManifest): boolean {
  return m.tier === 2 && !m.resolution && !isTerminal(m.status);
}

function stamp(m: DecisionManifest): string {
  return m.updated_at ?? m.filed_at ?? "";
}

const STAKES_RANK: Record<string, number> = { high: 3, medium: 2, small: 1 };

function byStakesThenAge(a: DecisionManifest, b: DecisionManifest): number {
  const rank = (STAKES_RANK[b.stakes] ?? 1) - (STAKES_RANK[a.stakes] ?? 1);
  return rank !== 0 ? rank : (a.filed_at ?? "").localeCompare(b.filed_at ?? "");
}

function projectDecision(
  coordRoot: string,
  m: DecisionManifest,
  waiting: boolean,
  limits: DocketLimits,
): DocketDecision {
  const out: DocketDecision = {
    decision_id: m.decision_id,
    question: clamp(m.question, limits.question) ?? "",
    tier: m.tier,
    stakes: m.stakes,
    status: m.status,
    waiting,
    filed_at: m.filed_at,
  };
  setIf(out, "updated_at", str(m.updated_at));
  setIf(out, "filed_by", str(m.filed_by));
  setIf(out, "claimed_by", str(m.claimed_by));
  setIf(out, "context", clamp(str(m.context), limits.context));
  setIf(out, "default_taken", clamp(str(m.default_taken), limits.summary));
  if (m.resolution) {
    setIf(out, "resolution_summary", clamp(str(m.resolution.recommendation), limits.summary));
    setIf(out, "resolved_by", str(m.resolution.resolved_by));
    setIf(out, "resolved_at", str(m.resolution.resolved_at));
  }
  setIf(out, "review_verdict", str(m.review?.verdict));
  if (waiting) {
    try {
      const brief = showDecision(coordRoot, m.decision_id)?.bodies.find(
        (b) => b.name === "brief.md",
      )?.content;
      if (brief?.trim()) {
        const text = brief.trim();
        out.brief = text.length > limits.brief ? text.slice(0, limits.brief) : text;
        if (text.length > limits.brief) out.brief_truncated = true;
      }
    } catch {
      /* a missing body is not an error */
    }
  }
  return out;
}

function projectApproval(a: WorkflowApproval, limits: DocketLimits): DocketApproval {
  const out: DocketApproval = {
    id: a.request.id,
    run_id: a.request.run_id,
    status: a.status,
    requested_at: a.request.requested_at,
    addressed_to: a.request.addressed_to,
    phase: a.request.request.phase,
    action: clamp(a.request.request.action, limits.reason) ?? "",
  };
  setIf(out, "reason", clamp(str(a.request.evaluation?.reason), limits.reason));
  return out;
}

// ─── Publish ────────────────────────────────────────────────────────────────

export type DocketPublishResult =
  | { status: "published"; machine: string; ref: string; decisions: number; approvals: number }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string };

/**
 * Publish this machine's docket when it changed or the keepalive elapsed.
 * Turning sharing off publishes one withdrawn (empty) blob so peers stop
 * showing stale copies. Called from `publishPresence`; never throws.
 */
export function publishDocket(
  coordRoot: string,
  opts: { force?: boolean; sync?: boolean; now?: Date } = {},
): DocketPublishResult {
  try {
    if (!presenceEnabled(coordRoot)) return { status: "skipped", reason: "presence disabled" };
    const state = readState(coordRoot);
    const sharing = docketShareEnabled(coordRoot);
    if (!sharing && (!state.pushed_at || state.withdrawn)) {
      return { status: "skipped", reason: "sharing off" };
    }
    const now = opts.now ?? new Date();
    const pushedAtMs = Date.parse(state.pushed_at ?? "");
    const sincePush = Number.isFinite(pushedAtMs)
      ? (now.getTime() - pushedAtMs) / 1000
      : Number.POSITIVE_INFINITY;
    // Hooks call this on every turn; skip the scan entirely inside the floor.
    if (!opts.force && sincePush < MIN_PUSH_INTERVAL_SECS) {
      return { status: "skipped", reason: "min push interval" };
    }
    if (!hasOrigin(coordRoot)) return { status: "skipped", reason: "no origin remote" };

    const machineId = docketMachineId(coordRoot);
    const machine = resolveMachineLabel();
    const built = sharing
      ? buildDocketBlob(coordRoot, { now, machine, machineId })
      : withdrawnBlob(machine, machineId, now);
    const hasItems = built.blob.decisions.length > 0 || built.blob.approvals.length > 0;

    if (!opts.force && sharing) {
      if (!hasItems && !state.had_items && state.pushed_at) {
        // Empty and already said so: keepalive only.
        if (sincePush < KEEPALIVE_SECS) return { status: "skipped", reason: "empty (unchanged)" };
      }
      if (!hasItems && !state.pushed_at) return { status: "skipped", reason: "nothing to share" };
      const unchanged = state.basis_hash === built.basisHash;
      if (unchanged && sincePush < KEEPALIVE_SECS) {
        return { status: "skipped", reason: "unchanged (within keepalive)" };
      }
    }

    // A withdrawal overwrites the ref this machine last wrote, nothing else.
    const ref =
      !sharing && state.ref
        ? state.ref
        : chooseDocketRef(coordRoot, machine, machineId, state.ref, now);
    const sha = writePresenceCommit(coordRoot, built.json);
    if (!sha) return { status: "error", error: "commit-tree failed" };
    const push = pushMachineRef(coordRoot, DOCKET_REF_PREFIX, ref, sha, { sync: opts.sync });
    if (!push.ok) return { status: "error", error: push.error ?? "push failed" };

    writeState(coordRoot, {
      basis_hash: built.basisHash,
      pushed_at: now.toISOString(),
      ref,
      had_items: hasItems,
      withdrawn: !sharing,
    });
    return {
      status: "published",
      machine,
      ref,
      decisions: built.blob.decisions.length,
      approvals: built.blob.approvals.length,
    };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

function withdrawnBlob(machine: string, machineId: string, now: Date): BuiltDocket {
  const blob: DocketBlob = {
    v: DOCKET_BLOB_VERSION,
    kind: "docket",
    machine,
    machine_id: machineId,
    published_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    withdrawn: true,
    decisions: [],
    approvals: [],
    truncated: { waiting: 0, recent: 0, approvals: 0, briefs: 0 },
  };
  return { blob, basisHash: "withdrawn", json: JSON.stringify(blob) };
}

/**
 * Pick the ref component to publish under. Normally the sanitized machine
 * label. When the locally fetched copy of that ref belongs to a different,
 * still-fresh machine (two machines share a label), this machine moves to
 * `<label>-<id prefix>` and stays there, so neither overwrites the other.
 */
export function chooseDocketRef(
  coordRoot: string,
  machine: string,
  machineId: string,
  previous: string | undefined,
  now: Date = new Date(),
): string {
  const base = sanitizeRefComponent(machine);
  const suffixed = sanitizeRefComponent(`${machine}-${machineId.slice(0, 6)}`);
  if (previous === suffixed) return suffixed;
  try {
    for (const { machine: ref, message } of readMachineRefs(coordRoot, DOCKET_REF_PREFIX)) {
      if (ref !== base) continue;
      const blob = parseDocketBlob(message);
      if (!blob || blob.machine_id === machineId) return base;
      const age = (now.getTime() - Date.parse(blob.published_at)) / 1000;
      return age <= DOCKET_STALE_SECS ? suffixed : base;
    }
  } catch {
    /* unreadable refs: keep the plain label */
  }
  return base;
}

// ─── Read ───────────────────────────────────────────────────────────────────

/** Validate a docket blob; drops malformed items, returns null for a bad blob. */
export function parseDocketBlob(message: string): DocketBlob | null {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw.v !== DOCKET_BLOB_VERSION || raw.kind !== "docket") return null;
  const machine = str(raw.machine);
  const machineId = str(raw.machine_id);
  const publishedAt = str(raw.published_at);
  if (!machine || !machineId || !publishedAt || !Number.isFinite(Date.parse(publishedAt))) {
    return null;
  }
  const decisions = Array.isArray(raw.decisions)
    ? raw.decisions.map(parseDecision).filter((d): d is DocketDecision => d !== null)
    : [];
  const approvals = Array.isArray(raw.approvals)
    ? raw.approvals.map(parseApproval).filter((a): a is DocketApproval => a !== null)
    : [];
  const t = isRecord(raw.truncated) ? raw.truncated : {};
  return {
    v: DOCKET_BLOB_VERSION,
    kind: "docket",
    machine,
    machine_id: machineId,
    published_at: publishedAt,
    ...(raw.withdrawn === true ? { withdrawn: true } : {}),
    decisions,
    approvals,
    truncated: {
      waiting: count(t.waiting),
      recent: count(t.recent),
      approvals: count(t.approvals),
      briefs: count(t.briefs),
    },
  };
}

function parseDecision(raw: unknown): DocketDecision | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.decision_id);
  const question = str(raw.question);
  const status = str(raw.status);
  const stakes = str(raw.stakes);
  const filedAt = str(raw.filed_at);
  if (!id || !/^[A-Za-z0-9._-]{1,200}$/.test(id)) return null;
  if (!question || !status || !stakes || !filedAt) return null;
  if (typeof raw.tier !== "number") return null;
  const out: DocketDecision = {
    decision_id: id,
    question: clamp(question, DOCKET_LIMITS.question) ?? "",
    tier: raw.tier,
    stakes,
    status,
    waiting: raw.waiting === true,
    filed_at: filedAt,
  };
  for (const key of [
    "updated_at",
    "filed_by",
    "claimed_by",
    "default_taken",
    "resolution_summary",
    "resolved_by",
    "resolved_at",
    "review_verdict",
  ] as const) {
    setIf(out, key, clamp(str(raw[key]), DOCKET_LIMITS.summary));
  }
  setIf(out, "context", clamp(str(raw.context), DOCKET_LIMITS.context));
  setIf(out, "brief", clamp(str(raw.brief), DOCKET_LIMITS.brief));
  if (raw.brief_truncated === true) out.brief_truncated = true;
  return out;
}

function parseApproval(raw: unknown): DocketApproval | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const runId = str(raw.run_id);
  const status = str(raw.status);
  const requestedAt = str(raw.requested_at);
  if (!id || !/^apr-[a-f0-9]{20}$/.test(id) || !runId || !status || !requestedAt) return null;
  const out: DocketApproval = {
    id,
    run_id: clamp(runId, 200) ?? "",
    status,
    requested_at: requestedAt,
    addressed_to: clamp(str(raw.addressed_to), 200) ?? "",
    phase: clamp(str(raw.phase), 40) ?? "",
    action: clamp(str(raw.action), DOCKET_LIMITS.reason) ?? "",
  };
  setIf(out, "reason", clamp(str(raw.reason), DOCKET_LIMITS.reason));
  return out;
}

export interface RemoteDocket {
  /** Ref component the blob was read from (label, possibly suffixed). */
  ref: string;
  machine: string;
  machine_id: string;
  published_at: string;
  age_secs: number;
  stale: boolean;
  /** True when another docket on origin carries the same machine label. */
  label_collision: boolean;
  decisions: DocketDecision[];
  approvals: DocketApproval[];
  truncated: DocketTruncation;
}

/**
 * Every other machine's docket from the locally fetched refs. Self (by clone
 * id), withdrawn, and expired dockets are excluded; stale ones are kept and
 * flagged. Never throws.
 */
export function readRemoteDockets(
  coordRoot: string,
  opts: { now?: Date; includeSelf?: boolean } = {},
): RemoteDocket[] {
  try {
    const now = (opts.now ?? new Date()).getTime();
    let selfId: string | null = null;
    try {
      selfId = docketMachineId(coordRoot);
    } catch {
      selfId = null;
    }
    const out: RemoteDocket[] = [];
    for (const { machine: ref, message } of readMachineRefs(coordRoot, DOCKET_REF_PREFIX)) {
      const blob = parseDocketBlob(message);
      if (!blob || blob.withdrawn) continue;
      if (!opts.includeSelf && blob.machine_id === selfId) continue;
      const ageSecs = Math.max(0, Math.floor((now - Date.parse(blob.published_at)) / 1000));
      if (ageSecs > DOCKET_EXPIRE_SECS) continue;
      out.push({
        ref,
        machine: blob.machine,
        machine_id: blob.machine_id,
        published_at: blob.published_at,
        age_secs: ageSecs,
        stale: ageSecs > DOCKET_STALE_SECS,
        label_collision: false,
        decisions: blob.decisions,
        approvals: blob.approvals,
        truncated: blob.truncated,
      });
    }
    const byLabel = new Map<string, number>();
    for (const d of out) {
      const key = sanitizeRefComponent(d.machine);
      byLabel.set(key, (byLabel.get(key) ?? 0) + 1);
    }
    for (const d of out)
      d.label_collision = (byLabel.get(sanitizeRefComponent(d.machine)) ?? 0) > 1;
    out.sort((a, b) => a.ref.localeCompare(b.ref));
    return out;
  } catch {
    return [];
  }
}

/** Display label for a remote docket: the machine, disambiguated on collision. */
export function docketSourceLabel(d: RemoteDocket): string {
  return d.label_collision ? `${d.machine} (${d.machine_id.slice(0, 6)})` : d.machine;
}

export interface RemoteDecisionHit {
  decision: DocketDecision;
  source: RemoteDocket;
}

/** Find a decision id in other machines' dockets (freshest copy first). */
export function findRemoteDecision(dockets: RemoteDocket[], id: string): RemoteDecisionHit | null {
  let best: RemoteDecisionHit | null = null;
  for (const source of dockets) {
    const decision = source.decisions.find((d) => d.decision_id === id);
    if (!decision) continue;
    if (!best || source.age_secs < best.source.age_secs) best = { decision, source };
  }
  return best;
}

export interface RemoteApprovalHit {
  approval: DocketApproval;
  source: RemoteDocket;
}

export function findRemoteApproval(dockets: RemoteDocket[], id: string): RemoteApprovalHit | null {
  let best: RemoteApprovalHit | null = null;
  for (const source of dockets) {
    const approval = source.approvals.find((a) => a.id === id);
    if (!approval) continue;
    if (!best || source.age_secs < best.source.age_secs) best = { approval, source };
  }
  return best;
}

/** Case-insensitive substring search over remote decision text. */
export function searchRemoteDecisions(
  dockets: RemoteDocket[],
  query: string,
): Array<RemoteDecisionHit & { where: string; snippet: string }> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const seen = new Set<string>();
  const hits: Array<RemoteDecisionHit & { where: string; snippet: string }> = [];
  const ordered = [...dockets].sort((a, b) => a.age_secs - b.age_secs);
  for (const source of ordered) {
    for (const decision of source.decisions) {
      if (seen.has(decision.decision_id)) continue;
      const fields: Array<[string, string | undefined]> = [
        ["question", decision.question],
        ["context", decision.context],
        ["resolution", decision.resolution_summary],
        ["body", decision.brief],
      ];
      for (const [where, text] of fields) {
        if (!text) continue;
        const idx = text.toLowerCase().indexOf(q);
        if (idx < 0) continue;
        const start = Math.max(0, idx - 40);
        const snippet = text
          .slice(start, idx + q.length + 40)
          .replace(/\s+/g, " ")
          .trim();
        hits.push({ decision, source, where, snippet: `${start > 0 ? "…" : ""}${snippet}…` });
        seen.add(decision.decision_id);
        break;
      }
    }
  }
  return hits;
}

/**
 * The agent name to ping about a remote item: the filer when known, else an
 * agent the presence transport lists on that machine. Null when neither.
 */
export function docketContact(
  filedBy: string | undefined,
  presenceAgents: Array<{ name?: string }> = [],
): string | null {
  if (filedBy) return filedBy;
  for (const a of presenceAgents) if (a.name) return a.name;
  return null;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function clamp(v: string | undefined, max: number): string | undefined {
  if (v === undefined) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

function setIf<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) obj[key] = value;
}
