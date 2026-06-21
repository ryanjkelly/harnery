/**
 * UserPromptSubmit UX renderer. Combines the peer-refresh dedup, the
 * council-pending hash-dedup, and the Cursor set-task staleness nudge.
 * agent-hook's user_prompt.submit post-emit handler calls this
 * and forwards the result as the harness-shaped additionalContext payload.
 *
 * Three hash-dedup'd subsections combined into one additionalContext payload:
 *   1. Peer table: semantically-relevant peer fields hashed; only re-emits
 *      when peers change (name + instance_id + session_id + kind + started_at
 *      + sorted(files_touched) + platform, sorted by instance_id).
 *   2. Council pending: pending open-council IDs hashed; re-emits when the
 *      ID set changes.
 *   3. Task staleness nudge (cursor only, since CC enforces via the Stop hook
 *      transcript scan). Fires when `task` is null or `task_updated_at` is
 *      older than HARNERY_TASK_STALE_SECONDS (default 1800 = 30 min). Hash-deduped
 *      against the previous nudge state.
 *
 * Hash files live at:
 *   .harnery/.last-peer-hash.<instance_id>
 *   .harnery/.last-council-hash.<instance_id>
 *   .harnery/.last-task-nudge-hash.<instance_id>
 *
 * First call always emits (hash files don't exist).
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { coordEnv } from "../../../lib/env.ts";
import { formatPendingCouncils } from "./session-context.ts";

interface HeartbeatRow {
  instance_id?: string;
  name?: string;
  kind?: string;
  session_id?: string;
  started_at?: string;
  last_heartbeat?: string;
  last_tool?: string;
  last_tool_target?: string;
  files_touched?: string[];
  platform?: string;
  task?: string;
  turn_summary?: string;
}

export interface PromptContextOpts {
  coordRoot: string;
  instanceId: string;
  sessionId: string;
  agentName?: string;
  /** When true, run the task-staleness nudge check (cursor only; CC has the
   * Stop-hook transcript-scan enforcement). */
  taskNudge?: boolean;
}

/**
 * Build the combined UserPromptSubmit additionalContext string. Returns "" when
 * nothing has changed since the last call (so the caller can skip the JSON emit).
 *
 * Side effects: updates `.harnery/.last-peer-hash.<id>` and `.harnery/.last-council-hash.<id>`
 * when their respective sections re-emit (or removes the council hash when no
 * councils are pending, matching the bash behavior).
 */
export function renderPromptContext(opts: PromptContextOpts): string {
  const { coordRoot, instanceId, sessionId, agentName, taskNudge } = opts;
  const sections: string[] = [];

  // 1. Peer table with hash dedup.
  const peerTable = computePeerTableIfChanged(coordRoot, instanceId, sessionId);
  if (peerTable) sections.push(peerTable);

  // 2. Council pending with hash dedup.
  if (agentName) {
    const councilMsg = computeCouncilPendingIfChanged(coordRoot, instanceId, agentName);
    if (councilMsg) sections.push(councilMsg);
  }

  // 3. Task staleness nudge (cursor only).
  if (taskNudge) {
    const nudgeMsg = computeTaskNudgeIfChanged(coordRoot, instanceId);
    if (nudgeMsg) sections.push(nudgeMsg);
  }

  return sections.join("\n\n");
}

/** The set-task staleness nudge for Cursor.
 * Emits a one-line reminder when `task` is null or `task_updated_at` is older
 * than HARNERY_TASK_STALE_SECONDS (default 1800). Hash-deduped against previous
 * nudge state. */
function computeTaskNudgeIfChanged(coordRoot: string, selfInstanceId: string): string {
  const hbPath = join(coordRoot, ".harnery", "active", `${selfInstanceId}.json`);
  if (!existsSync(hbPath)) return "";
  let hb: { task?: string; task_updated_at?: string };
  try {
    hb = JSON.parse(readFileSync(hbPath, "utf8"));
  } catch {
    return "";
  }

  const threshold = Number.parseInt(coordEnv("TASK_STALE_SECONDS") ?? "1800", 10);
  const taskValue = hb.task ?? "";
  let needsNudge = false;
  let message = "";

  if (!taskValue) {
    needsNudge = true;
    message =
      "Heads up: your `task` field is unset. Run `agents set-task \"<short focus>\"` so peers + the coord dashboard can see what you're working on. (Cursor sessions can't enforce this from the Stop hook the way Claude Code does, so this is a one-time soft reminder per staleness state.)";
  } else if (hb.task_updated_at) {
    const updatedSec = Math.floor(Date.parse(hb.task_updated_at) / 1000);
    const nowSec = Math.floor(Date.now() / 1000);
    if (Number.isFinite(updatedSec) && updatedSec > 0) {
      const ageSec = nowSec - updatedSec;
      if (ageSec > threshold) {
        needsNudge = true;
        message = `Heads up: your \`task\` field hasn't changed in ${ageSec}s (threshold ${threshold}s). If you've moved on from "${taskValue.slice(0, 60)}", update via \`agents set-task "<new focus>"\`. Pass an empty string to clear.`;
      }
    }
  }

  const hashFile = join(coordRoot, ".harnery", `.last-task-nudge-hash.${selfInstanceId}`);
  if (!needsNudge) {
    try {
      if (existsSync(hashFile)) rmSync(hashFile, { force: true });
    } catch {
      /* swallow */
    }
    return "";
  }

  // Dedup on a state-hash (task value + threshold) so same-state turns don't re-nudge.
  const state = `${taskValue}|stale=1|threshold=${threshold}`;
  const newHash = sha256Hex16(state);
  const oldHash = safeRead(hashFile);
  if (oldHash && oldHash === newHash) return "";
  writeHashFile(hashFile, newHash);
  return message;
}

