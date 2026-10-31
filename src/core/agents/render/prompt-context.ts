/**
 * UserPromptSubmit UX renderer. Combines the peer-refresh dedup, the
 * council-pending hash-dedup, the cross-adapter first-session naming nudge,
 * the Cursor/Codex set-task staleness nudge, a host-configured prompt reminder,
 * and the Codex status-footer reminder.
 * agent-hook's turn.started post-emit handler calls this
 * and forwards the result as the adapter-shaped additionalContext payload.
 *
 * Four subsections combined into one additionalContext payload:
 *   1. Peer table: re-emits only when a live peer arrives or leaves, changes
 *      lifecycle, or changes its claimed files. Activity and task text never
 *      trigger a reprint. Peers past the heartbeat-freshness window are left
 *      out and counted in "+N more".
 *   2. Council pending: pending open-council IDs hashed; re-emits when the
 *      ID set changes.
 *   3. Focus nudge. Until the session has displayed its current suggested
 *      name, tells every adapter on every prompt to send the exact fenced block
 *      before prose or another tool call.
 *      Cursor/Codex additionally get the existing unset/stale-task reminder
 *      because their Stop hooks do not enforce task declarations as reliably
 *      as Claude Code's.
 *   4. Host prompt reminder: a project-owned, non-deduplicated line for
 *      adapters whose prompt hook can inject context and which lack a native
 *      reminder mechanism. Hook routing decides which adapters enable it.
 *   5. Codex status footer: a non-deduplicated reminder to put the live status
 *      box after the substantive answer. Stop stays observe-only, so missing the
 *      footer can never trigger a replacement response.
 *   6. Turn ritual: for adapters whose Stop hook enforces the ritual, shown on
 *      the first prompt, after a compaction, and after a bounced turn.
 *
 * Hash files live at:
 *   .harnery/.last-turn-ritual.<instance_id>
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
import {
  coordFreshnessSeconds,
  endOfTurnStatusCommand,
  hostPromptReminder,
  resolveBinName,
} from "../../config.ts";
import { readContextState } from "../../context/index.ts";
import type { PressureWorkloadClass } from "../../diagnostics/contract.ts";
import { formatPeerInbox, peerInbox } from "../../inbox/peer-messages.ts";
import { type RemoteMachine, readRemoteMachines } from "../../presence/index.ts";
import { readResourceStatus } from "../../resources/status.ts";
import { sessionNameDisplayBlock, sessionNameDisplayPending } from "../session-name-display.ts";
import { heartbeatPath } from "../state/heartbeat-reader.ts";
import {
  readLiveCoordinationRow,
  readLiveCoordinationRows,
} from "../state/live-coordination-view.ts";
import { forkRelationLabels } from "../state/names.ts";
import type { AgentActivity, TaskState } from "../state/session-state.ts";
import { formatPendingCouncils } from "./session-context.ts";

interface HeartbeatRow {
  instance_id?: string;
  name?: string;
  kind?: string;
  session_id?: string;
  started_at?: string;
  last_heartbeat?: string;
  files_touched?: string[];
  platform?: string;
  task?: string;
  activity?: AgentActivity;
  task_state?: TaskState;
  task_state_reason?: string;
  task_updated_at?: string | null;
  suggested_session_name?: string;
  session_name_seen_for?: string;
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
  /** When true, append the project-configured prompt reminder without hash
   * deduplication. The caller enables this only on supported adapter routes. */
  hostPromptReminder?: boolean;
  /** When true, append the non-deduplicated Codex status-footer reminder.
   * The caller enables this only for human-facing Codex sessions. */
  statusFooterNudge?: boolean;
  /** Adapter id whose Stop hook ENFORCES the end-of-turn ritual (task_set +
   * status check). When set, append a reminder of that contract on the
   * session's first prompt, after a context compaction, and after a turn the
   * Stop hook bounced (see `markTurnRitualBounced`). */
  turnRitualNudge?: string;
  /** The emitter acknowledges exactly these IDs only after output succeeds. */
  onInboxPrepared?: (messageIds: readonly string[]) => void;
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
    hostPromptReminder: promptReminderEnabled,
    statusFooterNudge,
    turnRitualNudge,
  } = opts;
  const sections: string[] = [];

  // The hook route does not pass --name, so resolve it from the heartbeat.
  // Every name-addressed section below (messages, councils) is silently
  // skipped without it.
  const resolvedName = agentName ?? readLiveCoordinationRow(coordRoot, instanceId)?.name;

  // 1. Instance-bound messages. Rendering is read-only; failed output leaves
  // this same batch pending rather than losing it before a prompt sees it.
  const delivered = peerInbox(coordRoot).prepareSurface(instanceId);
  if (delivered.length > 0) {
    opts.onInboxPrepared?.(delivered.map(({ message_id }) => message_id));
    sections.push(formatPeerInbox(coordRoot, delivered));
  }

  // 2. Peer table with hash dedup.
  const peerTable = computePeerTableIfChanged(coordRoot, instanceId, sessionId);
  if (peerTable) sections.push(peerTable);

  const resources = resourceWarningIfChanged(coordRoot, instanceId);
  if (resources) sections.push(resources);

  // 3. Council pending with hash dedup.
  if (resolvedName) {
    const councilMsg = computeCouncilPendingIfChanged(coordRoot, instanceId, resolvedName);
    if (councilMsg) sections.push(councilMsg);
  }

  // 4. First-session naming for every adapter, plus unset/stale-task reminders
  // for Cursor/Codex. One state machine avoids a second generic "task unset"
  // reminder immediately after the first-session reminder has been deduped.
  if (sessionNameNudge || taskNudge) {
    const nudgeMsg = computeFocusNudgeIfChanged(coordRoot, instanceId, {
      sessionNameNudge: sessionNameNudge ?? false,
      taskNudge: taskNudge ?? false,
    });
    if (nudgeMsg) sections.push(nudgeMsg);
  }

  // 5. A supported adapter gets the host reminder on every prompt. The text is
  // intentionally not hash-deduped or persisted into runtime state: freshness
  // is the feature, and the project config remains its only durable copy.
  if (promptReminderEnabled) {
    const reminder = renderHostPromptReminder(coordRoot, instanceId);
    if (reminder) sections.push(reminder);
  }

  // 6. Codex gets this on every prompt. It is intentionally not hash-deduped:
  // the reminder must be fresh in the model's context when it writes the reply.
  // Missing it is harmless because Codex Stop enforcement remains observe-only.
  if (statusFooterNudge) {
    const statusMsg = renderStatusFooterReminder(coordRoot, instanceId);
    if (statusMsg) sections.push(statusMsg);
  }

  // 7. Adapters whose Stop hook ENFORCES the turn ritual get the reminder when
  // it is news: on the session's first prompt, after a context compaction,
  // and after a turn the Stop hook bounced. The Stop hook keeps enforcing on
  // every turn, so a missed ritual still costs one retry and re-arms this.
  if (turnRitualNudge) {
    const ritualMsg = renderTurnRitualReminder(coordRoot, instanceId, sessionId, turnRitualNudge);
    if (ritualMsg) sections.push(ritualMsg);
  }

  return sections.join("\n\n");
}

