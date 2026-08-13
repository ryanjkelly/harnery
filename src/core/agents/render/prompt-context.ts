/**
 * UserPromptSubmit UX renderer. Combines the peer-refresh dedup, the
 * council-pending hash-dedup, the cross-adapter first-session naming nudge,
 * the Cursor/Codex set-task staleness nudge, and the Codex status-footer
 * reminder.
 * agent-hook's user_prompt.submit post-emit handler calls this
 * and forwards the result as the adapter-shaped additionalContext payload.
 *
 * Four subsections combined into one additionalContext payload:
 *   1. Peer table: semantically-relevant peer fields hashed; only re-emits
 *      when peers change (name + instance_id + session_id + kind + started_at
 *      + sorted(files_touched) + platform, sorted by instance_id).
 *   2. Council pending: pending open-council IDs hashed; re-emits when the
 *      ID set changes.
 *   3. Focus nudge. Until the session has produced its suggested name (first
 *      non-empty set-task), tells every adapter — on every prompt, undeduped —
 *      to reproduce set-task's suggested session name in a fenced code block.
 *      Cursor/Codex additionally get the existing unset/stale-task reminder
 *      because their Stop hooks do not enforce task declarations as reliably
 *      as Claude Code's.
 *   4. Codex status footer: a non-deduplicated reminder to put the live status
 *      box after the substantive answer. Stop stays observe-only, so missing the
 *      footer can never trigger a replacement response.
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
import { endOfTurnStatusCommand, resolveBinName } from "../../config.ts";
import { type RemoteMachine, readRemoteMachines } from "../../presence/index.ts";
import type { AgentActivity, TaskState } from "../state/session-state.ts";
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
  activity?: AgentActivity;
  task_state?: TaskState;
  task_state_reason?: string;
  task_updated_at?: string;
  suggested_session_name?: string;
  session_name_seen_for?: string;
  turn_summary?: string;
  workflow_run_id?: string;
}

export interface PromptContextOpts {
  coordRoot: string;
  instanceId: string;
  sessionId: string;
  agentName?: string;
  /** When true, remind a human-facing session to print the session name before
   * its first set-task. UserPromptSubmit enables this for every adapter. */
  sessionNameNudge?: boolean;
  /** When true, run the unset/stale-task check after the first set-task.
   * Cursor/Codex use this; Claude Code has Stop-hook transcript enforcement. */
  taskNudge?: boolean;
  /** When true, append the non-deduplicated Codex status-footer reminder.
   * The caller enables this only for human-facing Codex sessions. */
  statusFooterNudge?: boolean;
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
  const {
    coordRoot,
    instanceId,
    sessionId,
    agentName,
    sessionNameNudge,
    taskNudge,
    statusFooterNudge,
  } = opts;
  const sections: string[] = [];

  // 1. Peer table with hash dedup.
  const peerTable = computePeerTableIfChanged(coordRoot, instanceId, sessionId);
  if (peerTable) sections.push(peerTable);

  // 2. Council pending with hash dedup.
  if (agentName) {
    const councilMsg = computeCouncilPendingIfChanged(coordRoot, instanceId, agentName);
    if (councilMsg) sections.push(councilMsg);
  }

  // 3. First-session naming for every adapter, plus unset/stale-task reminders
  // for Cursor/Codex. One state machine avoids a second generic "task unset"
  // reminder immediately after the first-session reminder has been deduped.
  if (sessionNameNudge || taskNudge) {
    const nudgeMsg = computeFocusNudgeIfChanged(coordRoot, instanceId, {
      sessionNameNudge: sessionNameNudge ?? false,
      taskNudge: taskNudge ?? false,
    });
    if (nudgeMsg) sections.push(nudgeMsg);
  }

  // 4. Codex gets this on every prompt. It is intentionally not hash-deduped:
  // the reminder must be fresh in the model's context when it writes the reply.
  // Missing it is harmless because Codex Stop enforcement remains observe-only.
  if (statusFooterNudge) {
    const statusMsg = renderStatusFooterReminder(coordRoot, instanceId);
    if (statusMsg) sections.push(statusMsg);
  }

  return sections.join("\n\n");
}

