/**
 * Decision docket: a persistent queue of decisions an agent would otherwise
 * route to a human, plus the lifecycle that carries each one from filing to a
 * reviewed, graduated resolution.
 *
 * State layout (mirrors councils):
 *   - `.harnery/decisions/<id>.json`      — one manifest per decision
 *   - `.harnery/decisions/<id>/`          — long-form bodies (brief, options,
 *                                            evidence write-up) as markdown
 *   - `.harnery/decisions/archive/`       — graduated / terminal decisions move here
 *
 * This module is the engine only. It stores `tier` (0/1/2) and `stakes` as
 * opaque typed fields; what those *mean* — which decisions belong to which
 * tier — is host policy, applied by the filing agent, never encoded here. That
 * keeps the docket generic across host projects.
 *
 * Every function takes `coordRoot` explicitly (the council pattern) so the
 * state machine is trivially testable against a tmpdir. The command layer
 * resolves the root once via `monorepoRoot()` and threads it down.
 *
 * Concurrency: one file per decision (no shared index to contend on) + atomic
 * temp→rename writes. `claim` is last-writer-wins — deliberating the same
 * decision twice wastes tokens, not correctness.
 */

import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const DECISION_SCHEMA_VERSION = 1 as const;

/** Tier of human-involvement. Meaning is host policy; the engine only stores it. */
export const DECISION_TIERS = [0, 1, 2] as const;
export type DecisionTier = (typeof DECISION_TIERS)[number];

export const DECISION_STAKES = ["small", "medium", "high"] as const;
export type DecisionStakes = (typeof DECISION_STAKES)[number];

export const DECISION_STATUSES = [
  "filed",
  "triaged",
  "deliberating",
  "resolved",
  "enacted",
  "reviewed",
  "archived",
  "superseded",
  "wontfix",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const REVIEW_VERDICTS = [
  "ratified",
  "overridden",
  "wrong-tier-high",
  "wrong-tier-low",
] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const TERMINAL_STATUSES: readonly DecisionStatus[] = ["archived", "superseded", "wontfix"];

/**
 * Legal status transitions. `superseded` is reachable from any non-terminal
 * state (a decision can be obsoleted at any point); `wontfix` closes an
 * un-deliberated decision. `deliberating → triaged` allows the sweeper to
 * re-triage a decision's tier on first touch (the self-triage safeguard).
 */
export const LEGAL_TRANSITIONS: Record<DecisionStatus, readonly DecisionStatus[]> = {
  filed: ["triaged", "deliberating", "resolved", "superseded", "wontfix"],
  triaged: ["deliberating", "resolved", "superseded", "wontfix"],
  deliberating: ["triaged", "resolved", "superseded", "wontfix"],
  resolved: ["enacted", "reviewed", "superseded"],
  enacted: ["reviewed", "superseded"],
  reviewed: ["archived", "superseded"],
  archived: [],
  superseded: [],
  wontfix: [],
};

export interface DecisionResolution {
  recommendation: string;
  confidence?: string;
  reversal_cost?: string;
  /** What would make this resolution wrong (the pre-mortem). */
  wrong_if?: string;
  /** When this should be revisited (a trigger, not a date). */
  revisit_when?: string;
  /** Citations: queries run, files read, costs computed. Required (≥1). */
  evidence: string[];
  resolved_by: string;
  resolved_at: string;
}

export interface DecisionReview {
  verdict: ReviewVerdict;
  note?: string;
  reviewed_at: string;
}

export interface DecisionManifest {
  schema_version: typeof DECISION_SCHEMA_VERSION;
  decision_id: string;
  status: DecisionStatus;
  /** Provisional at file time; the sweeper may re-check on claim. */
  tier: DecisionTier;
  stakes: DecisionStakes;
  question: string;
  context?: string;
  /** What the filer proceeded with under always-proceed (tier 0/1), or null. */
  default_taken?: string | null;
  /** Agent name (e.g. "agent-Quill"), for display. */
  filed_by?: string;
  /** Filer instance_id. */
  filed_by_id?: string;
  filed_at: string;
  /** Deliberator (agent instance_id or a sweeper session), or null. */
  claimed_by?: string | null;
  /** Set when escalated to a council. */
  council_id?: string | null;
  resolution?: DecisionResolution | null;
  review?: DecisionReview | null;
  /** Where the resolved output graduated (e.g. "docs/decisions.md#…"), or null. */
  graduated_to?: string | null;
  /** Set when superseded by another decision. */
  superseded_by?: string | null;
  /** Reason recorded on wontfix. */
  wontfix_reason?: string | null;
  updated_at?: string;
  [extra: string]: unknown;
}

export interface DecisionOpResult {
  ok: boolean;
  reason?: string;
  manifest?: DecisionManifest;
}

// ─── Type guards ────────────────────────────────────────────────────────────

export function isTier(n: unknown): n is DecisionTier {
  return (DECISION_TIERS as readonly unknown[]).includes(n);
}

export function isStakes(s: unknown): s is DecisionStakes {
  return typeof s === "string" && (DECISION_STAKES as readonly string[]).includes(s);
}

export function isStatus(s: unknown): s is DecisionStatus {
  return typeof s === "string" && (DECISION_STATUSES as readonly string[]).includes(s);
}

export function isVerdict(v: unknown): v is ReviewVerdict {
  return typeof v === "string" && (REVIEW_VERDICTS as readonly string[]).includes(v);
}

export function isTerminal(status: DecisionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: DecisionStatus, to: DecisionStatus): boolean {
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

// ─── Paths ──────────────────────────────────────────────────────────────────

export function decisionsDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "decisions");
}