/**
 * Prompts receive the published assessment, and only when it changes in a way
 * that changes what an agent should do. The dedupe key is scope, state, and
 * recommended action, so a moving number or a different contributor does not
 * re-emit the same advice.
 */
export function resourceWarningIfChanged(coordRoot: string, instanceId: string): string {
  try {
    heartbeatPath(coordRoot, instanceId);
    const status = readResourceStatus(coordRoot);
    const assessment = status.assessment;
    const hashFile = join(coordRoot, ".harnery", `.last-resource-hash.${instanceId}`);
    const previous = safeRead(hashFile);
    // Existing users without an observer should retain ordinary coordination.
    if (status.assessment_capability.reason_code === "pressure_record_missing" && !previous) {
      return "";
    }
    const key = `${assessment.scope}:${assessment.state}:${assessment.recommended_action}`;
    if (previous === key) return "";
    writeHashFile(hashFile, key);
    const warning = assessment.state === "elevated" || assessment.state === "critical";
    const wasWarning =
      !!previous && (previous.includes(":elevated:") || previous.includes(":critical:"));
    if (!warning && !wasWarning) return "";
    const lines = [`Resource update: ${assessment.summary}`];
    if (assessment.state === "unknown") {
      lines.push(
        "Resource headroom cannot be measured right now, so continue normal coordination and judge heavy work yourself.",
      );
    } else if (!warning && wasWarning) {
      lines.push("The previously reported resource warning has cleared.");
    }
    for (const item of assessment.guidance) {
      lines.push(`${WORKLOAD_LABEL[item.workload_class]}: ${item.summary}`);
    }
    const owners = assessment.contributors
      .filter((row) => row.attribution_confidence === "exact" && row.owner_id)
      .slice(0, 3)
      .map((row) => `${row.owner_kind ?? "owner"} ${row.owner_id}`);
    if (owners.length) {
      lines.push(
        `Measured owners of the contended resource: ${owners.join(", ")}. That says who is holding it, not what the machine as a whole can take.`,
      );
    }
    lines.push(
      `Read \`${resolveBinName(coordRoot)} resources status --json\` for the evidence behind this.`,
    );
    return lines.join("\n");
  } catch {
    return "";
  }
}

