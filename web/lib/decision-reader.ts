/**
 * Read-side for the decision docket. RSC pages read `.harnery/decisions/`
 * directly via fs (per request), mirroring how coord-reader reads councils.
 * The manifest shape is defined locally (not imported from the engine's src)
 * to match coord-reader's self-contained convention.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { coordRoot } from "./coord-reader";

export type DecisionTier = 0 | 1 | 2;
export type DecisionStakes = "small" | "medium" | "high";
export type DecisionStatus =
  | "filed"
  | "triaged"
  | "deliberating"
  | "resolved"
  | "enacted"
  | "reviewed"
  | "archived"
  | "superseded"
  | "wontfix";
export type ReviewVerdict = "ratified" | "overridden" | "wrong-tier-high" | "wrong-tier-low";

export interface DecisionResolution {
  recommendation: string;
  confidence?: string;
  reversal_cost?: string;
  wrong_if?: string;
  revisit_when?: string;
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
  schema_version: number;
  decision_id: string;
  status: DecisionStatus;
  tier: DecisionTier;
  stakes: DecisionStakes;
  question: string;
  context?: string;
  default_taken?: string | null;
  filed_by?: string;
  filed_by_id?: string;
  filed_at: string;
  claimed_by?: string | null;
  council_id?: string | null;
  resolution?: DecisionResolution | null;
  review?: DecisionReview | null;
  graduated_to?: string | null;
  superseded_by?: string | null;
  wontfix_reason?: string | null;
  updated_at?: string;
}

const TERMINAL: readonly DecisionStatus[] = ["archived", "superseded", "wontfix"];
export function isTerminal(s: DecisionStatus): boolean {
  return TERMINAL.includes(s);
}

export function decisionsDir(): string {
  return path.join(coordRoot(), ".harnery", "decisions");
}
function archiveDir(): string {
  return path.join(decisionsDir(), "archive");
}

const SCHEMA_VERSION = 1;

function scan(dir: string): DecisionManifest[] {
  if (!existsSync(dir)) return [];
  const out: DecisionManifest[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const p = path.join(dir, f);
    try {
      if (!statSync(p).isFile()) continue;
      const parsed = JSON.parse(readFileSync(p, "utf8")) as DecisionManifest;
      if (parsed.schema_version !== SCHEMA_VERSION) continue;
      out.push(parsed);
    } catch {
      // skip an unparseable manifest; one bad file never kills the scan
    }
  }
  return out;
}

export interface DecisionsSnapshot {
  /** Tier 2, filed and unresolved: the only entries where work is actually
   * stopped pending a human. Kept apart from `queue` because everything else on
   * this page has already proceeded on a default, and mixing the two teaches the
   * reader to skim past the one class that is blocking. */
  waiting: DecisionManifest[];
  /** Non-terminal, not yet resolved, tier 0-1 (the live queue): filed / triaged
   * / deliberating. Work carried on regardless; these are here for precedent. */
  queue: DecisionManifest[];
  /** Resolved or enacted but not yet reviewed (the review feed). */
  review: DecisionManifest[];
  /** Reviewed but not archived. */
  reviewed: DecisionManifest[];
  /** Archived + superseded + wontfix (terminal). */
  closed: DecisionManifest[];
  meta: { count: number };
}

function byFiledDesc(a: DecisionManifest, b: DecisionManifest): number {
  return (b.filed_at ?? "").localeCompare(a.filed_at ?? "");
}

const WAITING_STAKES_RANK: Record<string, number> = { high: 3, medium: 2, small: 1 };

function byStakesThenAge(a: DecisionManifest, b: DecisionManifest): number {
  const rank = (WAITING_STAKES_RANK[b.stakes] ?? 1) - (WAITING_STAKES_RANK[a.stakes] ?? 1);
  return rank !== 0 ? rank : (a.filed_at ?? "").localeCompare(b.filed_at ?? "");
}

export function readDecisions(): DecisionsSnapshot {
  const active = scan(decisionsDir());
  const archived = scan(archiveDir());
  const all = [...active, ...archived];

  const open = active.filter(
    (d) => d.status === "filed" || d.status === "triaged" || d.status === "deliberating",
  );
  // Highest stakes first, longest-open breaking ties. Stakes leads because it is
  // the filer's own triage signal; age is the tiebreak rather than the primary
  // key so a decision filed an hour ago at high stakes is not buried under old
  // small ones. Neglect still shows regardless of position: the card carries how
  // long it has been open, and a three-week badge is visible anywhere in a list.
  const waiting = open.filter((d) => d.tier === 2).sort(byStakesThenAge);
  const queue = open.filter((d) => d.tier !== 2).sort(byFiledDesc);
  const review = active
    .filter((d) => d.status === "resolved" || d.status === "enacted")
    .sort(byFiledDesc);
  const reviewed = active.filter((d) => d.status === "reviewed").sort(byFiledDesc);
  const closed = [...active.filter((d) => isTerminal(d.status)), ...archived].sort(byFiledDesc);

  return { waiting, queue, review, reviewed, closed, meta: { count: all.length } };
}

export interface DecisionDetail {
  manifest: DecisionManifest;
  bodies: { name: string; content: string }[];
  archived: boolean;
}

export function readDecision(id: string): DecisionDetail | null {
  const activePath = path.join(decisionsDir(), `${id}.json`);
  const archivedPath = path.join(archiveDir(), `${id}.json`);
  let manifestPath: string | null = null;
  let archived = false;
  if (existsSync(activePath)) {
    manifestPath = activePath;
  } else if (existsSync(archivedPath)) {
    manifestPath = archivedPath;
    archived = true;
  }
  if (!manifestPath) return null;

  let manifest: DecisionManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DecisionManifest;
  } catch {
    return null;
  }

  const bodyDir = archived ? path.join(archiveDir(), id) : path.join(decisionsDir(), id);
  const bodies: { name: string; content: string }[] = [];
  if (existsSync(bodyDir)) {
    for (const f of readdirSync(bodyDir)) {
      if (!f.endsWith(".md")) continue;
      try {
        bodies.push({ name: f, content: readFileSync(path.join(bodyDir, f), "utf8") });
      } catch {
        // skip unreadable body
      }
    }
  }
  return { manifest, bodies, archived };
}