export function archiveDir(coordRoot: string): string {
  return join(decisionsDir(coordRoot), "archive");
}

export function manifestPath(coordRoot: string, id: string): string {
  return join(decisionsDir(coordRoot), `${id}.json`);
}

export function archivedManifestPath(coordRoot: string, id: string): string {
  return join(archiveDir(coordRoot), `${id}.json`);
}

export function decisionBodyDir(coordRoot: string, id: string): string {
  return join(decisionsDir(coordRoot), id);
}

// ─── Low-level IO ─────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/**
 * Kebab-case slug from question text: first 5 words, lowercased,
 * non-alphanumerics stripped. Local (not imported from council) so the module
 * stays standalone.
 */
export function deriveSlug(question: string): string {
  const cleaned = question
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "decision";
}

/**
 * Build a decision_id: `<slug>-<YYYY-MM-DD>-<4hex>`. The hex suffix is
 * crypto-random (not a hash of the question) so two decisions sharing a
 * slug + date don't collide.
 */
export function buildDecisionId(question: string, now: Date = new Date()): string {
  const slug = deriveSlug(question);
  const date = now.toISOString().slice(0, 10);
  const hash = randomBytes(2).toString("hex");
  return `${slug}-${date}-${hash}`;
}

/**
 * Read a manifest by id, checking the active dir then the archive. Returns null
 * if absent or unparseable. Throws on an unsupported schema_version (fail loud
 * on a real-but-incompatible manifest, the way councils do).
 */
export function readManifest(coordRoot: string, id: string): DecisionManifest | null {
  for (const p of [manifestPath(coordRoot, id), archivedManifestPath(coordRoot, id)]) {
    if (!existsSync(p)) continue;
    const parsed = JSON.parse(readFileSync(p, "utf8")) as DecisionManifest;
    if (parsed.schema_version !== DECISION_SCHEMA_VERSION) {
      throw new Error(
        `decision ${id}: unsupported schema_version=${parsed.schema_version} (expected ${DECISION_SCHEMA_VERSION})`,
      );
    }
    return parsed;
  }
  return null;
}

