/**
 * Parser for plan-doc-style council changelogs.
 *
 * The council protocol places a "Plan changelog" section at the bottom of
 * the target doc with entries shaped like:
 *
 *   - 2026-05-26 00:20 CDT · opus-4.7 (Claude Code) · round 4 · summary. Substantive.
 *
 * Plus a members table:
 *
 *   | 1 | agent-Maya    | Opus 4.7     | Claude Code | … |
 *
 * The parser maps each entry to a (round, member) cell via model lookup.
 * Output drives the round-history matrix in the web UI.
 */

import { NO_DATA } from "./format/no-data";

export type ContributionType = "Substantive" | "Trivial" | "Unknown";

export interface ChangelogEntry {
  ts: string;
  model: string;
  harness: string;
  round: number;
  summary: string;
  type: ContributionType;
}

export interface MemberMapping {
  member: string;
  model: string;
  harness: string;
}

export interface MatrixCell {
  member: string;
  entries: ChangelogEntry[];
}

export interface MatrixRound {
  round: number;
  cells: MatrixCell[];
}

export interface ContributionMatrix {
  rounds: MatrixRound[];
  mapping: MemberMapping[];
  unmapped: ChangelogEntry[];
}

export function normalizeModelKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}

export function parseMembersTable(body: string): MemberMapping[] {
  const out: MemberMapping[] = [];
  const rowRe =
    /^\|\s*\d+\s*\|\s*(agent-[A-Za-z][A-Za-z0-9_-]*)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/;
  for (const line of body.split("\n")) {
    const m = line.match(rowRe);
    if (!m) continue;
    out.push({
      member: m[1].trim(),
      model: normalizeModelKey(m[2]),
      harness: m[3].trim(),
    });
  }
  return out;
}

function extractType(text: string): ContributionType {
  const matches = text.match(/\b(Substantive|Trivial)\b/g);
  if (!matches || matches.length === 0) return "Unknown";
  return matches[matches.length - 1] as ContributionType;
}

export function parseChangelog(body: string): ChangelogEntry[] {
  const lines = body.split("\n");
  let inChangelog = false;
  const out: ChangelogEntry[] = [];
  for (const line of lines) {
    if (/^##\s+.*changelog/i.test(line)) {
      inChangelog = true;
      continue;
    }
    if (inChangelog && /^##\s+/.test(line)) {
      break;
    }
    if (!inChangelog) continue;
    const m = line.match(/^-\s+(.+)$/);
    if (!m) continue;
    const entry = m[1];
    const parts = entry.split(" · ");
    if (parts.length < 4) continue;
    const ts = parts[0].trim();
    const modelHarness = parts[1].match(/^([^\s(][^()]*?)\s*\(([^)]+)\)\s*$/);
    if (!modelHarness) continue;
    const model = normalizeModelKey(modelHarness[1]);
    const harness = modelHarness[2].trim();
    const roundMatch = parts[2].match(/^round\s+(\d+)$/i);
    if (!roundMatch) continue;
    const round = Number.parseInt(roundMatch[1], 10);
    if (!Number.isFinite(round)) continue;
    const summary = parts.slice(3).join(" · ").trim();
    const type = extractType(summary);
    out.push({ ts, model, harness, round, summary, type });
  }
  return out;
}

export function buildContributionMatrix(
  manifestMembers: string[],
  manifestCurrentRound: number,
  targetDocBody: string | null,
): ContributionMatrix {
  if (!targetDocBody) {
    return { rounds: [], mapping: [], unmapped: [] };
  }
  const mapping = parseMembersTable(targetDocBody);
  const entries = parseChangelog(targetDocBody);
  const modelToMember = new Map<string, string>();
  for (const m of mapping) modelToMember.set(m.model, m.member);
  const byRound = new Map<number, Map<string, ChangelogEntry[]>>();
  const unmapped: ChangelogEntry[] = [];
  for (const e of entries) {
    const member = modelToMember.get(e.model);
    if (!member) {
      unmapped.push(e);
      continue;
    }
    let r = byRound.get(e.round);
    if (!r) {
      r = new Map();
      byRound.set(e.round, r);
    }
    const arr = r.get(member) ?? [];
    arr.push(e);
    r.set(member, arr);
  }
  const maxRound = Math.max(manifestCurrentRound, ...Array.from(byRound.keys()), 0);
  const rounds: MatrixRound[] = [];
  for (let r = 1; r <= maxRound; r++) {
    const cells: MatrixCell[] = manifestMembers.map((member) => ({
      member,
      entries: byRound.get(r)?.get(member) ?? [],
    }));
    rounds.push({ round: r, cells });
  }
  return { rounds, mapping, unmapped };
}

export function countConsecutiveAllTrivialRounds(matrix: ContributionMatrix): number {
  const roundTotal = (i: number): number => {
    let total = 0;
    for (const cell of matrix.rounds[i].cells) total += cell.entries.length;
    return total;
  };
  // Trailing empty rounds are open/in-progress (the matrix spans 1..current_round),
  // so skip them so advancing past the finish line doesn't zero the streak. An
  // interior empty round still breaks the walk below.
  let i = matrix.rounds.length - 1;
  while (i >= 0 && roundTotal(i) === 0) i--;
  let count = 0;
  for (; i >= 0; i--) {
    const row = matrix.rounds[i];
    let total = 0;
    let substantive = 0;
    for (const cell of row.cells) {
      for (const entry of cell.entries) {
        total++;
        if (entry.type === "Substantive") substantive++;
      }
    }
    if (total === 0) break;
    if (substantive > 0) break;
    count++;
  }
  return count;
}

export function formatDuration(startIso: string, endIso: string): string {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return NO_DATA;
  const totalSec = Math.floor((end - start) / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}