/** How an agent recognizes the work each guidance entry is about. */
const WORKLOAD_LABEL: Readonly<Record<PressureWorkloadClass, string>> = {
  lightweight: "Reads and small edits",
  "cpu-heavy": "Builds and test runs",
  "memory-heavy": "Browser captures and page QA",
  "storage-heavy": "Large writes and exports",
};

function renderHostPromptReminder(coordRoot: string, selfInstanceId: string): string {
  const hb = readLiveCoordinationRow(coordRoot, selfInstanceId);
  if (!hb || hb.kind === "subagent" || hb.kind === "transient" || hb.workflow_run_id) return "";
  return hostPromptReminder(coordRoot) ?? "";
}

function turnRitualStatePath(coordRoot: string, instanceId: string): string {
  return join(coordRoot, ".harnery", `.last-turn-ritual.${instanceId}`);
}

const TURN_RITUAL_BOUNCED = "bounced";

/**
 * Called by the Stop hook when it blocks a turn for a missing ritual step, so
 * the next prompt carries the reminder again.
 */
export function markTurnRitualBounced(coordRoot: string, instanceId: string): void {
  writeHashFile(turnRitualStatePath(coordRoot, instanceId), TURN_RITUAL_BOUNCED);
}

function renderTurnRitualReminder(
  coordRoot: string,
  selfInstanceId: string,
  sessionId: string,
  adapter: string,
): string {
  const hb = readLiveCoordinationRow(coordRoot, selfInstanceId);
  if (!hb || hb.kind === "subagent" || hb.kind === "transient" || hb.workflow_run_id) return "";

  // The key changes when native context compaction drops the earlier reminder.
  let generation = 0;
  try {
    generation = readContextState(coordRoot, sessionId)?.generation ?? 0;
  } catch {
    /* no continuity state: treat as the first context generation */
  }
  const key = `context-generation=${generation}`;
  const statePath = turnRitualStatePath(coordRoot, selfInstanceId);
  const previous = safeRead(statePath);
  if (previous === key) return "";
  writeHashFile(statePath, key);
  const bounced =
    previous === TURN_RITUAL_BOUNCED
      ? "Your previous turn was bounced by the Stop hook because the ritual was incomplete. "
      : "";

  const bin = resolveBinName(coordRoot);
  const statusCommand = endOfTurnStatusCommand(coordRoot);
  // Claude Code and Cursor can both enforce completed assistant reply text.
  const paste =
    adapter === "claude-code" || adapter === "cursor"
      ? " and paste its output verbatim in a fenced code block at the end of your reply"
      : "";
  return (
    bounced +
    `Turn ritual (Stop-enforced): on any turn that uses tools, run \`${bin} agents set-task "<short focus>"\` at some point during the turn (required every turn, even when the focus is unchanged; pass an empty string when there is no meaningful focus), then make \`${statusCommand}\` your final tool call${paste}. ` +
    "A turn that ends without these is bounced by the Stop hook and costs a retry."
  );
}