/** Locate whichever manifest path (active or archive) currently holds this id. */
function resolveManifestPath(coordRoot: string, id: string): string | null {
  const active = manifestPath(coordRoot, id);
  if (existsSync(active)) return active;
  const archived = archivedManifestPath(coordRoot, id);
  if (existsSync(archived)) return archived;
  return null;
}

export function writeManifest(coordRoot: string, manifest: DecisionManifest): void {
  const p =
    resolveManifestPath(coordRoot, manifest.decision_id) ??
    manifestPath(coordRoot, manifest.decision_id);
  atomicWriteText(p, `${JSON.stringify(manifest, null, 2)}\n`);
}

// ─── Filing ───────────────────────────────────────────────────────────────────

export interface FileDecisionInput {
  question: string;
  tier: DecisionTier;
  stakes: DecisionStakes;
  context?: string;
  defaultTaken?: string;
  filedBy?: string;
  filedById?: string;
  /** Long-form brief written to `<id>/brief.md`. */
  brief?: string;
  now?: Date;
}

export function fileDecision(coordRoot: string, input: FileDecisionInput): DecisionOpResult {
  if (!input.question?.trim()) return { ok: false, reason: "question is empty" };
  if (!isTier(input.tier)) return { ok: false, reason: `invalid tier ${input.tier} (0 | 1 | 2)` };
  if (!isStakes(input.stakes)) {
    return {
      ok: false,
      reason: `invalid stakes "${input.stakes}" (${DECISION_STAKES.join(" | ")})`,
    };
  }
  const now = input.now ?? new Date();
  const id = buildDecisionId(input.question, now);
  const ts = now.toISOString();
  const manifest: DecisionManifest = {
    schema_version: DECISION_SCHEMA_VERSION,
    decision_id: id,
    status: "filed",
    tier: input.tier,
    stakes: input.stakes,
    question: input.question.trim(),
    context: input.context?.trim() || undefined,
    default_taken: input.defaultTaken?.trim() || null,
    filed_by: input.filedBy,
    filed_by_id: input.filedById,
    filed_at: ts,
    claimed_by: null,
    council_id: null,
    resolution: null,
    review: null,
    graduated_to: null,
    superseded_by: null,
    wontfix_reason: null,
    updated_at: ts,
  };
  atomicWriteText(manifestPath(coordRoot, id), `${JSON.stringify(manifest, null, 2)}\n`);
  if (input.brief?.trim()) {
    atomicWriteText(join(decisionBodyDir(coordRoot, id), "brief.md"), `${input.brief.trim()}\n`);
  }
  return { ok: true, manifest };
}

// ─── Transitions ───────────────────────────────────────────────────────────────

/**
 * Apply a status change with legality + terminality checks, stamp updated_at,
 * merge extra field patches, and persist. The single mutation chokepoint.
 */
function transition(
  coordRoot: string,
  id: string,
  to: DecisionStatus,
  patch: Partial<DecisionManifest> = {},
): DecisionOpResult {
  const manifest = readManifest(coordRoot, id);
  if (!manifest) return { ok: false, reason: `no decision "${id}"` };
  if (isTerminal(manifest.status) && manifest.status !== to) {
    return { ok: false, reason: `decision is ${manifest.status} (terminal, read-only)` };
  }
  if (manifest.status !== to && !canTransition(manifest.status, to)) {
    return {
      ok: false,
      reason: `illegal transition ${manifest.status} → ${to} (legal: ${(LEGAL_TRANSITIONS[manifest.status] ?? []).join(", ") || "none"})`,
    };
  }
  const updated: DecisionManifest = {
    ...manifest,
    ...patch,
    status: to,
    updated_at: nowIso(),
  };
  writeManifest(coordRoot, updated);
  return { ok: true, manifest: updated };
}