function computePeerTableIfChanged(
  coordRoot: string,
  selfInstanceId: string,
  selfSessionIdFallback: string,
): string {
  const activeDir = join(coordRoot, ".harnery", "active");
  if (!existsSync(activeDir)) return "";

  // Read self heartbeat for session_id (group key); fall back to the caller's hint.
  let mySessionId = selfSessionIdFallback;
  const selfHb = readHeartbeat(join(activeDir, `${selfInstanceId}.json`));
  if (selfHb?.session_id) mySessionId = selfHb.session_id;
  if (!mySessionId) return "";

  // Collect peer heartbeats.
  const peers: HeartbeatRow[] = [];
  for (const f of readdirSync(activeDir)) {
    if (!f.endsWith(".json")) continue;
    const hb = readHeartbeat(join(activeDir, f));
    if (!hb?.instance_id || hb.instance_id === selfInstanceId) continue;
    peers.push(hb);
  }
  if (peers.length === 0) return "";

  // Build hash basis: sorted-by-instance_id projection of semantically-relevant fields.
  const basis = peers
    .map((p) => ({
      name: p.name ?? null,
      instance_id: p.instance_id ?? null,
      session_id: p.session_id ?? null,
      kind: p.kind ?? null,
      started_at: p.started_at ?? null,
      files_touched: Array.from(p.files_touched ?? []).sort(),
      platform: p.platform ?? null,
    }))
    .sort((a, b) => (a.instance_id ?? "").localeCompare(b.instance_id ?? ""));
  const newHash = sha256Hex16(JSON.stringify(basis));

  const hashFile = join(coordRoot, ".harnery", `.last-peer-hash.${selfInstanceId}`);
  const oldHash = safeRead(hashFile);
  if (oldHash && oldHash === newHash) return "";

  // Render peer table via the same formatter used at SessionStart.
  const table = formatPeerTable(peers, mySessionId);
  if (!table) return "";

  // Persist hash atomically (temp + rename, same convention as other coord writes).
  writeHashFile(hashFile, newHash);
  return table;
}

function computeCouncilPendingIfChanged(
  coordRoot: string,
  selfInstanceId: string,
  agentName: string,
): string {
  const councilsDir = join(coordRoot, ".harnery", "councils");
  if (!existsSync(councilsDir)) return "";
  const canonicalName = agentName.startsWith("agent-") ? agentName : `agent-${agentName}`;

  // Collect pending council IDs (open councils where I'm a member and haven't contributed).
  const pendingIds: string[] = [];
  try {
    for (const f of readdirSync(councilsDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const m = JSON.parse(readFileSync(join(councilsDir, f), "utf8")) as {
          council_id?: string;
          status?: string;
          round_status?: string;
          current_round?: number;
          members?: string[];
        };
        if (m.status !== "active" || m.round_status !== "open") continue;
        if (!m.council_id || !m.members?.includes(canonicalName)) continue;
        const round = m.current_round ?? 1;
        const contributionPath = join(
          councilsDir,
          m.council_id,
          `round-${round}`,
          `${canonicalName}.md`,
        );
        if (existsSync(contributionPath)) continue;
        pendingIds.push(m.council_id);
      } catch {
        /* skip */
      }
    }
  } catch {
    return "";
  }
  pendingIds.sort();

  const hashFile = join(coordRoot, ".harnery", `.last-council-hash.${selfInstanceId}`);
  const newHash = sha256Hex16(pendingIds.join("\n"));
  const oldHash = safeRead(hashFile);

  // Clear hash file when no councils pending, matching bash behavior.
  if (pendingIds.length === 0) {
    try {
      if (existsSync(hashFile)) rmSync(hashFile, { force: true });
    } catch {
      /* swallow */
    }
    return "";
  }

  // Always update hash file when pending councils exist (eager-rewrite, matches bash).
  writeHashFile(hashFile, newHash);
  if (oldHash && oldHash === newHash) return "";

  return formatPendingCouncils(coordRoot, agentName);
}