function renderStatusFooterReminder(coordRoot: string, selfInstanceId: string): string {
  const hb = readHeartbeat(join(coordRoot, ".harnery", "active", `${selfInstanceId}.json`));
  if (!hb || hb.kind === "subagent" || hb.kind === "transient" || hb.workflow_run_id) return "";

  const statusCommand = endOfTurnStatusCommand(coordRoot);
  return (
    "Codex status footer: complete the user's request first. " +
    `Then run \`${statusCommand}\` as your final shell call and append its stdout verbatim in a fenced code block at the bottom of the same substantive reply. ` +
    "If it fails, finish the owned Git work and rerun it before replying. " +
    "Keep the answer intact. If the footer is missed, do not retry or replace the reply; the Stop hook is observe-only."
  );
}

/**
 * First-session naming for every adapter, followed by Cursor/Codex task
 * staleness checks. The absence of `task_updated_at` is the same invariant
 * `agents set-task` uses for `first_of_session`; clears still stamp the field.
 */
function computeFocusNudgeIfChanged(
  coordRoot: string,
  selfInstanceId: string,
  opts: { sessionNameNudge: boolean; taskNudge: boolean },
): string {
  const hbPath = join(coordRoot, ".harnery", "active", `${selfInstanceId}.json`);
  if (!existsSync(hbPath)) return "";
  let hb: HeartbeatRow;
  try {
    hb = JSON.parse(readFileSync(hbPath, "utf8"));
  } catch {
    return "";
  }

  const hashFile = join(coordRoot, ".harnery", `.last-task-nudge-hash.${selfInstanceId}`);
  // Subagents and workflow children have no human-owned session/tab to rename.
  if (hb.kind === "subagent" || hb.kind === "transient" || hb.workflow_run_id) {
    clearHashFile(hashFile);
    return "";
  }

  const bin = resolveBinName(coordRoot);
  const threshold = Number.parseInt(coordEnv("TASK_STALE_SECONDS") ?? "1800", 10);
  const taskValue = hb.task ?? "";
  let needsNudge = false;
  let message = "";
  let nudgeKind = "";

  if (
    opts.sessionNameNudge &&
    (!hb.suggested_session_name ||
      (hb.session_name_seen_for !== undefined &&
        hb.suggested_session_name !== hb.session_name_seen_for))
  ) {
    // Keyed on "a name was ever produced", not task_updated_at: a bare clear
    // as the first declaration must not end the naming window.
    needsNudge = true;
    nudgeKind = "session-name";
    message = hb.suggested_session_name
      ? `This session's lifecycle changed its suggested name. Reproduce this value by itself inside a fenced code block at the very top of your reply so the operator can one-click-copy it as the session/tab title: ${hb.suggested_session_name}`
      : `This session has no name yet: run \`${bin} agents set-task "<2-5 word session topic>"\` as your first tool call. ` +
        "When it returns `first_of_session: true`, reproduce its `suggested_session_name` value by itself inside a fenced code block at the very top of your reply so the operator can one-click-copy it as the session/tab title. " +
        "Then continue with the task; that `set-task` also satisfies this turn's focus declaration.";
  } else if (opts.taskNudge && !taskValue) {
    needsNudge = true;
    nudgeKind = "task-unset";
    message =
      `Heads up: your \`task\` field is unset. Run \`${bin} agents set-task "<short focus>"\` so peers + the coord dashboard can see what you're working on. ` +
      "(This adapter cannot enforce the declaration from its Stop hook as reliably as Claude Code, so this is a one-time soft reminder per staleness state.)";
  } else if (opts.taskNudge && hb.task_updated_at) {
    const updatedSec = Math.floor(Date.parse(hb.task_updated_at) / 1000);
    const nowSec = Math.floor(Date.now() / 1000);
    if (Number.isFinite(updatedSec) && updatedSec > 0) {
      const ageSec = nowSec - updatedSec;
      if (ageSec > threshold) {
        needsNudge = true;
        nudgeKind = "task-stale";
        message = `Heads up: your \`task\` field hasn't changed in ${ageSec}s (threshold ${threshold}s). If you've moved on from "${taskValue.slice(0, 60)}", update via \`${bin} agents set-task "<new focus>"\`. Pass an empty string to clear.`;
      }
    }
  }

  if (!needsNudge) {
    clearHashFile(hashFile);
    return "";
  }

  // The session-name reminder is deliberately NOT deduped: it re-emits on
  // every prompt until a name is produced, because the "still unnamed" state
  // is the failure state — deduping it erases the only reminder after one
  // ignored prompt (the miss mode operators reported). Bounded in practice:
  // Stop rule 3/3 forces a set-task on the first tool-using turn.
  if (nudgeKind === "session-name") {
    clearHashFile(hashFile);
    return message;
  }

  // Dedup the task-unset/stale reminders on kind + task state so a repeat
  // prompt in the same state stays quiet.
  const state = `${nudgeKind}|task=${taskValue}|updated=${hb.task_updated_at ?? ""}|threshold=${threshold}`;
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
  // Cross-machine presence (ADR 0016): sessions on other machines, from the
  // locally-fetched presence refs. Advisory (no claim blocking in v1).
  const remote = readRemoteMachinesSafe(coordRoot);
  if (peers.length === 0 && remote.length === 0) return "";

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
      activity: p.activity ?? "unknown",
      task_state: p.task_state ?? "active",
      task_state_reason: p.task_state_reason ?? null,
    }))
    .sort((a, b) => (a.instance_id ?? "").localeCompare(b.instance_id ?? ""));
  // Remote basis: machine + per-agent identity/task/files (published_at is
  // excluded — a keepalive re-publish alone shouldn't re-emit the table).
  const remoteBasis = remote.map((m) => ({
    machine: m.machine,
    agents: m.agents.map((a) => ({
      instance_id: a.instance_id,
      name: a.name ?? null,
      task: a.task ?? null,
      activity: a.activity,
      task_state: a.task_state,
      task_state_reason: a.task_state_reason ?? null,
      files_touched: Array.from(a.files_touched ?? []).sort(),
    })),
  }));
  const newHash = sha256Hex16(JSON.stringify({ local: basis, remote: remoteBasis }));

  const hashFile = join(coordRoot, ".harnery", `.last-peer-hash.${selfInstanceId}`);
  const oldHash = safeRead(hashFile);
  if (oldHash && oldHash === newHash) return "";

  // Render peer table via the same formatter used at SessionStart.
  const local = formatPeerTable(peers, mySessionId);
  const remoteTable = formatRemoteTable(remote);
  const table = [local, remoteTable].filter(Boolean).join("\n\n");
  if (!table) return "";

  // Persist hash atomically (temp + rename, same convention as other coord writes).
  writeHashFile(hashFile, newHash);
  return table;
}