export function triageDecision(
  coordRoot: string,
  id: string,
  opts: { tier?: DecisionTier; stakes?: DecisionStakes },
): DecisionOpResult {
  if (opts.tier !== undefined && !isTier(opts.tier)) {
    return { ok: false, reason: `invalid tier ${opts.tier} (0 | 1 | 2)` };
  }
  if (opts.stakes !== undefined && !isStakes(opts.stakes)) {
    return {
      ok: false,
      reason: `invalid stakes "${opts.stakes}" (${DECISION_STAKES.join(" | ")})`,
    };
  }
  const patch: Partial<DecisionManifest> = {};
  if (opts.tier !== undefined) patch.tier = opts.tier;
  if (opts.stakes !== undefined) patch.stakes = opts.stakes;
  return transition(coordRoot, id, "triaged", patch);
}

export function claimDecision(coordRoot: string, id: string, owner: string): DecisionOpResult {
  if (!owner?.trim()) return { ok: false, reason: "claim owner is empty" };
  return transition(coordRoot, id, "deliberating", { claimed_by: owner.trim() });
}

export function escalateToCouncil(
  coordRoot: string,
  id: string,
  councilId: string,
): DecisionOpResult {
  if (!councilId?.trim()) return { ok: false, reason: "council id is empty" };
  return transition(coordRoot, id, "deliberating", { council_id: councilId.trim() });
}

/**
 * Resolve a decision. Evidence is required (≥1 citation): a resolution with no
 * cited evidence is structurally incomplete and bounced here — the same guard
 * the sweeper enforces.
 */
export function resolveDecision(
  coordRoot: string,
  id: string,
  resolution: Omit<DecisionResolution, "resolved_at"> & { resolved_at?: string },
): DecisionOpResult {
  if (!resolution.recommendation?.trim()) {
    return { ok: false, reason: "resolution requires a recommendation" };
  }
  const evidence = (resolution.evidence ?? []).map((e) => e.trim()).filter(Boolean);
  if (evidence.length === 0) {
    return {
      ok: false,
      reason:
        "resolution requires ≥1 evidence citation (queries run, files read, costs computed) — an evidence-free resolution is bounced",
    };
  }
  if (!resolution.resolved_by?.trim()) {
    return { ok: false, reason: "resolution requires resolved_by" };
  }
  const full: DecisionResolution = {
    recommendation: resolution.recommendation.trim(),
    confidence: resolution.confidence?.trim() || undefined,
    reversal_cost: resolution.reversal_cost?.trim() || undefined,
    wrong_if: resolution.wrong_if?.trim() || undefined,
    revisit_when: resolution.revisit_when?.trim() || undefined,
    evidence,
    resolved_by: resolution.resolved_by.trim(),
    resolved_at: resolution.resolved_at ?? nowIso(),
  };
  return transition(coordRoot, id, "resolved", { resolution: full });
}

export function enactDecision(coordRoot: string, id: string): DecisionOpResult {
  return transition(coordRoot, id, "enacted");
}

export function reviewDecision(
  coordRoot: string,
  id: string,
  opts: { verdict: ReviewVerdict; note?: string },
): DecisionOpResult {
  if (!isVerdict(opts.verdict)) {
    return {
      ok: false,
      reason: `invalid verdict "${opts.verdict}" (${REVIEW_VERDICTS.join(" | ")})`,
    };
  }
  const review: DecisionReview = {
    verdict: opts.verdict,
    note: opts.note?.trim() || undefined,
    reviewed_at: nowIso(),
  };
  return transition(coordRoot, id, "reviewed", { review });
}

export function supersedeDecision(
  coordRoot: string,
  id: string,
  bySupersedingId?: string,
): DecisionOpResult {
  return transition(coordRoot, id, "superseded", {
    superseded_by: bySupersedingId?.trim() || null,
  });
}

export function wontfixDecision(coordRoot: string, id: string, reason?: string): DecisionOpResult {
  return transition(coordRoot, id, "wontfix", { wontfix_reason: reason?.trim() || null });
}