/* ---------- helpers ---------- */

function readHeartbeat(path: string): HeartbeatRow | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HeartbeatRow;
  } catch {
    return null;
  }
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function sha256Hex16(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function writeHashFile(path: string, value: string): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, value, "utf8");
    renameSync(tmp, path);
  } catch {
    /* swallow */
  }
}

/* The peer-table formatter is a near-duplicate of session-context.ts's, but
 * intentionally co-located here so the prompt-context renderer is self-contained
 * (no cross-file imports of formatting internals). If both renderers diverge,
 * pull the shared bits into a small util module. */

function formatPeerTable(peers: HeartbeatRow[], mySessionId: string): string {
  if (peers.length === 0) return "";
  const nowSec = Math.floor(Date.now() / 1000);

  const fold: Record<string, string[]> = {};
  for (const p of peers) {
    const kind = p.kind ?? "unknown";
    if (kind === "transient" && p.session_id) {
      fold[p.session_id] = (fold[p.session_id] ?? []).concat(p.files_touched ?? []);
    }
  }

  type RowExt = HeartbeatRow & { display_files: string[] };
  const rows: RowExt[] = peers
    .filter((p) => (p.kind ?? "unknown") !== "transient")
    .map((p) => {
      const folded = fold[p.instance_id ?? ""] ?? [];
      const display = Array.from(new Set([...(p.files_touched ?? []), ...folded])).sort();
      return { ...p, display_files: display };
    });

  const blocking = rows.filter((p) => p.session_id !== mySessionId).sort(byStartedAt);
  const group = rows.filter((p) => p.session_id === mySessionId).sort(byStartedAt);

  const out: string[] = [];
  const blk = renderSubtable(
    blocking,
    "Other agent groups active (their files block you):",
    nowSec,
  );
  if (blk) out.push(blk);
  const grp = renderSubtable(
    group,
    "Your group (subagents / parent / siblings; no mutual block):",
    nowSec,
  );
  if (grp) out.push(grp);
  return out.join("\n\n");
}

function byStartedAt(a: HeartbeatRow, b: HeartbeatRow): number {
  return (a.started_at ?? "").localeCompare(b.started_at ?? "");
}

function renderSubtable(
  rows: Array<HeartbeatRow & { display_files: string[] }>,
  header: string,
  nowSec: number,
): string {
  if (rows.length === 0) return "";
  const first = rows.slice(0, 10).map((r) => formatRow(r, nowSec));
  const overflow = rows.length > 10 ? `\n  +${rows.length - 10} more` : "";
  return `${header}\n${first.join("\n")}${overflow}`;
}

function formatRow(r: HeartbeatRow & { display_files: string[] }, nowSec: number): string {
  const taskPart = r.task ? ` "${r.task.slice(0, 60)}"` : "";
  // Fall back started_at → last_heartbeat; if neither is a valid timestamp,
  // show "age unknown" rather than the epoch-derived "20608d ago" ghost.
  const startedSec = parseIsoSec(r.started_at) ?? parseIsoSec(r.last_heartbeat);
  const ageFrom = startedSec === null ? "age unknown" : fmtAge(nowSec - startedSec);
  const filesPart = fmtFiles(r.display_files);
  const lastActivity = fmtLastActivity(r, nowSec);
  const turnSummary = r.turn_summary ? `\n    last turn: ${r.turn_summary.slice(0, 80)}` : "";
  // Prefer a short instance_id over a bare "unknown" so an incomplete row is
  // still identifiable.
  const label = r.name ?? (r.instance_id ? r.instance_id.slice(0, 8) : "unknown");
  return `  - agent-${label}${taskPart}   (${ageFrom}, ${filesPart}${lastActivity})${turnSummary}`;
}

function fmtFiles(files: string[]): string {
  if (files.length === 0) return "nothing yet";
  if (files.length <= 3) return `holds: ${files.join(", ")}`;
  return `holds: ${files.slice(0, 3).join(", ")}, +${files.length - 3} more`;
}

function fmtLastActivity(r: HeartbeatRow, nowSec: number): string {
  if (!r.last_tool) return "";
  const lastTs = parseIsoSec(r.last_heartbeat) ?? parseIsoSec(r.started_at);
  const tail = r.last_tool_target ? ` ${r.last_tool_target.slice(0, 60)}` : "";
  // No valid timestamp → render the tool without an absurd age.
  if (lastTs === null) return `, last: ${r.last_tool}${tail}`;
  return `, last: ${r.last_tool}${tail} ${fmtAge(nowSec - lastTs)}`;
}

/** Epoch-seconds for an ISO string, or null when missing/unparseable (so callers
 * can render "age unknown" instead of an epoch-derived absurd age). */
function parseIsoSec(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function fmtAge(secs: number): string {
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