function renderStatusFooterReminder(coordRoot: string, selfInstanceId: string): string {
  const hb = readLiveCoordinationRow(coordRoot, selfInstanceId);
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
  const hb = readLiveCoordinationRow(coordRoot, selfInstanceId);
  if (!hb) return "";

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

  const pendingSessionName = sessionNameDisplayPending(hb);
  if (opts.sessionNameNudge && (!hb.suggested_session_name || pendingSessionName)) {
    // Keyed on "a name was ever produced", not task_updated_at: a bare clear
    // as the first declaration must not end the naming window.
    needsNudge = true;
    nudgeKind = pendingSessionName ? "session-name-pending" : "session-name-unminted";
    message = pendingSessionName
      ? `This session name is still pending display. Before any prose or another tool call, send this exact block as your next assistant text:\n\n${sessionNameDisplayBlock(pendingSessionName)}`
      : `This session has no name yet: run \`${bin} agents set-task "<2-5 word session topic>"\` as your first tool call. ` +
        "When it returns `first_of_session: true`, send its `suggested_session_name` as the exact fenced block requested by the PostToolUse instruction before any prose or another tool call. " +
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

  // An unminted session still gets a fresh reminder on every prompt until its
  // first focus declaration. Once a name exists, the exact pending-name prompt
  // is delivered once per minted value. Repeating it on every prompt creates
  // an unbounded loop on adapters that cannot verify assistant reply text.
  if (nudgeKind === "session-name-unminted") {
    clearHashFile(hashFile);
    return message;
  }

  // A pending reminder is keyed only to the minted name: changing the task
  // must not reconstruct or re-request that older title. Task reminders retain
  // their own task-state key.
  const state =
    nudgeKind === "session-name-pending"
      ? `${nudgeKind}|name=${pendingSessionName ?? ""}`
      : `${nudgeKind}|task=${taskValue}|updated=${hb.task_updated_at ?? ""}|threshold=${threshold}`;
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
  // Read self heartbeat for session_id (group key); fall back to the caller's hint.
  let mySessionId = selfSessionIdFallback;
  const rows = readLiveCoordinationRows(coordRoot);
  const selfHb = readLiveCoordinationRow(coordRoot, selfInstanceId);
  if (selfHb?.session_id) mySessionId = selfHb.session_id;
  if (!mySessionId) return "";

  // Collect peers from the selected ledger route. Under V3 this is the
  // canonical projection, never the legacy active directory.
  const peers: HeartbeatRow[] = rows.filter(
    (heartbeat) => heartbeat.instance_id && heartbeat.instance_id !== selfInstanceId,
  );
  // Cross-machine presence (ADR 0016): sessions on other machines, from the
  // locally-fetched presence refs. Advisory only; remote presence never grants
  // claim authority.
  const remote = readRemoteMachinesSafe(coordRoot);
  if (peers.length === 0 && remote.length === 0) return "";

  const rendered = renderPeerTable({
    peers,
    remote,
    mySessionId,
    nowMs: Date.now(),
    freshnessSeconds: coordFreshnessSeconds(coordRoot),
    relations: forkRelationLabels(
      coordRoot,
      selfInstanceId,
      new Set(peers.map((p) => p.instance_id ?? "")),
    ),
  });
  if (!rendered.table) return "";

  const hashFile = join(coordRoot, ".harnery", `.last-peer-hash.${selfInstanceId}`);
  const oldHash = safeRead(hashFile);
  if (oldHash && oldHash === rendered.hash) return "";

  // Persist hash atomically (temp + rename, same convention as other coord writes).
  writeHashFile(hashFile, rendered.hash);
  return rendered.table;
}

export interface PeerTableInput {
  peers: HeartbeatRow[];
  remote: RemoteMachine[];
  mySessionId: string;
  nowMs: number;
  /** Sessions whose last heartbeat is older than this are folded into "+N more". */
  freshnessSeconds: number;
  relations?: Map<string, string>;
}

/**
 * Pure peer-table render plus its change key. The key covers only what makes
 * the table news: which live sessions exist, their lifecycle, and the files
 * they claim. Activity and task text change on nearly every peer tool call, so
 * they render in the table but never trigger a reprint by themselves.
 */
export function renderPeerTable(input: PeerTableInput): { hash: string; table: string } {
  const { peers, remote, mySessionId, nowMs, freshnessSeconds } = input;
  const cutoffMs = nowMs - freshnessSeconds * 1000;
  const live: HeartbeatRow[] = [];
  const stale: HeartbeatRow[] = [];
  for (const peer of peers) {
    const seenMs = Date.parse(peer.last_heartbeat ?? "");
    if (Number.isFinite(seenMs) && seenMs >= cutoffMs) live.push(peer);
    else stale.push(peer);
  }

  const basis = live
    .map((p) => ({
      name: p.name ?? null,
      instance_id: p.instance_id ?? null,
      session_id: p.session_id ?? null,
      kind: p.kind ?? null,
      started_at: p.started_at ?? null,
      files_touched: Array.from(p.files_touched ?? []).sort(),
      platform: p.platform ?? null,
      task_state: p.task_state ?? "active",
      task_state_reason: p.task_state_reason ?? null,
    }))
    .sort((a, b) => (a.instance_id ?? "").localeCompare(b.instance_id ?? ""));
  // Remote basis: machine + per-agent identity, lifecycle, and files
  // (published_at, activity, and task are excluded for the same reason).
  const remoteBasis = remote.map((m) => ({
    machine: m.machine,
    agents: m.agents.map((a) => ({
      instance_id: a.instance_id,
      name: a.name ?? null,
      task_state: a.task_state,
      task_state_reason: a.task_state_reason ?? null,
      files_touched: Array.from(a.files_touched ?? []).sort(),
    })),
  }));
  const hash = sha256Hex16(JSON.stringify({ local: basis, remote: remoteBasis }));

  const nowSec = Math.floor(nowMs / 1000);
  const local = formatPeerTable(live, stale, mySessionId, nowSec, input.relations);
  const remoteTable = formatRemoteTable(remote, nowSec);
  const table = [local, remoteTable].filter(Boolean).join("\n\n");
  return { hash, table };
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
function formatRemoteTable(remote: RemoteMachine[], nowSec: number): string {
  if (remote.length === 0) return "";
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

type PeerRow = HeartbeatRow & { display_files: string[]; relation?: string; label?: string };

function formatPeerTable(
  peers: HeartbeatRow[],
  stalePeers: HeartbeatRow[],
  mySessionId: string,
  nowSec: number,
  relations: Map<string, string> = new Map(),
): string {
  if (peers.length === 0) return "";

  const fold: Record<string, string[]> = {};
  for (const p of [...peers, ...stalePeers]) {
    const kind = p.kind ?? "unknown";
    if (kind === "transient" && p.session_id) {
      fold[p.session_id] = (fold[p.session_id] ?? []).concat(p.files_touched ?? []);
    }
  }

  const rows: PeerRow[] = peers
    .filter((p) => (p.kind ?? "unknown") !== "transient")
    .map((p) => {
      const folded = fold[p.instance_id ?? ""] ?? [];
      const display = Array.from(new Set([...(p.files_touched ?? []), ...folded])).sort();
      const relation = relations.get(p.instance_id ?? "");
      return { ...p, display_files: display, ...(relation ? { relation } : {}) };
    });
  assignUniqueLabels(rows);
  const staleRows = stalePeers.filter((p) => (p.kind ?? "unknown") !== "transient");

  // Related sessions sort first so a fork parent never hides in "+N more".
  const blocking = rows
    .filter((p) => p.session_id !== mySessionId)
    .sort((a, b) => Number(!!b.relation) - Number(!!a.relation) || byStartedAt(a, b));
  const group = rows.filter((p) => p.session_id === mySessionId).sort(byStartedAt);
  const staleBlocking = staleRows.filter((p) => p.session_id !== mySessionId).length;
  const staleGroup = staleRows.length - staleBlocking;

  const out: string[] = [];
  const blk = renderSubtable(
    blocking,
    staleBlocking,
    "Other agent groups active (their files block you):",
    nowSec,
  );
  if (blk) out.push(blk);
  const grp = renderSubtable(
    group,
    staleGroup,
    "Your group (subagents / parent / siblings; no mutual block):",
    nowSec,
  );
  if (grp) out.push(grp);
  return out.join("\n\n");
}

/**
 * One full, distinct label per row. An unnamed session shows its whole
 * instance id (an 8-character prefix collides for time-ordered ids), and a
 * name two live rows share carries its instance id so they read as two.
 */
function assignUniqueLabels(rows: PeerRow[]): void {
  const base = (r: PeerRow) => r.name ?? r.instance_id ?? "unknown";
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(base(r), (counts.get(base(r)) ?? 0) + 1);
  for (const r of rows) {
    const label = base(r);
    r.label =
      (counts.get(label) ?? 0) > 1 && r.name && r.instance_id
        ? `${label} (${r.instance_id})`
        : label;
  }
}

function byStartedAt(a: HeartbeatRow, b: HeartbeatRow): number {
  return (a.started_at ?? "").localeCompare(b.started_at ?? "");
}

function renderSubtable(
  rows: PeerRow[],
  staleCount: number,
  header: string,
  nowSec: number,
): string {
  if (rows.length === 0) return "";
  const first = rows.slice(0, 10).map((r) => formatRow(r, nowSec));
  const more = Math.max(0, rows.length - 10) + staleCount;
  const staleNote = staleCount > 0 ? ` (${staleCount} with no recent heartbeat)` : "";
  const overflow = more > 0 ? `\n  +${more} more${staleNote}` : "";
  return `${header}\n${first.join("\n")}${overflow}`;
}

function formatRow(r: PeerRow, nowSec: number): string {
  const taskPart = r.task ? ` "${r.task.slice(0, 60)}"` : "";
  const statePart = formatState(r);
  // Fall back started_at → last_heartbeat; if neither is a valid timestamp,
  // show "age unknown" rather than the epoch-derived "20608d ago" ghost.
  const startedSec = parseIsoSec(r.started_at) ?? parseIsoSec(r.last_heartbeat);
  const ageFrom = startedSec === null ? "age unknown" : fmtAge(nowSec - startedSec);
  const filesPart = fmtFiles(r.display_files);
  // An unnamed row shows its full instance id; a prefix can collide.
  const label = r.label ?? r.name ?? r.instance_id ?? "unknown";
  const relation = r.relation ? ` [${r.relation}]` : "";
  return `  - agent-${label}${relation}${taskPart}   (${statePart}, ${ageFrom}, ${filesPart})`;
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