/**
 * Archive a decision (terminal). Records where its output graduated, then moves
 * manifest + body dir into `archive/`. Idempotent-ish: safe to re-run.
 */
export function archiveDecision(
  coordRoot: string,
  id: string,
  graduatedTo?: string,
): DecisionOpResult {
  const result = transition(coordRoot, id, "archived", {
    graduated_to: graduatedTo?.trim() || null,
  });
  if (!result.ok) return result;

  const activeManifest = manifestPath(coordRoot, id);
  const archivedManifest = archivedManifestPath(coordRoot, id);
  const activeBody = decisionBodyDir(coordRoot, id);
  const archivedBody = join(archiveDir(coordRoot), id);

  mkdirSync(archiveDir(coordRoot), { recursive: true });
  if (existsSync(activeManifest)) {
    try {
      renameSync(activeManifest, archivedManifest);
    } catch {
      cpSync(activeManifest, archivedManifest);
      rmSync(activeManifest, { force: true });
    }
  }
  if (existsSync(activeBody)) {
    if (existsSync(archivedBody)) {
      rmSync(activeBody, { recursive: true, force: true });
    } else {
      try {
        renameSync(activeBody, archivedBody);
      } catch {
        cpSync(activeBody, archivedBody, { recursive: true });
        rmSync(activeBody, { recursive: true, force: true });
      }
    }
  }
  return result;
}

/**
 * Reopen an archived decision back to `reviewed` — the inverse of `archive`,
 * and the one sanctioned way out of the (otherwise terminal) archived state.
 * Since `archived` has no legal outgoing transition, this deliberately bypasses
 * the `transition` guard, the same way `archive` does its file moves outside it.
 * Moves the manifest + body dir back from `archive/` into the active dir and
 * clears `graduated_to` (a re-archive sets it fresh). Only `archived` decisions
 * reopen; `superseded`/`wontfix` stay terminal.
 *
 * Ordering is write-active-then-remove-archived so an interrupted call leaves
 * the decision reopened (active copy wins in `readManifest`) rather than lost.
 */
export function reopenDecision(coordRoot: string, id: string): DecisionOpResult {
  const manifest = readManifest(coordRoot, id);
  if (!manifest) return { ok: false, reason: `no decision "${id}"` };
  if (manifest.status !== "archived") {
    return {
      ok: false,
      reason: `only archived decisions can be reopened (this is ${manifest.status})`,
    };
  }

  const archivedBody = join(archiveDir(coordRoot), id);
  const activeBody = decisionBodyDir(coordRoot, id);
  if (existsSync(archivedBody)) {
    if (existsSync(activeBody)) {
      rmSync(archivedBody, { recursive: true, force: true });
    } else {
      try {
        renameSync(archivedBody, activeBody);
      } catch {
        cpSync(archivedBody, activeBody, { recursive: true });
        rmSync(archivedBody, { recursive: true, force: true });
      }
    }
  }

  const reopened: DecisionManifest = {
    ...manifest,
    status: "reviewed",
    graduated_to: null,
    updated_at: nowIso(),
  };
  atomicWriteText(manifestPath(coordRoot, id), `${JSON.stringify(reopened, null, 2)}\n`);
  const archived = archivedManifestPath(coordRoot, id);
  if (existsSync(archived)) rmSync(archived, { force: true });
  return { ok: true, manifest: reopened };
}

// ─── Read / query ─────────────────────────────────────────────────────────────

export interface ListFilter {
  status?: DecisionStatus;
  tier?: DecisionTier;
  stakes?: DecisionStakes;
  /** Only non-terminal decisions (the live queue). */
  openOnly?: boolean;
  /** Include the archive dir in the scan (default: active only). */
  includeArchived?: boolean;
}