/** readRemoteMachines with a local failure guard (rendering must never throw). */
function readRemoteMachinesSafe(coordRoot: string): RemoteMachine[] {
  try {
    return readRemoteMachines(coordRoot);
  } catch {
    return [];
  }
}

/** Render sessions on other machines (presence transport) as a subtable. */
function formatRemoteTable(remote: RemoteMachine[]): string {
  if (remote.length === 0) return "";
  const nowSec = Math.floor(Date.now() / 1000);
  const lines: string[] = [];
  for (const m of remote) {
    for (const a of m.agents.slice(0, 10)) {
      lines.push(
        formatRow(
          { ...a, display_files: Array.from(a.files_touched ?? []).sort() },
          nowSec,
        ).replace(/^ {2}- (agent-[^ ]+)/, `  - $1 @${m.machine}`),
      );
    }
  }
  if (lines.length === 0) return "";
  return `Sessions on other machines (advisory, via presence refs):\n${lines.join("\n")}`;
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

function clearHashFile(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    /* swallow */
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
  const statePart = formatState(r);
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
  return `  - agent-${label}${taskPart}   (${statePart}, ${ageFrom}, ${filesPart}${lastActivity})${turnSummary}`;
}

function formatState(r: HeartbeatRow): string {
  const activity = r.activity ?? "unknown";
  const lifecycle = r.task_state ?? "active";
  const reason =
    lifecycle === "blocked" && r.task_state_reason ? `: ${r.task_state_reason.slice(0, 80)}` : "";
  return `activity=${activity}, lifecycle=${lifecycle}${reason}`;
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