function scanManifests(dir: string): DecisionManifest[] {
  if (!existsSync(dir)) return [];
  const out: DecisionManifest[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    try {
      if (!statSync(p).isFile()) continue;
      const parsed = JSON.parse(readFileSync(p, "utf8")) as DecisionManifest;
      if (parsed.schema_version !== DECISION_SCHEMA_VERSION) continue;
      out.push(parsed);
    } catch {
      // skip unparseable manifest; one bad file never kills the scan
    }
  }
  return out;
}

export function listDecisions(coordRoot: string, filter: ListFilter = {}): DecisionManifest[] {
  let rows = scanManifests(decisionsDir(coordRoot));
  if (filter.includeArchived) rows = rows.concat(scanManifests(archiveDir(coordRoot)));
  if (filter.status) rows = rows.filter((d) => d.status === filter.status);
  if (filter.tier !== undefined) rows = rows.filter((d) => d.tier === filter.tier);
  if (filter.stakes) rows = rows.filter((d) => d.stakes === filter.stakes);
  if (filter.openOnly) rows = rows.filter((d) => !isTerminal(d.status));
  rows.sort((a, b) => (b.filed_at ?? "").localeCompare(a.filed_at ?? ""));
  return rows;
}

export interface DecisionDetail {
  manifest: DecisionManifest;
  bodies: { name: string; content: string }[];
  archived: boolean;
}

export function showDecision(coordRoot: string, id: string): DecisionDetail | null {
  const manifest = readManifest(coordRoot, id);
  if (!manifest) return null;
  const archived = !existsSync(manifestPath(coordRoot, id));
  const bodyDir = archived ? join(archiveDir(coordRoot), id) : decisionBodyDir(coordRoot, id);
  const bodies: { name: string; content: string }[] = [];
  if (existsSync(bodyDir)) {
    for (const f of readdirSync(bodyDir)) {
      if (!f.endsWith(".md")) continue;
      try {
        bodies.push({ name: f, content: readFileSync(join(bodyDir, f), "utf8") });
      } catch {
        // skip unreadable body
      }
    }
  }
  return { manifest, bodies, archived };
}

export interface SearchHit {
  manifest: DecisionManifest;
  /** A short surrounding snippet of the first match. */
  snippet: string;
  /** Where the match landed. */
  where: "question" | "context" | "resolution" | "body";
}

/**
 * Case-insensitive substring search over manifests + bodies. Deliberately
 * dumb: precedent recall depends on the host's decision skill running this before
 * filing, not on ranking sophistication. Includes the archive (precedent
 * lives there).
 */
export function searchDecisions(coordRoot: string, query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const all = listDecisions(coordRoot, { includeArchived: true });
  const hits: SearchHit[] = [];
  for (const manifest of all) {
    const fields: { where: SearchHit["where"]; text: string }[] = [
      { where: "question", text: manifest.question ?? "" },
      { where: "context", text: manifest.context ?? "" },
      {
        where: "resolution",
        text: manifest.resolution
          ? `${manifest.resolution.recommendation} ${manifest.resolution.evidence.join(" ")}`
          : "",
      },
    ];
    const bodyDir = existsSync(manifestPath(coordRoot, manifest.decision_id))
      ? decisionBodyDir(coordRoot, manifest.decision_id)
      : join(archiveDir(coordRoot), manifest.decision_id);
    if (existsSync(bodyDir)) {
      for (const f of readdirSync(bodyDir)) {
        if (!f.endsWith(".md")) continue;
        try {
          fields.push({ where: "body", text: readFileSync(join(bodyDir, f), "utf8") });
        } catch {
          // skip
        }
      }
    }
    for (const field of fields) {
      const idx = field.text.toLowerCase().indexOf(q);
      if (idx >= 0) {
        const start = Math.max(0, idx - 40);
        const snippet = field.text
          .slice(start, idx + q.length + 40)
          .replace(/\s+/g, " ")
          .trim();
        hits.push({ manifest, snippet: `${start > 0 ? "…" : ""}${snippet}…`, where: field.where });
        break;
      }
    }
  }
  return hits;
}
