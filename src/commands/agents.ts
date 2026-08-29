/**
 * `harn agents`: on-demand queries against the multi-agent coord layer.
 *
 *   harn agents whoami            current agent's name + instance_id + claims
 *   harn agents list              all active agents (default: fold transients)
 *   harn agents list --all        include raw kind=transient rows
 *   harn agents list --stale      include generations older than the freshness window
 *   harn agents list --json       JSON output (alias for --format json)
 *   harn agents status            end-of-turn status box (name + age + files + peers)
 *   harn agents heal-events       PIDMAP_HEAL telemetry (pid-map self-heal frequency)
 *   harn agents heal-events --since 24h --limit 20
 *   harn agents health            one-screen coord-layer health rollup
 *   harn agents health --since 7d --json
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { coordBinPath } from "../core/agents/coord-bin.ts";
import {
  checkGitFinalization,
  formatGitFinalizationFailure,
  type GitFinalizationResult,
  readSessionWriteClaims,
} from "../core/agents/finalization.ts";
import {
  emitEventV3,
  monorepoRoot,
  nativeSessionIdentity,
  normalizeAdapter,
  resolveOwner,
  resolveOwnerBySessionEnv,
  resolveOwnerWithSource,
  sessionIdentityFromEnv,
} from "../core/agents/index.ts";
import {
  bootstrapLiveCoordinationAuthorityV3,
  LiveCoordinationAuthorityV3Error,
  reopenLiveCoordinationGenerationV3,
} from "../core/agents/live-authority-v3.ts";
import {
  listSessionFinalizationRequestsV3,
  observeHostDisappearedV3,
  reconcileSessionFinalizationV3,
  requestSessionEndExplicitV3,
  type SessionFinalizationRequestV3,
} from "../core/agents/session-finalizer-v3.ts";
import {
  SESSION_NAME_DISPLAY_NOTE,
  sessionNameDisplayPending,
} from "../core/agents/session-name-display.ts";
import { agentDisplayName } from "../core/agents/state/activity-log.ts";
import {
  buildLifecycleSuggestedName,
  buildSuggestedName,
  type Heartbeat,
  readHeartbeat as readHeartbeatCache,
} from "../core/agents/state/heartbeat-writer.ts";
import {
  readLiveCoordinationRow,
  readLiveCoordinationRows,
} from "../core/agents/state/live-coordination-view.ts";
import {
  type AgentActivity,
  foldSessionState,
  type TaskState,
} from "../core/agents/state/session-state.ts";
import {
  coordFreshnessSeconds,
  resolveBinName,
  sessionFinalizationConfig,
} from "../core/config.ts";
import type { EventTypeV3 } from "../core/events/v3/contract.ts";
import { readEventV3ControlState } from "../core/events/v3/control.ts";
import { projectCoordinationViewV3 } from "../core/events/v3/coordination-view.ts";
import { liveInstanceIdV3 } from "../core/events/v3/live-routing.ts";
import {
  countSummarizedSinceV3,
  listDiagnosticSummariesV3,
} from "../core/events/v3/producers/diagnostic-summaries.ts";
import {
  listHookIntakeGroupsV3,
  listHookIntakeRecordsV3,
} from "../core/events/v3/producers/intake.ts";
import {
  listHookProducerStateRecordsV3,
  readHookProducerStateV3,
} from "../core/events/v3/producers/recorder.ts";
import { readLedgerV3 } from "../core/events/v3/reader.ts";
import { EVENT_V3_LEDGER_RELATIVE_ROOT } from "../core/events/v3/writer.ts";
import type { RunQualitySnapshot, RunQualityStatus } from "../core/guard/index.ts";
import { evaluateRunQualityIfDue } from "../core/guard/index.ts";
import {
  readRuntimeContextTelemetry,
  readRuntimeContextUsage,
} from "../core/hooks/adapter/runtime-telemetry.ts";
import { type RemoteMachine, readRemoteMachines } from "../core/presence/index.ts";
import { registerContextCommand } from "./context.ts";

type LiveCoordinationRow = ReturnType<typeof readLiveCoordinationRows>[number];

function readCurrentCoordinationRow(instanceId: string): LiveCoordinationRow | null {
  const root = monorepoRoot();
  return root ? readLiveCoordinationRow(root, instanceId) : null;
}

/** Cap for CLI scans of the unbounded event ledger (`trace` / `health`). Well
 * under V8's ~512MB max string length so a `readFileSync` of the whole file can
 * never throw; covers ample recent history for a diagnostic scan. */

import { parsePsChainLine } from "../core/hooks/resolve/anchor.ts";
import { appendEntry, resolveOwnerByName } from "../core/journal/index.ts";
import {
  buildCouncilId,
  buildInviteMarkdown,
  COUNCIL_SCHEMA_VERSION,
  type CouncilManifest,
  type CouncilStatus,
  contributorsInRound,
  councilBodyDir,
  councilsArchiveDir,
  deleteArchivedCouncil,
  effectiveSteward,
  findManifestByPartialId,
  listKnownAgents,
  listManifests,
  moveFromArchive,
  moveToArchive,
  normalizeAgentName,
  pendingCouncilsForMember,
  readArchivedManifest,
  readManifest,
  readRoundPrompts,
  roundDir,
  setCouncilSteward,
  writeContribution,
  writeManifest,
  writePrompt,
} from "../lib/council/index.ts";
import { assumeIdentity, IdentityAssumeError } from "../lib/identities/assume.ts";
import {
  displayName as displayAgentName,
  ensureIdentity,
  listIdentities,
  lookupById as lookupIdentityById,
  lookupByName as lookupIdentityByName,
} from "../lib/identities/index.ts";

/**
 * Heartbeat-freshness window (seconds). Reads `coord.freshness_seconds` /
 * `HARNERY_AGENT_COORD_FRESHNESS` via the shared accessor (defaults to 600 =
 * 10 min). A function, not a const, so a config edit takes effect without a
 * process restart (mtime-cached).
 */
function freshnessCutoffSecs(): number {
  return coordFreshnessSeconds();
}

const SUBAGENT_NOTE =
  "Native adapter subagents resolve to their own child generation after the hook bridge " +
  "observes delegation. An unbridged subprocess shell still resolves through its parent.";

/**
 * Spawn options for agent-coord child processes: pin the coord root the
 * command already resolved (git-superproject-aware via `monorepoRoot()`), so
 * the helper can't re-resolve a DIFFERENT root by walking up from a drifted
 * shell cwd. The concrete failure this prevents: a shell cd'd into an
 * embedded harnery checkout (which carries its own committed `.harnery/`)
 * made agent-coord resolve that nested root and miss the session's real
 * heartbeat — `set-task: no heartbeat at .harnery/active/<id>.json` while
 * `status` (which resolves in-process) worked fine. Mirrors the hooks side's
 * `childEnv()`; every agent-coord spawn must carry this.
 */
export function coordHelperOpts(root: string): { cwd: string; env: NodeJS.ProcessEnv } {
  return { cwd: root, env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root } };
}

/**
 * Resolve the bundled `agent-coord` helper, or exit with an error that names the
 * problem. Every heartbeat mutation goes through that binary, so a caller who
 * cannot find it has nothing useful to do — but it has to SAY so, because the
 * alternative was spawning a path that did not exist and then crashing on the
 * result (see `spawnFailureMessage`).
 */
function agentCoordOrExit(root: string): string {
  const binary = coordBinPath("agent-coord", root);
  if (!binary) {
    emit.error({
      code: "coord_helper_missing",
      message: `agent-coord helper not found for coord root ${root}; reinstall or rebuild harnery`,
    });
    process.exit(1);
  }
  return binary;
}

/**
 * Describe a failed `spawnSync` without assuming it ran.
 *
 * When the binary cannot be executed at all (ENOENT, EACCES) node reports
 * `status: null` AND `stderr: null`, so the obvious `result.stderr.trim()`
 * threw "null is not an object" — replacing a legible "helper not found" with a
 * crash that pointed at the wrong layer entirely. `error` carries the real
 * cause on that path, so prefer it.
 */
function spawnFailureMessage(
  result: { status: number | null; stderr: string | null; error?: Error },
  what: string,
): string {
  if (result.error) return `${what}: ${result.error.message}`;
  const stderr = result.stderr?.trim();
  if (stderr) return stderr;
  return result.status === null ? `${what}: did not run` : `${what} exited ${result.status}`;
}

function formatPlatformLabel(platform?: string | null): string {
  if (platform === "cursor") return "Cursor";
  if (platform === "codex") return "Codex";
  return "CC";
}

interface Row {
  name: string;
  /** Durable persona UUID after an explicit identity assumption. */
  agent_id?: string | null;
  instance_id: string;
  session_id: string;
  kind: string;
  relation: "self" | "group" | "blocks" | "remote" | "unknown";
  started_at: string;
  last_heartbeat: string;
  files_touched: string[];
  task?: string | null;
  activity: AgentActivity;
  activity_updated_at?: string | null;
  activity_source?: string | null;
  task_state: TaskState;
  task_state_scope: "current" | "historical";
  task_state_updated_at?: string | null;
  task_state_reason?: string | null;
  platform?: string | null;
  /** Set on relation=remote rows: the machine label the row arrived from
   * via the cross-machine presence transport (ADR 0016). */
  machine?: string | null;
}

function activityOf(hb: Pick<Heartbeat, "activity">): AgentActivity {
  return hb.activity ?? "unknown";
}

function taskStateOf(hb: Pick<Heartbeat, "task_state">): TaskState {
  return hb.task_state ?? "active";
}

export { nativeSessionIdentity };

function lifecycleLabel(hb: Pick<Heartbeat, "task_state" | "task_state_reason">): string {
  const state = taskStateOf(hb);
  return state === "blocked" && hb.task_state_reason ? `${state}: ${hb.task_state_reason}` : state;
}

let emit: EmitContext;

export function registerAgentsCommand(
  program: Command,
  emitParam: EmitContext,
  programContext?: HarneryProgramContext,
  binName = resolveBinName(),
): void {
  emit = emitParam;
  const cmd = program
    .command("agents")
    .description(
      "The live agent sessions in this project: who is running now, what they hold, and their coordination state (whoami / list / status / health).",
    );

  registerContextCommand(cmd, emitParam, programContext);

  cmd
    .command("whoami")
    .description("Print the current agent's name + instance_id + files claimed")
    .option("--json", "JSON output (alias for --format json)")
    .action((opts: { json?: boolean }) => {
      runWhoami(opts);
    });

  cmd
    .command("list")
    .description("List all active agents (folds kind=transient by default)")
    .option("--all", "Include raw kind=transient rows (no fold)")
    .option("--stale", "Include generations older than the freshness window")
    .option("--json", "JSON output (alias for --format json)")
    .action((opts: { all?: boolean; stale?: boolean; json?: boolean }) => {
      runList(opts);
    });

  cmd
    .command("status")
    .description("End-of-turn status box (name + session age + files held + peer count)")
    .option("--json", "JSON output instead of the box")
    .option(
      "--end-turn",
      "Treat this as the turn's closing status: issue the box only when this session's held paths are committed and their repositories are pushed",
    )
    .option(
      "--end-session",
      "After the closing status, durably request an authoritative session end as soon as this exact turn closes (requires --end-turn)",
    )
    .option(
      "--session-id <id>",
      "Lookup the V3 generation by session_id directly, bypassing the ppid walk. " +
        "Use this when calling from a hook (the hook's process tree may not lead back to Claude Code's session pid). " +
        "The Stop hook payload includes session_id; pass it through.",
    )
    .action(
      (opts: { endTurn?: boolean; endSession?: boolean; json?: boolean; sessionId?: string }) => {
        runStatus(opts);
      },
    );

  cmd
    .command("suggest-name [description...]")
    .description(
      'Reprint a session name ("Agent <you> - <description>") for the operator to set as their ' +
        "adapter tab title. With no arg, prefers the exact pending name, then derives from your current task. The primary naming path " +
        "is set-task (it suggests a name on the first focus declaration); reach for this to reprint " +
        "or to create an explicit pending-display retry with --json. Read-only.",
    )
    .option("--json", "JSON output instead of the bare name")
    .option(
      "--session-id <id>",
      "Lookup the V3 generation by session_id directly, bypassing the ppid walk.",
    )
    .action((description: string[], opts: { json?: boolean; sessionId?: string }) => {
      runSuggestName(description, opts);
    });

  cmd
    .command("watch")
    .description(
      "Stream peer state changes from the authoritative V3 coordination projection. " +
        "Prints one line per delta: started / ended / activity / file claim / task change.",
    )
    .option("--poll-ms <n>", "Debounce window after a change event", "200")
    .action(async (opts: { pollMs: string }) => {
      await runWatch(Number.parseInt(opts.pollMs, 10));
    });

  cmd
    .command("show <name>")
    .description(
      "Deep-dive on one peer agent: registry state (files held, last tool, task, turn summary). " +
        "Disambiguates name → instance_id via prefix match.",
    )
    .option("--json", "JSON envelope output")
    .action(async (name: string, opts: { json?: boolean }) => {
      await runShow(name, opts);
    });

  cmd
    .command("trace <name>")
    .description(
      "Reconstruct one agent's coordination lifecycle from the active canonical event ledger: " +
        "session.started → prompts → turns → tools → observations → session.ended, " +
        "in chronological order. The answer to 'what happened to this agent / why did " +
        "it vanish?' without hand-grepping the stream. Accepts a name (agent-Foo or Foo) " +
        "or an instance_id.",
    )
    .option("--since <window>", "Only events newer than Nh|Nd (default: all)")
    .option("--limit <n>", "Show at most N most-recent events. Default: 200.", "200")
    .option("--all-tools", "Include tool.completed + command.* (default: hidden as noise)")
    .option("--json", "JSON envelope output")
    .action(
      (
        name: string,
        opts: { since?: string; limit: string; allTools?: boolean; json?: boolean },
      ) => {
        runTrace(name, opts);
      },
    );

  cmd
    .command("set-task <text...>")
    .description(
      "Declare what this agent is currently working on. Visible to peers in the " +
        "per-prompt snapshot. Pass an empty string ('') to clear.",
    )
    .option(
      "--session-id <id>",
      `Set the task on the heartbeat with this session_id directly, bypassing the ppid walk. Mirror of \`status --session-id\`: use it when the ppid walk can't resolve self (e.g. Cursor, whose shell tool calls don't descend from a pid-map-registered anchor). Discover the id via \`${binName} agents list --json\`.`,
    )
    .action((text: string[], opts: { sessionId?: string }) => {
      runSetTask(text.join(" "), opts);
    });

  cmd
    .command("lifecycle <state>")
    .description("Declare this session's task lifecycle: active, blocked, or done")
    .option("--reason <text>", "Explain the lifecycle declaration")
    .option(
      "--session-id <id>",
      "Target the heartbeat with this session_id directly, bypassing the ppid walk.",
    )
    .action((state: string, opts: { reason?: string; sessionId?: string }) => {
      runLifecycle(state, opts);
    });

  cmd
    .command("end")
    .description(
      "Finalize the current V3 session explicitly, or durably queue finalization until the current turn and tool spans close.",
    )
    .option("--session-id <id>", "Native adapter session id to finalize")
    .option("--instance-id <id>", "Canonical V3 instance id to finalize")
    .option(
      "--outcome <outcome>",
      "succeeded | failed | cancelled | timed_out | denied | interrupted | unknown",
      "succeeded",
    )
    .action((opts: { sessionId?: string; instanceId?: string; outcome: string }) => {
      runEndSession(opts);
    });

  cmd
    .command("reconcile")
    .description(
      "Reconcile archive, idle, parent/run completion, stale, superseded, and host lifecycle signals into V3 session finalization.",
    )
    .option("--watch", "Keep reconciling until interrupted")
    .option("--interval-seconds <n>", "Watch interval in seconds")
    .option("--json", "JSON output")
    .action(async (opts: { watch?: boolean; intervalSeconds?: string; json?: boolean }) => {
      await runSessionReconcile(opts);
    });

  cmd
    .command("observe-archive")
    .description(
      "Record an adapter archive or unarchive observation and reconcile it through the canonical V3 finalizer.",
    )
    .requiredOption("--adapter <id>", "claude-code | codex | cursor")
    .requiredOption("--session-id <id>", "Native adapter session id")
    .option("--unarchived", "Cancel a pending archive finalization")
    .option("--observed-at <iso>", "Observation time (defaults to now)")
    .action(
      (opts: { adapter: string; sessionId: string; unarchived?: boolean; observedAt?: string }) =>
        runObserveArchive(opts),
    );

  cmd
    .command("observe-host-disappeared")
    .description(
      "Record a provisional host-loss observation; finalization follows only after the configured cascade grace period.",
    )
    .requiredOption("--instance-id <id>", "Canonical V3 instance id")
    .requiredOption("--generation-id <id>", "Canonical V3 generation id")
    .option("--observed-at <iso>", "Observation time (defaults to now)")
    .action((opts: { instanceId: string; generationId: string; observedAt?: string }) => {
      runObserveHostDisappeared(opts);
    });

  cmd
    .command("release-claim <path>")
    .description(
      "Drop a file claim from your heartbeat. Operator escape hatch when a " +
        "PostToolUseFailure didn't fire (e.g., session ended mid-Edit) and a " +
        "peer is now blocked on a path you no longer care about. Same write " +
        "agent-hook's auto-release uses on failed Edit.",
    )
    .action((path: string) => {
      runReleaseClaim(path);
    });

  cmd
    .command("ping <name> <message...>")
    .description(
      "Append a 'handoff' entry to a peer agent's journal. Body prefixed with " +
        "`from agent-<me>:`. Use to leave actionable coordination notes for peers " +
        "currently holding files you need.",
    )
    .option("--json", "JSON output")
    .action((name: string, message: string[], opts: { json?: boolean }) => {
      runPing(name, message.join(" "), opts);
    });

  cmd
    .command("wait <name>")
    .description(
      `Block until a peer agent releases files (their \`files_touched\` becomes empty, OR they exit). Pair with \`${binName} agents ping\` to coordinate hand-offs.`,
    )
    .option(
      "--file <path>",
      "Wait only for these specific paths (repeatable)",
      collectPath,
      [] as string[],
    )
    .option(
      "--timeout <dur>",
      "Give up after this duration; suffix s/m/h/d is required (e.g. 30s, 5m, 1h). Default 60m.",
      "60m",
    )
    .option("--poll-secs <n>", "Poll interval in seconds (default 5)", "5")
    .option("--quiet", "Suppress progress lines")
    .option("--json", "JSON output (terminal status, only printed at exit)")
    .action(
      async (
        name: string,
        opts: {
          file: string[];
          timeout: string;
          pollSecs: string;
          quiet?: boolean;
          json?: boolean;
        },
      ) => {
        await runWait(name, opts);
      },
    );

  cmd
    .command("heal-events")
    .description(
      "PIDMAP_HEAL telemetry: how often pid-map self-heal had to fix drift. " +
        "High counts surface the upstream sibling-claude-spawn bug.",
    )
    .option("--since <window>", "Time window (e.g. 1h, 24h, 7d). Default: 7d.", "7d")
    .option("--limit <n>", "Max recent events to show in the table. Default: 20.", "20")
    .option("--json", "JSON output (alias for --format json)")
    .option("--csv", "CSV output of the events list")
    .action((opts: { since: string; limit: string; json?: boolean; csv?: boolean }) => {
      runHealEvents(opts);
    });

  cmd
    .command("health")
    .description(
      "One-screen coord-layer health rollup: heal events, council activity, " +
        "zombie detection, and anomalies. Designed for " +
        "daily glance + dashboard ingestion. Reads .harnery/.",
    )
    .option("--since <window>", "Window (Nh | Nd). Default: 24h.", "24h")
    .option("--json", "JSON envelope output")
    .action((opts: { since: string; json?: boolean }) => {
      runHealth(opts);
    });

  cmd
    .command("adapter-probe <id>")
    .description(
      "Adapter wiring probe: ppid chain, comm names, pid-map anchor, sample payload paths. " +
        "With --replay-samples, also replays every checked-in sample payload against the live " +
        "adapter in an isolated sandbox to catch adapter / payload-shape drift. " +
        "Complements heal-events (drift telemetry). Id: claude-code | cursor.",
    )
    .option("--json", "JSON envelope output")
    .option(
      "--replay-samples",
      "Replay docs/api/<adapter>-hooks/samples/*.json against the live adapter in an isolated sandbox. " +
        "Exits non-zero if any sample crashes the adapter.",
    )
    .option(
      "--sample <path>",
      "Replay only the named sample file (basename match). Implies --replay-samples.",
    )
    .action((id: string, opts: { json?: boolean; replaySamples?: boolean; sample?: string }) => {
      runAdapterProbe(id, opts);
    });

  cmd
    .command("heal")
    .description(
      "Repair the current session's disposable coordination cache from V3. " +
        "Use explicit options to target another generation or repair process attribution.",
    )
    .option("--owner <id>", "Target agent's instance_id. Defaults to the current session.")
    .option("--kind <kind>", "pidmap | cache. Defaults to cache.")
    .option(
      "--session-id <id>",
      "(--kind cache) native session id used to join the authoritative V3 generation.",
    )
    .option(
      "--adapter <id>",
      "(--kind cache) adapter used to validate the authoritative V3 generation: " +
        "claude-code | cursor | codex.",
    )
    .option(
      "--pid <pid>",
      "(--kind pidmap) PID to register in pid-map. Default: walk " +
        "this shell's ppid chain for a claude process. Pass explicitly " +
        "when calling from outside Claude Code's Bash tool tree (e.g. " +
        "from cron or an external script).",
    )
    .option(
      "--quarantine-transaction <id>",
      "Quarantine one irreconcilable prepared authority transaction after proving its event was never committed.",
    )
    .option(
      "--approval-record-id <id>",
      "Durable identifier for the operator approval authorizing transaction quarantine.",
    )
    .option("--yes", "Confirm the exact prepared transaction may be quarantined.")
    .option("--json", "JSON envelope output")
    .action(
      (opts: {
        owner?: string;
        kind?: string;
        sessionId?: string;
        adapter?: string;
        pid?: string;
        quarantineTransaction?: string;
        approvalRecordId?: string;
        yes?: boolean;
        json?: boolean;
      }) => {
        runHeal(opts);
      },
    );
  registerIdentityCommands(cmd);
}

const SESSION_OUTCOMES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "denied",
  "interrupted",
  "unknown",
]);

function runEndSession(opts: { sessionId?: string; instanceId?: string; outcome: string }) {
  const root = monorepoRoot();
  if (!root) return failCommand("not_in_repo", "not in an agent session");
  if (!SESSION_OUTCOMES.has(opts.outcome)) {
    return failCommand("invalid_outcome", "invalid session outcome");
  }
  const target = opts.instanceId ?? opts.sessionId ?? resolveOwner();
  if (!target) {
    return failCommand(
      "session_identity_missing",
      "could not resolve the current session; pass --session-id or --instance-id",
    );
  }
  const byInstance = listHookProducerStateRecordsV3(root, { includeTerminal: false }).filter(
    ({ state }) => state.instance_id === target,
  );
  const byNative = (["claude-code", "codex", "cursor"] as const).flatMap((adapter) => {
    const state = readHookProducerStateV3(root, adapter, target);
    return state && !state.terminal ? [{ path: "", modified_at_ms: 0, state }] : [];
  });
  const matches = byInstance.length > 0 ? byInstance : byNative;
  if (matches.length !== 1) {
    return failCommand(
      "session_identity_ambiguous",
      `expected one live V3 generation for the target; found ${matches.length}`,
    );
  }
  const record = matches[0];
  if (!record) {
    return failCommand("session_identity_missing", "live V3 generation disappeared");
  }
  const state = record.state;
  if (state.delegations.length > 0) {
    return failCommand(
      "session_work_open",
      `cannot finalize while ${state.delegations.length} delegated child(ren) remain open`,
    );
  }
  const history = readSessionWriteClaims(root, state.instance_id, state.session_id);
  const finalized = checkGitFinalization(root, history.paths, {
    claimHistoryComplete: history.complete,
  });
  if (!finalized.ok) {
    return failCommand(
      "git_not_finalized",
      formatGitFinalizationFailure(finalized, resolveBinName(root)),
    );
  }
  const result = requestSessionEndExplicitV3({
    coordRoot: root,
    instance_id: state.instance_id,
    generation_id: state.generation_id,
    outcome: opts.outcome as
      | "succeeded"
      | "failed"
      | "cancelled"
      | "timed_out"
      | "denied"
      | "interrupted"
      | "unknown",
    coordination_finalized: true,
  });
  if (
    result.state !== "recorded" &&
    result.state !== "already_ended" &&
    result.state !== "queued" &&
    result.state !== "already_requested"
  ) {
    return failCommand("session_end_failed", JSON.stringify(result));
  }
  const terminalEventId =
    result.state === "recorded"
      ? result.event.event_id
      : result.state === "already_ended"
        ? result.event_id
        : undefined;
  const requestId =
    result.state === "queued" || result.state === "already_requested"
      ? result.request.request_id
      : undefined;
  emit.data({
    ok: true,
    state: result.state,
    instance_id: state.instance_id,
    generation_id: state.generation_id,
    ...(terminalEventId ? { terminal_event_id: terminalEventId } : {}),
    ...(requestId ? { request_id: requestId } : {}),
    authority: "approved",
    reason: "approved_explicit_end",
  });
}

async function runSessionReconcile(opts: {
  watch?: boolean;
  intervalSeconds?: string;
  json?: boolean;
}): Promise<void> {
  const root = monorepoRoot();
  if (!root) return failCommand("not_in_repo", "not in an agent session");
  if (opts.json) emit.config({ format: "json" });
  const interval = opts.intervalSeconds
    ? Number.parseInt(opts.intervalSeconds, 10)
    : sessionFinalizationConfig(root).reconcileIntervalSeconds;
  if (!Number.isSafeInteger(interval) || interval < 1) {
    return failCommand("invalid_interval", "interval-seconds must be a positive integer");
  }
  let stopped = false;
  do {
    emit.data(reconcileSessionFinalizationV3(root));
    if (!opts.watch || stopped) return;
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, interval * 1_000);
      const stop = () => {
        stopped = true;
        clearTimeout(timer);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolvePromise();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } while (opts.watch && !stopped);
}

function runObserveArchive(opts: {
  adapter: string;
  sessionId: string;
  unarchived?: boolean;
  observedAt?: string;
}) {
  const root = monorepoRoot();
  if (!root) return failCommand("not_in_repo", "not in an agent session");
  if (!(["claude-code", "codex", "cursor"] as string[]).includes(opts.adapter)) {
    return failCommand("invalid_adapter", "adapter must be claude-code, codex, or cursor");
  }
  const adapter = opts.adapter as "claude-code" | "codex" | "cursor";
  const observedAt = opts.observedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(observedAt))) {
    return failCommand("invalid_observed_at", "observed-at must be an ISO timestamp");
  }
  emit.data(
    reconcileSessionFinalizationV3(root, {
      now: new Date(observedAt),
      archive_observations: [
        {
          adapter,
          native_session_id: opts.sessionId,
          archived: !opts.unarchived,
          observed_at: observedAt,
        },
      ],
    }),
  );
}

function runObserveHostDisappeared(opts: {
  instanceId: string;
  generationId: string;
  observedAt?: string;
}) {
  const root = monorepoRoot();
  if (!root) return failCommand("not_in_repo", "not in an agent session");
  if (!/^inst_[A-Za-z0-9._-]+$/.test(opts.instanceId)) {
    return failCommand("invalid_instance_id", "invalid V3 instance id");
  }
  if (!/^gen_[A-Za-z0-9._-]+$/.test(opts.generationId)) {
    return failCommand("invalid_generation_id", "invalid V3 generation id");
  }
  const observedAt = opts.observedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(observedAt))) {
    return failCommand("invalid_observed_at", "observed-at must be an ISO timestamp");
  }
  emit.data(
    observeHostDisappearedV3({
      coordRoot: root,
      instance_id: opts.instanceId as `inst_${string}`,
      generation_id: opts.generationId as `gen_${string}`,
      observed_at: observedAt,
    }),
  );
}

function failCommand(code: string, message: string): void {
  emit.error({ code, message });
  process.exitCode = 1;
}

function registerIdentityCommands(parent: Command): void {
  const identity = parent
    .command("identity")
    .description(
      "Agent persona registry: durable UUIDs per agent, independent of " +
        "per-session instance_ids. Storage: .harnery/identities/<id>.json.",
    );

  identity
    .command("list")
    .description("List every known agent identity (sorted by created_at).")
    .option("--json", "JSON envelope output")
    .action((opts: { json?: boolean }) => {
      if (opts.json) emit.config({ format: "json" });
      const rows = listIdentities().map((id) => ({
        agent_id: id.agent_id,
        name: id.name,
        display_name: displayAgentName(id.name),
        aliases: id.aliases,
        created_at: id.created_at,
      }));
      emit.data({ rows, meta: { count: rows.length } });
      if (!opts.json) {
        for (const r of rows) {
          emit.text(`${r.agent_id}  ${r.display_name}  (since ${r.created_at})\n`);
        }
      }
    });

  identity
    .command("show <name-or-id>")
    .description("Show one identity by display name or agent_id. Accepts both.")
    .option("--json", "JSON envelope output")
    .action((arg: string, opts: { json?: boolean }) => {
      if (opts.json) emit.config({ format: "json" });
      const trimmed = arg.trim();
      const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
        ? lookupIdentityById(trimmed)
        : null;
      const identity = byId ?? lookupIdentityByName(trimmed);
      if (!identity) {
        emit.error({
          code: "identity_not_found",
          message: `no identity matching '${arg}'`,
        });
        process.exit(1);
      }
      emit.data({
        rows: [
          {
            agent_id: identity.agent_id,
            name: identity.name,
            display_name: displayAgentName(identity.name),
            aliases: identity.aliases,
            created_at: identity.created_at,
          },
        ],
        meta: { action: "identity-show" },
      });
    });

  identity
    .command("ensure <name>")
    .description(
      "Resolve an identity by display name, minting a new one if absent. " +
        "Idempotent. Prints the agent_id to stdout, useful from bash hooks.",
    )
    .option("--json", "JSON envelope output")
    .option(
      "--id-only",
      "Print just the bare uuid (no newline, no envelope) for shell substitution",
    )
    .action((name: string, opts: { json?: boolean; idOnly?: boolean }) => {
      if (opts.json) emit.config({ format: "json" });
      const id = ensureIdentity(name);
      if (opts.idOnly) {
        process.stdout.write(id.agent_id); // lint-ok-emission: --id-only is a shell-substitution affordance for bash hooks; ctx() framing (newline) would break `id=$(harn agents identity ensure Foo --id-only)`
        return;
      }
      emit.data({
        rows: [
          {
            agent_id: id.agent_id,
            name: id.name,
            display_name: displayAgentName(id.name),
            aliases: id.aliases,
            created_at: id.created_at,
          },
        ],
        meta: { action: "identity-ensure" },
      });
    });

  identity
    .command("assume <name-or-id>")
    .description(
      "Bind this live session to a durable persona. Reclaims an abandoned " +
        "local namesake (no live process); refuses when another live process " +
        "or known remote session still holds the name. Updates name history, " +
        "the event ledger, and the heartbeat.",
    )
    .option("--json", "JSON envelope output")
    .option(
      "--session-id <id>",
      "Bind the heartbeat with this session_id directly, bypassing the ppid walk.",
    )
    .option(
      "--force-ancestor",
      "Allow assuming a persona this session's fork lineage descends from " +
        "(default: refused, because a fork's inherited transcript asserting that " +
        "name is not a role handoff).",
    )
    .action(
      (target: string, opts: { json?: boolean; sessionId?: string; forceAncestor?: boolean }) => {
        runIdentityAssume(target, opts);
      },
    );
}

function runIdentityAssume(
  target: string,
  opts: { json?: boolean; sessionId?: string; forceAncestor?: boolean },
): void {
  if (opts.json) emit.config({ format: "json" });
  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }
  if (!opts.sessionId) ensureAdapterSession(root);
  const owner = opts.sessionId ?? resolveOwner();
  if (!owner) {
    emit.error(
      sessionResolutionFailure(
        root,
        "not in an agent session; ppid walk found no pid-map entry (pass --session-id to bypass)",
      ),
    );
    process.exit(1);
  }
  try {
    const result = assumeIdentity(root, owner, target, {
      forceAncestor: opts.forceAncestor ?? false,
    });
    emit.data({
      ...result,
      display_name: displayAgentName(result.name),
      action: "identity-assume",
    });
  } catch (error) {
    if (error instanceof IdentityAssumeError) {
      emit.error({ code: error.code, message: error.message });
    } else {
      emit.error({
        code: "identity_assume_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    process.exit(1);
  }
}

export function registerCouncilCommands(parent: Command): void {
  const council = parent
    .command("council")
    .description(
      "Multi-agent deliberation: convene a temporary group around an " +
        "objective, run N rounds of contribution, emit a transcript.",
    );

  council
    .command("create <objective>")
    .description(
      "Create a council with the given objective. Members listed as " +
        "agent-Name (or bare Name; agent- prefix added automatically).",
    )
    .requiredOption("--members <list>", "Comma-separated member names (e.g. 'Juno,Dahlia,Codex')")
    .option(
      "--target-doc <path>",
      "Monorepo-relative path to a doc the council is reviewing (optional)",
    )
    .option(
      "--steward <member>",
      "Designate one member as the council steward, the ongoing process-tender " +
        "who drafts per-round prompts for each contributor. Defaults to the convener. " +
        "Must be a member of the council. agent- prefix added automatically.",
    )
    .option(
      "--auto-advance",
      "Auto-fire `council advance` when all members have contributed to the current round",
    )
    .option(
      "--created-by <name>",
      "Override the convener name. Defaults to the running agent's name. Used " +
        "by the web UI council-create flow where the HTTP request has no agent " +
        "identity. The operator picks a convener (typically the steward) and " +
        "the API passes it through. agent- prefix added automatically.",
    )
    .option("--json", "JSON envelope output")
    .action(
      (
        objective: string,
        opts: {
          members: string;
          targetDoc?: string;
          steward?: string;
          autoAdvance?: boolean;
          createdBy?: string;
          json?: boolean;
        },
      ) => {
        runCouncilCreate(objective, opts);
      },
    );

  council
    .command("list")
    .description(
      "List councils. Default: every council in .harnery/councils/ (archive excluded). " +
        "--mine filters to councils I'm a member of.",
    )
    .option("--status <status>", "Filter by status: active | closed | archived")
    .option("--mine", "Only councils that include me as a member")
    .option("--json", "JSON envelope output")
    .action((opts: { status?: string; mine?: boolean; json?: boolean }) => {
      runCouncilList(opts);
    });

  council
    .command("show <id>")
    .description(
      "Print one council's manifest + invite + (when round > 1) prior-rounds transcript. " +
        "Accepts a partial id prefix.",
    )
    .option("--json", "JSON envelope output")
    .action((id: string, opts: { json?: boolean }) => {
      runCouncilShow(id, opts);
    });

  council
    .command("close <id>")
    .description(
      "Close a council: status → closed, closed_at stamped, transcript " +
        "printed to stdout. Does NOT archive (use `archive` for that).",
    )
    .option("--json", "JSON envelope output")
    .action((id: string, opts: { json?: boolean }) => {
      runCouncilClose(id, opts);
    });

  council
    .command("archive <id>")
    .description(
      "Archive a council: status → archived, archived_at stamped, manifest + " +
        "body dir moved to .harnery/councils/archive/. Idempotent.",
    )
    .option("--json", "JSON envelope output")
    .action((id: string, opts: { json?: boolean }) => {
      runCouncilArchive(id, opts);
    });

  council
    .command("unarchive <id>")
    .description(
      "Reverse of archive: move manifest + body dir back to active, drop " +
        "archived_at, restore status from closed_at (closed if set, else " +
        "active). Idempotent. Useful for testing the archive flow.",
    )
    .option("--json", "JSON envelope output")
    .action((id: string, opts: { json?: boolean }) => {
      runCouncilUnarchive(id, opts);
    });

  council
    .command("delete <id>")
    .description(
      "Permanently delete an archived council (manifest + body dir). " +
        "Refuses unless the council is in .harnery/councils/archive/; " +
        "archive it first (trash-can pattern). Without --yes this prints " +
        "the paths that would be removed and exits 0 without touching " +
        "anything. Does NOT touch target_doc, close_handoff_path, or " +
        "the canonical V3 event ledger, which is owned independently.",
    )
    .option("-y, --yes", "Required to actually delete; without this, dry-run")
    .option("--json", "JSON envelope output")
    .action((id: string, opts: { yes?: boolean; json?: boolean }) => {
      runCouncilDelete(id, opts);
    });

  council
    .command("set-steward <id> [steward]")
    .description(
      "Reassign the steward on an active or closed council. Pass --clear " +
        "(or omit [steward]) to drop the field and revert to the default " +
        "(the convener). Refuses to mutate archived councils. By default, " +
        "rejects names not in the known-agents list (active heartbeats + " +
        "journals archived in the last 30 days); pass --allow-unknown " +
        "to bypass when bootstrapping.",
    )
    .option("--clear", "Clear the steward field, reverting to created_by default")
    .option(
      "--allow-unknown",
      "Skip the known-agents check (bootstrap an agent that hasn't run yet)",
    )
    .option("--json", "JSON envelope output")
    .action(
      (
        id: string,
        steward: string | undefined,
        opts: { clear?: boolean; allowUnknown?: boolean; json?: boolean },
      ) => {
        runCouncilSetSteward(id, steward, opts);
      },
    );

  council
    .command("contribute <id>")
    .description(
      "Contribute the running agent's take for the council's current round. " +
        "Pass either --message <inline> or --file <path>. Writes to " +
        ".harnery/councils/<id>/round-<N>/<agent-Name>.md. Pass --as <member> " +
        "to contribute under a council seat name that differs from the running " +
        "agent's heartbeat name (useful for cross-adapter councils where each " +
        "reviewer has a different auto-generated session name).",
    )
    .option("--message <text>", "Inline contribution text (caps at 4KB)")
    .option("--file <path>", "Path to a file containing the contribution")
    .option(
      "--as <member>",
      "Contribute under this council seat name instead of the running agent's " +
        "heartbeat name. Must be a member of the council. agent- prefix added " +
        "automatically.",
    )
    .option("--json", "JSON envelope output")
    .action(
      (id: string, opts: { message?: string; file?: string; as?: string; json?: boolean }) => {
        runCouncilContribute(id, opts);
      },
    );

  council
    .command("prompt <id> <member>")
    .description(
      "Steward-only: write or replace the round-<N> prompt for one member. " +
        "Saved to .harnery/councils/<id>/round-<N>/prompts/<agent-Name>.md, " +
        "rendered on the council page in the web UI, and auto-dimmed once that " +
        "member's contribution lands. Use --message <inline> or --file <path>. " +
        "<member> accepts bare 'Codex' or 'agent-Codex'.",
    )
    .option("--message <text>", "Inline prompt text (caps at 4KB)")
    .option("--file <path>", "Path to a file containing the prompt")
    .option(
      "--as <steward>",
      "Override the running agent's identity for the steward authority check. " +
        "Same shape as `contribute --as`, useful when scripting from outside " +
        "the steward's session.",
    )
    .option("--json", "JSON envelope output")
    .action(
      (
        id: string,
        member: string,
        opts: {
          message?: string;
          file?: string;
          as?: string;
          json?: boolean;
        },
      ) => {
        runCouncilPrompt(id, member, opts);
      },
    );

  council
    .command("status <id>")
    .description("Report round-N progress: who has contributed, who's pending.")
    .option("--json", "JSON envelope output")
    .action((id: string, opts: { json?: boolean }) => {
      runCouncilStatus(id, opts);
    });

  council
    .command("advance <id>")
    .description(
      "Advance the council to the next round. By default requires every " +
        "member to have contributed; --force drops no-shows for the round.",
    )
    .option(
      "--force",
      "Advance even when some members have not contributed (those members are dropped from THIS round's transcript; they can rejoin next round)",
    )
    .option("--json", "JSON envelope output")
    .action((id: string, opts: { force?: boolean; json?: boolean }) => {
      runCouncilAdvance(id, opts);
    });
}

function runWhoami(opts: { json?: boolean }): void {
  if (opts.json) emit.config({ format: "json" });

  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }

  ensureAdapterSession(root);
  const resolved = resolveOwnerWithSource();
  const myOwner = resolved.owner;
  if (!myOwner) {
    emit.error(
      sessionResolutionFailure(root, "not in an agent session; ppid walk found no pid-map entry"),
    );
    process.exit(1);
  }

  const hb = readLiveCoordinationRow(root, myOwner);
  if (!hb) {
    emit.error({
      code: "no_live_generation",
      message: noLiveGenerationMessage(myOwner),
    });
    process.exit(1);
  }

  const row: Row = {
    name: hb.name || "unknown",
    agent_id: hb.agent_id || null,
    instance_id: hb.instance_id,
    session_id: hb.session_id,
    kind: normalizeKind(hb.kind),
    relation: "self",
    started_at: hb.started_at ?? hb.last_heartbeat,
    last_heartbeat: hb.last_heartbeat,
    files_touched: hb.files_touched ?? [],
    task: hb.task ?? null,
    activity: activityOf(hb),
    activity_updated_at: hb.activity_updated_at ?? null,
    activity_source: hb.activity_source ?? null,
    task_state: taskStateOf(hb),
    task_state_scope: "current",
    task_state_updated_at: hb.task_state_updated_at ?? null,
    task_state_reason: hb.task_state_reason ?? null,
    platform: hb.platform ?? "claude-code",
  };

  emit.data({ ...row, resolution_source: resolved.source, note: SUBAGENT_NOTE });

  if (process.stdout.isTTY && !opts.json) {
    emit.text(`resolved via: ${resolved.source}\n`);
    emit.text(`note: ${SUBAGENT_NOTE}\n`);
  }
}

function runList(opts: { all?: boolean; stale?: boolean; json?: boolean }): void {
  if (opts.json) emit.config({ format: "json" });

  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }

  // Resolve self for relation column; best-effort, missing → "unknown" on every row.
  const myOwner = resolveOwner();
  const myHb = myOwner ? readLiveCoordinationRow(root, myOwner) : null;
  const mySession = myHb?.session_id ?? null;

  const generations = readLiveCoordinationRows(root);

  // Apply staleness filter unless --stale.
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - freshnessCutoffSecs();
  const live = opts.stale
    ? generations
    : generations.filter((h) => {
        const ts = Date.parse(h.last_heartbeat);
        return Number.isFinite(ts) && ts / 1000 >= cutoff;
      });

  // Build fold map: parent instance_id → array of files contributed by transient stubs.
  const fold = new Map<string, string[]>();
  for (const h of live) {
    if (normalizeKind(h.kind) === "transient") {
      const parentOwner = h.session_id;
      const existing = fold.get(parentOwner) ?? [];
      fold.set(parentOwner, [...existing, ...(h.files_touched ?? [])]);
    }
  }

  // Track which transients have a known parent (for orphan detection).
  const knownOwners = new Set(
    live.filter((h) => normalizeKind(h.kind) !== "transient").map((h) => h.instance_id),
  );

  // Build rows.
  const rows: Row[] = [];
  for (const h of live) {
    const kind = normalizeKind(h.kind);
    if (kind === "transient" && !opts.all) {
      // Folded into parent: skip rendering as own row UNLESS parent is missing
      // (orphan transient: render with parent's name + (transient) marker).
      if (knownOwners.has(h.session_id)) continue;
      // Orphan transient case
      rows.push({
        name: h.name || "unknown",
        agent_id: h.agent_id || null,
        instance_id: h.instance_id,
        session_id: h.session_id,
        kind: "transient",
        relation: relationOf(h, myOwner ?? "", mySession),
        started_at: h.started_at ?? h.last_heartbeat,
        last_heartbeat: h.last_heartbeat,
        files_touched: [...(h.files_touched ?? [])].sort(),
        task: h.task ?? null,
        activity: activityOf(h),
        activity_updated_at: h.activity_updated_at ?? null,
        activity_source: h.activity_source ?? null,
        task_state: taskStateOf(h),
        task_state_scope: "current",
        task_state_updated_at: h.task_state_updated_at ?? null,
        task_state_reason: h.task_state_reason ?? null,
        platform: h.platform ?? "claude-code",
      });
      continue;
    }
    // Non-transient row, or --all forces transients to show as own rows.
    let files = [...(h.files_touched ?? [])];
    if (kind !== "transient" && !opts.all) {
      const folded = fold.get(h.instance_id) ?? [];
      files = Array.from(new Set([...files, ...folded])).sort();
    }
    rows.push({
      name: h.name || "unknown",
      agent_id: h.agent_id || null,
      instance_id: h.instance_id,
      session_id: h.session_id,
      kind: normalizeKind(h.kind),
      relation: relationOf(h, myOwner ?? "", mySession),
      started_at: h.started_at ?? h.last_heartbeat,
      last_heartbeat: h.last_heartbeat,
      files_touched: files,
      task: h.task ?? null,
      activity: activityOf(h),
      activity_updated_at: h.activity_updated_at ?? null,
      activity_source: h.activity_source ?? null,
      task_state: taskStateOf(h),
      task_state_scope: "current",
      task_state_updated_at: h.task_state_updated_at ?? null,
      task_state_reason: h.task_state_reason ?? null,
      platform: h.platform ?? "claude-code",
    });
  }

  // Guard missing started_at so a partial observational projection cannot make
  // `harn agents list --all --stale` throw while sorting.
  rows.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));

  // Cross-machine presence (ADR 0016): append sessions on OTHER machines from
  // the locally-fetched presence refs. Advisory rows (relation=remote) — they
  // never participate in local claim blocking.
  for (const rm of readRemoteMachines(root)) {
    for (const a of rm.agents) {
      rows.push({
        name: a.name || "unknown",
        instance_id: a.instance_id,
        session_id: a.session_id ?? a.instance_id,
        kind: normalizeKind(a.kind),
        relation: "remote",
        started_at: a.started_at ?? "",
        last_heartbeat: a.last_heartbeat ?? "",
        files_touched: [...(a.files_touched ?? [])].sort(),
        task: a.task ?? null,
        activity: a.activity ?? "unknown",
        activity_updated_at: null,
        activity_source: null,
        task_state: a.task_state ?? "active",
        task_state_scope: "current",
        task_state_updated_at: null,
        task_state_reason: a.task_state_reason ?? null,
        platform: a.platform ?? "claude-code",
        machine: rm.machine,
      });
    }
  }

  // Emit. JSON format gets {rows, note}; TTY gets the rows with note as a footnote.
  emit.data({ rows, note: SUBAGENT_NOTE });
  if (process.stdout.isTTY && !opts.json) {
    emit.text(`note: ${SUBAGENT_NOTE}\n`);
  }
}

function relationOf(
  peer: Pick<LiveCoordinationRow, "instance_id" | "session_id">,
  myOwner: string,
  mySession: string | null,
): "self" | "group" | "blocks" | "unknown" {
  if (!mySession) return "unknown";
  if (peer.instance_id === myOwner) return "self";
  if (peer.session_id === mySession) return "group";
  return "blocks";
}

function normalizeKind(kind: string | undefined | null): string {
  if (kind === undefined || kind === null || kind === "") return "unknown";
  return kind;
}

/**
 * The `no_live_generation` diagnostic, quoting the owner id in full.
 *
 * This id is actionable: the reader may pass it to cache repair or explicit
 * finalization. Abbreviate ids for display elsewhere, never in a diagnostic
 * whose purpose is to hand the caller a canonical identity.
 */
function noLiveGenerationMessage(owner: string): string {
  return `resolved owner=${owner} but no authority-safe live V3 generation exists for it`;
}

/**
 * The instance_id of a live V3 generation that `prefix` strictly prefixes, or null.
 *
 * Used to recognize an abbreviated id handed back by a reader when the caller
 * supplied no canonical id of their own. Ambiguity is treated as "no answer":
 * two live sessions sharing the prefix means we cannot name the one intended,
 * and refusing with the wrong id in the message would be worse than the orphan.
 */
function liveIdWithPrefix(root: string, prefix: string): string | null {
  const matches = new Set<string>();
  for (const row of readLiveCoordinationRows(root)) {
    const id = row.instance_id;
    if (id !== prefix && id.startsWith(prefix)) matches.add(id);
  }
  return matches.size === 1 ? (matches.values().next().value as string) : null;
}

async function runWatch(pollMs: number): Promise<void> {
  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }
  const cache = new Map<string, LiveCoordinationRow>();

  // Seed cache + print an initial roster line per live peer.
  const initial = listLiveGenerations(root);
  process.stderr.write("watching authoritative V3 coordination state (Ctrl-C to exit)\n"); // lint-ok-emission: banner goes to stderr, stdout is the live stream
  for (const h of initial) {
    cache.set(h.instance_id, h);
    emitWatchLine(
      `agent-${h.name ?? "?"} present (${formatAge(secondsSince(h.started_at ?? h.last_heartbeat))} old${h.task ? `, task: "${h.task}"` : ""})`,
    );
  }

  const rescan = () => {
    const current = new Map<string, LiveCoordinationRow>();
    for (const h of listLiveGenerations(root)) current.set(h.instance_id, h);

    // Removed agents.
    for (const [id, old] of cache) {
      if (!current.has(id)) {
        emitWatchLine(`agent-${old.name ?? "?"} ended`);
        cache.delete(id);
      }
    }
    // Added or changed agents.
    for (const [id, h] of current) {
      const prev = cache.get(id);
      if (!prev) {
        emitWatchLine(
          `agent-${h.name ?? "?"} started (${formatAge(secondsSince(h.started_at ?? h.last_heartbeat))} old${h.task ? `, task: "${h.task}"` : ""})`,
        );
        cache.set(id, h);
        continue;
      }
      // Diff fields we care about.
      if ((prev.task ?? "") !== (h.task ?? "")) {
        emitWatchLine(`agent-${h.name ?? "?"} task: ${h.task ? `"${h.task}"` : "(cleared)"}`);
      }
      // File additions/removals.
      const prevFiles = new Set(prev.files_touched ?? []);
      const currFiles = new Set(h.files_touched ?? []);
      for (const f of currFiles) {
        if (!prevFiles.has(f)) emitWatchLine(`agent-${h.name ?? "?"} +claim ${f}`);
      }
      for (const f of prevFiles) {
        if (!currFiles.has(f)) emitWatchLine(`agent-${h.name ?? "?"} -release ${f}`);
      }
      cache.set(id, h);
    }
  };

  await new Promise<void>((resolveP) => {
    const timer = setInterval(rescan, Math.max(100, pollMs));
    const stop = () => {
      clearInterval(timer);
      resolveP();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function listLiveGenerations(root: string): LiveCoordinationRow[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - freshnessCutoffSecs();
  return readLiveCoordinationRows(root).filter((row) => {
    const ts = Date.parse(row.last_heartbeat);
    return Number.isFinite(ts) && ts / 1000 >= cutoff;
  });
}

function secondsSince(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 1000)) : 0;
}

function emitWatchLine(message: string): void {
  const time = formatLocalShort(new Date().toISOString());
  process.stdout.write(`[${time}] ${message}\n`); // lint-ok-emission: live event stream, per-line stdout flush; ctx() envelope serializes the whole stream and breaks the loop
}

async function runShow(name: string, opts: { json?: boolean }): Promise<void> {
  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }
  // Match authority-safe V3 generations by resolved display name.
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - freshnessCutoffSecs();
  const matches = readLiveCoordinationRows(root).filter((row) => {
    if ((row.name ?? "").toLowerCase() !== name.toLowerCase()) return false;
    const ts = Date.parse(row.last_heartbeat);
    return Number.isFinite(ts) && ts / 1000 >= cutoff;
  });

  if (matches.length === 0) {
    emit.error({
      code: "no_match",
      message: `no live agent named "${name}" (case-insensitive). Try \`${resolveBinName()} agents list\` to see who's active.`,
    });
    process.exit(1);
  }
  if (matches.length > 1) {
    emit.error({
      code: "ambiguous",
      message: `multiple live agents named "${name}" (${matches.length}). Disambiguation by instance_id not yet supported; rename or stop one.`,
    });
    process.exit(1);
  }
  const hb = matches[0];

  // Consumer-specific peer enrichment (e.g. BQ-backed claude-sessions history)
  // is intentionally out of scope here. Consumer CLIs that want richer
  // per-peer detail should plumb a `context.peerReport` callback in a future
  // revision; harn standalone reports the heartbeat data only.
  interface PeerReport {
    title: string | null;
    recent_prompts: { ts: string; text: string }[];
    recent_tools: { tool: string }[];
    tool_counts: { tool: string; count: number }[];
    total_events: number;
  }
  const report = null as PeerReport | null;
  const bqError = null as string | null;

  const startedAtMs = Date.parse(hb.started_at ?? hb.last_heartbeat);
  const ageSecs = Number.isFinite(startedAtMs)
    ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
    : 0;
  const heartbeatMs = Date.parse(hb.last_heartbeat);
  const heartbeatAgeSecs = Number.isFinite(heartbeatMs)
    ? Math.max(0, Math.floor((Date.now() - heartbeatMs) / 1000))
    : 0;

  const data = {
    name: hb.name ?? null,
    instance_id: hb.instance_id,
    session_id: hb.session_id,
    kind: normalizeKind(hb.kind),
    age_secs: ageSecs,
    last_heartbeat_secs_ago: heartbeatAgeSecs,
    task: hb.task ?? null,
    activity: activityOf(hb),
    activity_updated_at: hb.activity_updated_at ?? null,
    activity_source: hb.activity_source ?? null,
    task_state: taskStateOf(hb),
    task_state_scope: "current" as const,
    task_state_updated_at: hb.task_state_updated_at ?? null,
    task_state_reason: hb.task_state_reason ?? null,
    title: report?.title ?? null,
    files_held: hb.files_touched ?? [],
    recent_prompts: report?.recent_prompts ?? [],
    recent_tools: report?.recent_tools ?? [],
    tool_counts: report?.tool_counts ?? [],
    total_events: report?.total_events ?? 0,
    bq_error: bqError,
  };

  if (opts.json) {
    emit.config({ format: "json" });
    emit.data(data);
    return;
  }

  // Render text report.
  const lines: string[] = [];
  const subtitle = data.task
    ? `"${data.task}"`
    : data.title
      ? `"${data.title}"`
      : "(no task / title)";
  lines.push(`agent-${data.name}  ${subtitle}`);
  lines.push(
    `  session  ${formatAge(ageSecs)} old · kind=${data.kind} · session_id=${data.session_id.slice(0, 8)}…`,
  );
  lines.push(`  last heartbeat: ${formatAge(heartbeatAgeSecs)} ago`);
  lines.push(`  activity:       ${data.activity}`);
  lines.push(
    `  lifecycle:      ${data.task_state}${data.task_state === "blocked" && data.task_state_reason ? `: ${data.task_state_reason}` : ""}`,
  );
  if (data.files_held.length > 0) {
    lines.push(`  holds ${data.files_held.length} file(s):`);
    for (const f of data.files_held.slice(0, 10)) lines.push(`    ${f}`);
    if (data.files_held.length > 10) lines.push(`    +${data.files_held.length - 10} more`);
  }
  if (bqError) {
    lines.push("");
    lines.push(`  (claude-sessions BQ lookup failed: ${bqError})`);
  } else if (report) {
    lines.push("");
    lines.push(`  total events in BQ:  ${data.total_events}`);
    if (data.recent_prompts.length > 0) {
      lines.push("  recent user prompts:");
      for (const p of data.recent_prompts) {
        lines.push(
          `    ${formatLocalShort(p.ts)}  ${truncate(p.text.replace(/\s+/g, " ").trim(), 100)}`,
        );
      }
    }
    if (data.tool_counts.length > 0) {
      const summary = data.tool_counts
        .slice(0, 10)
        .map((t) => `${t.tool}(×${t.count})`)
        .join(", ");
      lines.push(`  tool usage (last 200 events): ${summary}`);
    }
    if (data.recent_tools.length > 0) {
      // Reverse so the sequence reads chronologically (oldest → newest).
      const recent = [...data.recent_tools]
        .reverse()
        .slice(-8)
        .map((t) => t.tool)
        .join(" → ");
      lines.push(`  recent tools:  ${recent}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`); // lint-ok-emission: multi-line text report; JSON branch returns early; this is the plain TTY path
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** "1:29 AM CDT": short local-time form for inline use. */
function formatLocalShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    hour12: true,
    timeZone: "America/Chicago",
  }).format(d);
}

function cursorEnvSessionId(): string | null {
  const raw = process.env.CURSOR_SESSION_ID?.trim() || process.env.CURSOR_CONVERSATION_ID?.trim();
  if (!raw) return null;
  return raw.startsWith("bc-") && raw.length > 3 ? raw.slice(3) : raw;
}

interface CommandSessionBootstrap {
  adapter: "cursor" | "codex";
  sessionId: string;
}

function commandSessionBootstrap(): CommandSessionBootstrap | null {
  const cursorSessionId = cursorEnvSessionId();
  if (process.env.CURSOR_AGENT === "1" && cursorSessionId) {
    return { adapter: "cursor", sessionId: cursorSessionId };
  }
  if (process.env.HARNERY_AGENT_COORD_BRIDGE?.trim() === "codex-wsl") {
    const sessionId = sessionIdentityFromEnv();
    if (sessionId) return { adapter: "codex", sessionId };
  }
  return null;
}

function ensureAdapterSession(root: string): void {
  const bootstrap = commandSessionBootstrap();
  if (!bootstrap) return;
  // Explicit owner override means the caller already knows who they are.
  // Bootstrapping sessionStart inherits that env into the child hook, which
  // re-projects a fresh heartbeat onto the override owner and can wipe an
  // assumed persona agent_id (seen under Cursor integration fixtures).
  if (bootstrap.adapter === "cursor" && process.env.HARNERY_AGENT_COORD_OWNER?.trim()) return;
  if (resolveOwnerBySessionEnv(root)) return;

  const agentHook = coordBinPath("agent-hook", root);
  if (!agentHook) return;

  const payload = JSON.stringify({
    ...(bootstrap.adapter === "cursor" ? { conversation_id: bootstrap.sessionId } : {}),
    session_id: bootstrap.sessionId,
    hook_event_name: "sessionStart",
    workspace_roots: [root],
    cwd: root,
    ...(bootstrap.adapter === "cursor"
      ? { composer_mode: "agent", is_background_agent: false }
      : { source: "resume" }),
  });

  spawnSync("bash", [agentHook, "session-start", "--adapter", bootstrap.adapter], {
    input: payload,
    cwd: root,
    encoding: "utf8",
    timeout: 3000,
    env: {
      ...process.env,
      HARNERY_AGENT_COORD_PLATFORM: bootstrap.adapter,
      HARNERY_COORD_ROOT_OVERRIDE: root,
      HARNERY_AGENT_COORD_SESSION_ID: bootstrap.sessionId,
      ...(bootstrap.adapter === "cursor"
        ? {
            CURSOR_SESSION_ID: bootstrap.sessionId,
            CURSOR_CONVERSATION_ID: bootstrap.sessionId,
          }
        : { CODEX_THREAD_ID: bootstrap.sessionId }),
    },
  });
}

function sessionResolutionFailure(
  root: string,
  fallbackMessage: string,
): { code: string; message: string } {
  if (!sessionIdentityFromEnv()) return { code: "no_pidmap_entry", message: fallbackMessage };
  const control = readEventV3ControlState(root);
  if (control.state !== "candidate" && control.state !== "active") {
    const detail = `${control.state}:${control.reason}`;
    return {
      code: "event_v3_control_unavailable",
      message: `the adapter session identity is present, but the V3 control state cannot accept session onboarding (${detail})`,
    };
  }
  return {
    code: "session_generation_unavailable",
    message:
      "the adapter session identity is present, but no current V3 session generation was available after onboarding",
  };
}

function runReleaseClaim(path: string): void {
  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }
  const myOwner = resolveOwner();
  if (!myOwner) {
    emit.error(
      sessionResolutionFailure(root, "not in an agent session; ppid walk found no pid-map entry"),
    );
    process.exit(1);
  }
  // Canonicalize: absolute paths under coordRoot get the prefix stripped;
  // relative paths pass through unchanged.
  let canonical = path;
  if (path.startsWith(`${root}/`)) canonical = path.slice(root.length + 1);

  const helper = agentCoordOrExit(root);
  const result = spawnSync(helper, ["release-claim", myOwner, canonical], {
    encoding: "utf8",
    ...coordHelperOpts(root),
  });
  if (result.status !== 0) {
    emit.error({
      code: "release_claim_failed",
      message: spawnFailureMessage(result, "agent-coord"),
    });
    process.exit(1);
  }
  process.stdout.write(result.stdout); // lint-ok-emission: raw JSON pass-through from agent-coord release-claim; mirrors runSetTask which writes the same envelope
}

function runSetTask(task: string, opts?: { sessionId?: string }): void {
  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }
  // Identity: prefer explicit --session-id (the ppid-walk-free escape hatch,
  // mirrors `status`), fall back to the ppid walk. Cursor shell tool calls
  // don't descend from a pid-map-registered anchor, so the walk can miss there.
  // Final fallback: the adapter/connector-stamped session id from the
  // environment. set-task is the session's REGISTRATION point — a fresh
  // (bridge) session has no heartbeat yet, so the heartbeat-validated resolver
  // returns null by design, and erroring here orphans the session's first
  // ritual command. The env id carries the same trust as an explicit
  // --session-id, and set-task mints the heartbeat exactly as that path does.
  if (!opts?.sessionId) ensureAdapterSession(root);
  const myOwner = opts?.sessionId ?? resolveOwner() ?? sessionIdentityFromEnv();
  if (!myOwner) {
    emit.error(
      sessionResolutionFailure(
        root,
        "not in an agent session; no session-id environment identity and the ppid walk found no pid-map entry (pass --session-id to bypass)",
      ),
    );
    process.exit(1);
  }

  // Snapshot BEFORE the mutation: the writer stamps `suggested_session_name`
  // on the session's first NON-EMPTY declaration (one source of truth: the
  // focus you declare names the session). A bare clear never consumes the
  // naming window, and subagent/workflow kinds are never named — see
  // heartbeat-writer.setTask. This call is the naming call exactly when the
  // stamp appears across the mutation.
  const priorHb = readCurrentCoordinationRow(myOwner);
  const normalizedTask = task.length > 0 ? task : undefined;
  const lifecycleWarning =
    priorHb && (priorHb.task_state ?? "active") !== "active" && priorHb.task !== normalizedTask
      ? `Task text changed while lifecycle is ${priorHb.task_state}; run \`${resolveBinName(root)} agents lifecycle active\` to reopen it explicitly.`
      : null;

  // Heartbeat mutation goes through agent-coord (atomic temp+rename).
  const helper = agentCoordOrExit(root);
  const result = spawnSync(helper, ["set-task", myOwner, task], {
    encoding: "utf8",
    ...coordHelperOpts(root),
  });
  if (result.status !== 0) {
    emit.error({
      code: "set_task_failed",
      message: spawnFailureMessage(result, "agent-coord"),
    });
    process.exit(1);
  }

  const hb = readCurrentCoordinationRow(myOwner);

  // The naming call: the mutation just stamped `suggested_session_name` for
  // the first time. `first_of_session: true` means exactly "this call produced
  // the session name" — it is never true with a null name (an empty first
  // declaration or a `--session-id` relay both keep the window open instead).
  // A native generation restart may rebuild the current cache during the
  // mutation and carry an already-seen suggestion from the prior generation.
  // That title is continuity evidence, not a new display request.
  const pendingName = sessionNameDisplayPending(hb);
  const firstSuggestedName = !priorHb?.suggested_session_name && pendingName ? pendingName : null;

  // Routine focus declarations stay title-silent. A pending display no longer
  // turns every repeated set-task into a fresh name instruction; explicit
  // recovery belongs to `agents suggest-name --json`.
  const suggestedName = firstSuggestedName;
  const firstOfSession = firstSuggestedName !== null;
  const sessionNameRetry = false;

  emit.data({
    instance_id: myOwner,
    name: hb?.name ?? null,
    task: hb?.task ?? null,
    cleared: !task || task.length === 0,
    first_of_session: firstOfSession,
    session_name_retry: sessionNameRetry,
    suggested_session_name: suggestedName,
    ...(lifecycleWarning ? { warning: lifecycleWarning } : {}),
    // Right-time instruction: the UserPromptSubmit nudge fires before the name
    // exists; this result is the moment the model holds the string.
    ...(suggestedName
      ? {
          note: SESSION_NAME_DISPLAY_NOTE,
        }
      : {}),
  });
}

function runLifecycle(rawState: string, opts: { reason?: string; sessionId?: string }): void {
  const state = rawState.trim().toLowerCase();
  if (state !== "active" && state !== "blocked" && state !== "done") {
    emit.error({
      code: "invalid_lifecycle_state",
      message: "lifecycle state must be one of: active, blocked, done",
    });
    process.exitCode = 1;
    return;
  }

  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exitCode = 1;
    return;
  }
  if (!opts.sessionId) ensureAdapterSession(root);
  const myOwner = opts.sessionId ?? resolveOwner() ?? sessionIdentityFromEnv();
  if (!myOwner) {
    emit.error(
      sessionResolutionFailure(
        root,
        "not in an agent session; ppid walk found no pid-map entry (pass --session-id to bypass)",
      ),
    );
    process.exitCode = 1;
    return;
  }

  let hb = readCurrentCoordinationRow(myOwner);
  let reopenedGeneration: ReturnType<typeof reopenLiveCoordinationGenerationV3> | undefined;
  if (!hb) {
    if (state !== "active") {
      emit.error({
        code: "no_live_generation",
        message: `${noLiveGenerationMessage(myOwner)}; run \`${resolveBinName(root)} agents lifecycle active\` to open a fresh generation`,
      });
      process.exitCode = 1;
      return;
    }
    try {
      reopenedGeneration = reopenLiveCoordinationGenerationV3({
        coordRoot: root,
        owner: myOwner,
        nativeSessionId: nativeSessionIdentity(readHeartbeatCache(root, myOwner), myOwner),
      });
    } catch (error) {
      emit.error({
        code: "lifecycle_reopen_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
      return;
    }
    hb = readCurrentCoordinationRow(myOwner);
    if (!hb) {
      emit.error({
        code: "lifecycle_reopen_failed",
        message: "the fresh generation was recorded but did not project as live",
      });
      process.exitCode = 1;
      return;
    }
  }
  if (hb.kind === "subagent" || hb.kind === "transient" || hb.workflow_run_id) {
    emit.error({
      code: "lifecycle_not_human_facing",
      message: "task lifecycle declarations are limited to human-facing sessions",
    });
    process.exitCode = 1;
    return;
  }

  const reason = opts.reason?.trim() || undefined;
  if (state === "blocked" && !reason) {
    emit.error({
      code: "blocked_reason_required",
      message: "lifecycle blocked requires --reason <text>",
    });
    process.exitCode = 1;
    return;
  }
  if (state === "done" && !hb.task) {
    emit.error({
      code: "task_required_for_done",
      message: "declare a current task with agents set-task before marking it done",
    });
    process.exitCode = 1;
    return;
  }

  const priorState: TaskState = hb.task_state ?? "active";
  const priorReason = hb.task_state_reason || undefined;
  if (reopenedGeneration) {
    emit.data({
      instance_id: myOwner,
      task_state: "active",
      prior_state: null,
      reason: null,
      changed: true,
      generation_reopened: true,
      prior_generation_id: reopenedGeneration.prior_generation_id,
      generation_id: reopenedGeneration.generation_id,
      name_reminted: false,
      suggested_session_name: null,
      git_finalization_checked: false,
    });
    return;
  }
  if (priorState === state && priorReason === reason) {
    emit.data({
      instance_id: myOwner,
      task_state: state,
      reason: reason ?? null,
      changed: false,
      name_reminted: false,
      git_finalization_checked: false,
    });
    return;
  }

  let finalization: GitFinalizationResult | null = null;
  if (state === "done") {
    const history = readSessionWriteClaims(
      root,
      hb.instance_id,
      nativeSessionIdentity(hb, myOwner),
    );
    const touchedPaths = [...new Set([...(hb.files_touched ?? []), ...history.paths])];
    finalization = checkGitFinalization(root, touchedPaths, {
      claimHistoryComplete: history.complete,
    });
    if (!finalization.ok) {
      emit.error({
        code: "git_not_finalized",
        message: formatGitFinalizationFailure(finalization, resolveBinName(root)).replace(
          "the status box was not issued",
          "lifecycle was not changed",
        ),
      });
      process.exitCode = 1;
      return;
    }
  }

  const suggestedName = buildLifecycleSuggestedName(hb.suggested_session_name, state);
  const nameReminted = suggestedName !== null && suggestedName !== hb.suggested_session_name;
  const emitted = emitEventV3({
    owner: myOwner,
    session: nativeSessionIdentity(hb, myOwner),
    adapter: normalizeAdapter(hb.platform),
    observation: {
      event_type: "coord.lifecycle_changed",
      new_state: state,
      ...(reason ? { reason } : {}),
      ...(nameReminted ? { suggested_session_name: suggestedName } : {}),
    },
  });
  if (!emitted) {
    emit.error({
      code: "lifecycle_event_failed",
      message: "the lifecycle event could not be recorded; heartbeat state was left unchanged",
    });
    process.exitCode = 1;
    return;
  }

  emit.data({
    instance_id: myOwner,
    task_state: state,
    prior_state: priorState,
    reason: reason ?? null,
    changed: true,
    name_reminted: nameReminted,
    suggested_session_name: nameReminted ? suggestedName : null,
    git_finalization_checked: finalization !== null,
    ...(nameReminted
      ? {
          note: SESSION_NAME_DISPLAY_NOTE,
        }
      : {}),
  });
}

function runSuggestName(
  descriptionParts: string[],
  opts: { json?: boolean; sessionId?: string },
): void {
  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }

  // Identity: prefer explicit --session-id (ppid-walk-free escape hatch, mirrors
  // `status`/`set-task`), fall back to the ppid walk for interactive shell use.
  if (!opts.sessionId) ensureAdapterSession(root);
  const myOwner = opts.sessionId ?? resolveOwner();
  if (!myOwner) {
    emit.error(
      sessionResolutionFailure(
        root,
        "not in an agent session; ppid walk found no pid-map entry (pass --session-id to bypass)",
      ),
    );
    process.exit(1);
  }

  const hb = readCurrentCoordinationRow(myOwner);
  const agentName = hb?.name || "unknown";
  // A bare suggest-name must prefer the exact pending suggestion over rebuilding
  // from the current task. The task may have changed since the title was minted;
  // reconstructing it would produce a block the display latch can never accept.
  // An explicit description keeps the read-only re-suggest behavior.
  const pendingName = sessionNameDisplayPending(hb);
  const parts = descriptionParts.length > 0 ? descriptionParts : hb?.task ? [hb.task] : [];
  const built =
    descriptionParts.length === 0 && pendingName
      ? { suggestedName: pendingName, description: hb?.task ?? pendingName }
      : buildSuggestedName(agentName, parts);
  if (!built) {
    emit.error({
      code: "no_description",
      message:
        'pass a 2-5 word topic (e.g. suggest-name "Auth Refactor"), or declare one first with set-task',
    });
    process.exit(1);
  }
  const { suggestedName, description } = built;
  const displayName = `agent-${agentName}`;

  if (opts.json) {
    emit.config({ format: "json" });
    emit.data({
      name: displayName,
      suggested_session_name: suggestedName,
      session_name_retry: pendingName === suggestedName,
      agent_name: agentName,
      description,
    });
    return;
  }

  // Emit the bare name only — no box. The agent reproduces this exact string in
  // a fenced code block in its reply, which every chat UI decorates with a
  // one-click Copy button so the operator can grab it without hand-selecting.
  // (A drawn box would copy its borders + labels too.) Direct write, not
  // emit.text: runs via Bash with no TTY, same chat-paste contract as runStatus.
  process.stdout.write(`${suggestedName}\n`); // lint-ok-emission: chat-paste path
}

function runStatus(opts: {
  endTurn?: boolean;
  endSession?: boolean;
  json?: boolean;
  sessionId?: string;
}): void {
  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }
  if (opts.endSession && !opts.endTurn) {
    emit.error({
      code: "end_session_requires_end_turn",
      message: "--end-session requires --end-turn so Git finalization is verified first",
    });
    process.exitCode = 1;
    return;
  }

  // Identity resolution: prefer explicit --session-id (hook-friendly), fall
  // back to ppid walk for interactive shell usage.
  if (!opts.sessionId) ensureAdapterSession(root);
  const myOwner = opts.sessionId ?? resolveOwner();
  if (!myOwner) {
    emit.error(
      sessionResolutionFailure(
        root,
        "not in an agent session; ppid walk found no pid-map entry (pass --session-id from a hook payload)",
      ),
    );
    process.exit(1);
  }

  const hb = readCurrentCoordinationRow(myOwner);
  if (!hb) {
    emit.error({
      code: "no_live_generation",
      message: noLiveGenerationMessage(myOwner),
    });
    process.exit(1);
  }

  // Report-only run quality: cheap config/cursor due check first, then a
  // non-blocking lazy evaluation. Shadow mode deliberately exposes no severity.
  const qualityEvaluation = evaluateRunQualityIfDue(root, new Date(), myOwner);
  const quality = qualityForStatus(
    qualityEvaluation.config.requested_mode,
    qualityEvaluation.snapshot,
  );

  let finalization: GitFinalizationResult | null = null;
  if (opts.endTurn) {
    const history = readSessionWriteClaims(
      root,
      hb.instance_id,
      nativeSessionIdentity(hb, myOwner),
    );
    const touchedPaths = [...new Set([...(hb.files_touched ?? []), ...history.paths])];
    finalization = checkGitFinalization(root, touchedPaths, {
      claimHistoryComplete: history.complete,
    });
    if (!finalization.ok) {
      emit.error({
        code: "git_not_finalized",
        message: formatGitFinalizationFailure(finalization, resolveBinName(root)),
      });
      process.exitCode = 1;
      return;
    }
  }

  emitEventV3({
    owner: myOwner,
    session: nativeSessionIdentity(hb, myOwner),
    adapter: normalizeAdapter(hb.platform),
    observation: {
      event_type: "coord.status_observed",
      status: opts.endTurn ? "end_turn_checked" : opts.json ? "json_checked" : "box_checked",
    },
  });

  let sessionEnd:
    | { state: "queued" | "already_requested"; request_id: string }
    | { state: "recorded" | "already_ended"; terminal_event_id?: string }
    | undefined;
  if (opts.endSession) {
    const canonicalInstanceId = liveInstanceIdV3(hb.instance_id);
    const records = listHookProducerStateRecordsV3(root, { includeTerminal: true }).filter(
      ({ state }) => state.instance_id === canonicalInstanceId,
    );
    if (records.length !== 1 || !records[0]) {
      emit.error({
        code: "session_identity_ambiguous",
        message: `expected one V3 generation for ${canonicalInstanceId}; found ${records.length}`,
      });
      process.exitCode = 1;
      return;
    }
    const state = records[0].state;
    const requested = requestSessionEndExplicitV3({
      coordRoot: root,
      instance_id: state.instance_id,
      generation_id: state.generation_id,
      outcome: "succeeded",
      coordination_finalized: true,
    });
    if (requested.state === "queued" || requested.state === "already_requested") {
      sessionEnd = { state: requested.state, request_id: requested.request.request_id };
    } else if (requested.state === "recorded") {
      sessionEnd = { state: requested.state, terminal_event_id: requested.event.event_id };
    } else if (requested.state === "already_ended") {
      sessionEnd = { state: requested.state, terminal_event_id: requested.event_id };
    } else {
      emit.error({ code: "session_end_failed", message: JSON.stringify(requested) });
      process.exitCode = 1;
      return;
    }
  }

  const startedAtMs = Date.parse(hb.started_at ?? hb.last_heartbeat);
  const ageSecs = Number.isFinite(startedAtMs)
    ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
    : 0;

  const { livePeers, stale: peersStale } = collectStatusPeerHealth(root, myOwner);

  // Sort: file-holders first (by file count desc), then idle peers by recency.
  livePeers.sort((a, b) => {
    const af = a.files_touched?.length ?? 0;
    const bf = b.files_touched?.length ?? 0;
    if (af !== bf) return bf - af;
    return Date.parse(b.last_heartbeat || "") - Date.parse(a.last_heartbeat || "");
  });

  const filesHeld = hb.files_touched ?? [];
  const filesStr = formatList(
    filesHeld.map((p) => basename(p)),
    4,
    "0 held",
  );
  // Cross-machine presence (ADR 0016): sessions on other machines, advisory.
  const remoteMachines = readRemoteMachines(root);
  const peersStr = formatPeers(livePeers, 4, peersStale, remoteMachines);

  const ctxUsage = readContextUsage(hb.native_session_id ?? hb.session_id, hb.platform);
  let ctxStr: string;
  if (!ctxUsage) {
    ctxStr = "unavailable";
  } else if (ctxUsage.percentOnly) {
    ctxStr = `${Math.round(ctxUsage.usedPercent)}% (Cursor first-party)`;
  } else {
    ctxStr = `${fmtTokens(ctxUsage.used)} / ${fmtTokens(ctxUsage.window)} (${Math.round(
      (ctxUsage.used / ctxUsage.window) * 100,
    )}%)`;
  }

  const timeStr = formatLocalTime(new Date());
  const displayName = agentDisplayName(hb.instance_id, hb.name);

  // Council pending: list of council IDs where this agent is a member of an
  // active council in `open` round_status without a contribution to that round.
  // Best-effort: fails silently if .harnery/councils/ doesn't exist.
  let pendingCouncils: string[] = [];
  try {
    pendingCouncils = pendingCouncilsForMember(displayName);
  } catch {
    /* non-fatal: status box should not fail on council errors */
  }

  const data = {
    name: displayName,
    instance_id: hb.instance_id,
    kind: normalizeKind(hb.kind),
    session_age_secs: ageSecs,
    activity: activityOf(hb),
    activity_updated_at: hb.activity_updated_at ?? null,
    activity_source: hb.activity_source ?? null,
    task_state: taskStateOf(hb),
    task_state_scope: "current" as const,
    task_state_updated_at: hb.task_state_updated_at ?? null,
    task_state_reason: hb.task_state_reason ?? null,
    files_held: filesHeld,
    peers_live: livePeers.length,
    peers_stale: peersStale,
    peers: livePeers.map((p) => ({
      name: p.name || "unnamed",
      files: p.files_touched?.length ?? 0,
    })),
    remote_machines: remoteMachines.map((m) => ({
      machine: m.machine,
      age_secs: m.age_secs,
      agents: m.agents.map((a) => ({
        name: a.name || "unnamed",
        task: a.task ?? null,
        activity: a.activity ?? "unknown",
        task_state: a.task_state ?? "active",
        task_state_reason: a.task_state_reason ?? null,
        files: a.files_touched?.length ?? 0,
      })),
    })),
    pending_councils: pendingCouncils,
    context_used: ctxUsage && "used" in ctxUsage ? ctxUsage.used : null,
    context_window: ctxUsage && "window" in ctxUsage ? ctxUsage.window : null,
    timestamp_iso: new Date().toISOString(),
    timestamp_local: timeStr,
    ...(quality ? { quality } : {}),
    ...(finalization ? { finalization } : {}),
    ...(sessionEnd ? { session_end: sessionEnd } : {}),
  };

  if (opts.json) {
    emit.config({ format: "json" });
    emit.data(data);
    return;
  }

  const rows: Array<[string, string]> = [
    ["session", formatAge(ageSecs)],
    ["activity", activityOf(hb)],
    ["lifecycle", lifecycleLabel(hb)],
    ["context", ctxStr],
    ["files", filesStr],
    ["peers", peersStr],
    ["time", timeStr],
  ];
  // Task gets full text; formatBox word-wraps to MAX_BOX_CONTENT_WIDTH.
  if (hb.task && hb.task.length > 0) {
    rows.splice(1, 0, ["task", hb.task]);
  }
  if (pendingCouncils.length > 0) {
    // Slot the council line right before `time` so it stays in the "what's
    // active for me" cluster of rows. Show the first ID + count; full list
    // available via `harn agents council list --mine`.
    const idx = rows.findIndex((r) => r[0] === "time");
    const summary =
      pendingCouncils.length === 1
        ? `1 pending (${pendingCouncils[0]})`
        : `${pendingCouncils.length} pending (${pendingCouncils[0]}, +${pendingCouncils.length - 1})`;
    rows.splice(idx, 0, ["council", summary]);
  }
  if (quality) {
    const idx = rows.findIndex((row) => row[0] === "time");
    rows.splice(idx, 0, ["quality", formatRunQuality(quality.status, quality.signal_ids)]);
  }
  if (sessionEnd) {
    const idx = rows.findIndex((row) => row[0] === "time");
    rows.splice(idx, 0, [
      "session end",
      sessionEnd.state === "queued" || sessionEnd.state === "already_requested"
        ? "queued after this turn"
        : "recorded",
    ]);
  }
  // Box rendering needs predictable stdout regardless of TTY/pipe detection:
  // agent runs this via Bash (no TTY) and pastes captured stdout into chat.
  process.stdout.write(`${formatBox(displayName, rows)}\n`); // lint-ok-emission: chat-paste path; emit.text() auto-suppresses non-TTY
}

function qualityForStatus(
  mode: "off" | "shadow" | "report",
  snapshot: RunQualitySnapshot | null,
): {
  status: RunQualityStatus;
  signal_ids: string[];
  evaluated_at: string | null;
  fresh: boolean;
} | null {
  if (mode !== "report") return null;
  const fresh = !!snapshot && Date.parse(snapshot.expires_at) > Date.now();
  if (!snapshot || !fresh) {
    return {
      status: "unknown",
      signal_ids: [],
      evaluated_at: snapshot?.evaluated_at ?? null,
      fresh: false,
    };
  }
  return {
    status: snapshot.status,
    signal_ids: snapshot.signals
      .filter((signal) => signal.state === "active" && signal.severity !== "none")
      .map((signal) => signal.id)
      .sort()
      .slice(0, 3),
    evaluated_at: snapshot.evaluated_at,
    fresh: true,
  };
}

function formatRunQuality(status: RunQualityStatus, signalIds: string[]): string {
  return signalIds.length > 0 ? `${status} (${signalIds.join(", ")})` : status;
}

function formatList(items: string[], cap: number, emptyLabel: string): string {
  if (items.length === 0) return emptyLabel;
  if (items.length <= cap) return items.join(", ");
  const shown = items.slice(0, cap).join(", ");
  return `${shown}, +${items.length - cap} more`;
}

function formatPeers(
  peers: StatusPeerHeartbeat[],
  cap: number,
  staleCount: number,
  remoteMachines: RemoteMachine[] = [],
): string {
  if (peers.length === 0 && staleCount === 0 && remoteMachines.length === 0) return "none";
  const labels = peers.map((p) => {
    const name = p.name || "unnamed";
    const plat = formatPlatformLabel(p.platform);
    const files = p.files_touched?.length ?? 0;
    const base = `${name} (${plat})`;
    return files > 0 ? `${base}, ${files} files` : base;
  });
  let main: string;
  if (labels.length === 0) {
    main = "0 live";
  } else if (labels.length <= cap) {
    main = labels.join(", ");
  } else {
    main = `${labels.slice(0, cap).join(", ")}, +${labels.length - cap} more`;
  }
  if (staleCount > 0) main = `${main}; ${staleCount} stale`;
  // Remote machines (presence transport): `Name @machine` labels, capped.
  if (remoteMachines.length > 0) {
    const remote = remoteMachines
      .flatMap((m) => m.agents.map((a) => `${a.name || "unnamed"} @${m.machine}`))
      .slice(0, cap);
    const extra = remoteMachines.reduce((n, m) => n + m.agents.length, 0) - remote.length;
    main = `${main}; ${remote.join(", ")}${extra > 0 ? `, +${extra} more` : ""}`;
  }
  return main;
}

type StatusPeerHeartbeat = {
  instance_id: string;
  last_heartbeat: string;
  files_touched?: string[];
  name?: string;
  platform?: string;
};

export function collectStatusPeerHealth(
  root: string,
  myOwner: string,
  nowMs = Date.now(),
  readRows: (root: string) => StatusPeerHeartbeat[] = readLiveCoordinationRows,
  freshnessSeconds = freshnessCutoffSecs(),
): { livePeers: StatusPeerHeartbeat[]; stale: number } {
  let rows: StatusPeerHeartbeat[] = [];
  try {
    rows = readRows(root);
  } catch {
    // V3 authority failures must not resurrect disposable cache rows.
  }

  const cutoffMs = nowMs - freshnessSeconds * 1000;
  const livePeers: StatusPeerHeartbeat[] = [];
  let stale = 0;
  for (const peer of rows) {
    if (peer.instance_id === myOwner) continue;
    const observedAtMs = Date.parse(peer.last_heartbeat);
    if (Number.isFinite(observedAtMs) && observedAtMs >= cutoffMs) livePeers.push(peer);
    else stale += 1;
  }
  return { livePeers, stale };
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1000000) return `${Math.round(n / 1000)}K`;
  const m = n / 1000000;
  return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
}

function readContextUsage(
  sessionId: string,
  platform?: string | null,
):
  | { used: number; window: number; percentOnly?: false }
  | { usedPercent: number; percentOnly: true }
  | null {
  if (!sessionId) return null;
  // Dispatch by platform: Codex's JSONL shape is different from Claude Code's
  // (event_msg/response_item vs user/assistant), and Codex transcripts live
  // under ~/.codex/sessions/YYYY/MM/DD/ rather than ~/.claude/projects/.
  // Cursor stores a first-party percentage in workspaceStorage. The shared
  // runtime reader returns it without fabricating a token denominator.
  if (platform === "codex") return readRuntimeContextUsage("codex", sessionId);
  if (platform === "cursor") {
    const telemetry = readRuntimeContextTelemetry({
      adapter: "cursor",
      session_id: sessionId,
      mode: "status",
    });
    return telemetry.state === "observed" && "used_percent" in telemetry
      ? { usedPercent: telemetry.used_percent, percentOnly: true }
      : null;
  }
  return readRuntimeContextUsage("claude-code", sessionId);
}

function formatLocalTime(d: Date): string {
  // "Sat, May 9, 2026, 3:48 AM CDT", rendered in the Chicago timezone.
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    hour12: true,
    timeZone: "America/Chicago",
  }).format(d);
}

function formatAge(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return `${d}d ${h}h`;
}

interface HealEvent {
  ts: string;
  agent: string;
  kind: "pidmap" | "heartbeat";
  pid?: string;
  reason: "missing" | "stale";
  prior?: string;
  platform: string;
}

/** Bounded diagnostic event shape projected from the canonical V3 ledger. */
export interface CanonicalEvent {
  event_type: EventTypeV3;
  ts: string;
  instance_id?: string;
  adapter?: string;
  payload?: Record<string, unknown>;
}

export interface AgentDiagnosticEventRead {
  source: "v3";
  authoritative: boolean;
  reason?: string;
  truncated: boolean;
  bytes: number;
  events: CanonicalEvent[];
}

/** Read validated canonical V3 events. */
export function readAgentDiagnosticEventsInWindow(
  root: string,
  cutoffMs: number,
): AgentDiagnosticEventRead {
  const control = readEventV3ControlState(root);
  if (control.state === "candidate" || control.state === "active") {
    const ledger = readLedgerV3(root);
    if (!ledger.complete) {
      return {
        source: "v3",
        authoritative: false,
        reason: `V3 ledger validation failed: ${ledger.diagnostics.map((item) => item.code).join(", ") || "incomplete"}`,
        truncated: false,
        bytes: ledger.bytes,
        events: [],
      };
    }
    const events: CanonicalEvent[] = [];
    for (const { event } of ledger.events) {
      const tsMs = Date.parse(event.time.recorded_at);
      if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
      events.push({
        event_type: event.event_type,
        ts: event.time.recorded_at,
        instance_id: event.scope.instance_id,
        payload: event.payload as Record<string, unknown>,
      });
    }
    return {
      source: "v3",
      authoritative: true,
      truncated: false,
      bytes: ledger.bytes,
      events,
    };
  }
  return {
    source: "v3",
    authoritative: false,
    reason: `V3 control state is ${control.state}`,
    truncated: false,
    bytes: 0,
    events: [],
  };
}

/** Normalize adapter event data into the heartbeat platform value. */
function adapterToPlatform(adapter: string | undefined): string {
  if (adapter === "claude-code") return "claude-code";
  if (adapter === "cursor") return "cursor";
  if (adapter === "codex") return "codex";
  return "unknown";
}

/** Project a canonical health.* event into the HealEvent shape the aggregators
 * already consume. Returns null for non-heal events. instance_id → display name
 * via `nameById` (full-UUID keyed). */
function canonicalToHealEvent(ev: CanonicalEvent, nameById: Map<string, string>): HealEvent | null {
  if (ev.event_type !== "health.observed") {
    return null;
  }
  const data = ev.payload ?? {};
  const subsystem = typeof data.subsystem === "string" ? data.subsystem : "";
  if (subsystem !== "pidmap" && subsystem !== "heartbeat") return null;
  const kind = subsystem;
  const reason: "missing" | "stale" = data.condition === "stale" ? "stale" : "missing";
  const instanceId = ev.instance_id ?? "";
  const name = nameById.get(instanceId);
  const agent = name ? `agent-${name}` : `agent-${instanceId.slice(0, 8) || "unknown"}`;
  const out: HealEvent = {
    ts: ev.ts,
    agent,
    kind,
    reason,
    platform: adapterToPlatform(ev.adapter),
  };
  if (kind === "pidmap" && data.pid !== undefined && data.pid !== null) {
    out.pid = String(data.pid);
  }
  if (typeof data.prior === "string") out.prior = data.prior;
  return out;
}

/** Build a full-instance_id → display-name map from .name-history (one JSON
 * object per line). Used to label canonical heal events. */
function buildNameById(root: string): Map<string, string> {
  const nameById = new Map<string, string>();
  const nameHistoryPath = resolve(root, ".harnery/.name-history");
  if (!existsSync(nameHistoryPath)) return nameById;
  for (const line of readFileSync(nameHistoryPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { instance_id?: string; name?: string };
      if (entry.instance_id && entry.name) nameById.set(entry.instance_id, entry.name);
    } catch {
      /* skip */
    }
  }
  return nameById;
}

// Parse Nh|Nd window into seconds. Returns null on malformed input.
function parseWindowSecs(window: string): number | null {
  const match = window.match(/^(\d+)([hd])$/);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  const unit = match[2];
  if (!Number.isFinite(n) || n <= 0) return null;
  return unit === "h" ? n * 3600 : n * 86400;
}

function runHealEvents(opts: {
  since: string;
  limit: string;
  json?: boolean;
  csv?: boolean;
}): void {
  if (opts.json) emit.config({ format: "json" });

  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }

  const sinceSecs = parseWindowSecs(opts.since);
  if (sinceSecs === null) {
    emit.error({
      code: "bad_since",
      message: `invalid --since value '${opts.since}': expected Nh or Nd (e.g. 24h, 7d)`,
    });
    process.exit(1);
  }

  const limit = Number.parseInt(opts.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    emit.error({
      code: "bad_limit",
      message: `invalid --limit value '${opts.limit}': expected positive integer`,
    });
    process.exit(1);
  }

  // Heal telemetry is read from the canonical V3 ledger.
  const cutoffMs = Date.now() - sinceSecs * 1000;
  const nameById = buildNameById(root);
  const events: HealEvent[] = [];
  const diagnosticEvents = readAgentDiagnosticEventsInWindow(root, cutoffMs);
  for (const ev of diagnosticEvents.events) {
    const heal = canonicalToHealEvent(ev, nameById);
    if (heal) events.push(heal);
  }

  // Aggregate.
  const byReason: Record<string, number> = { missing: 0, stale: 0 };
  const byKind: Record<string, number> = { pidmap: 0, heartbeat: 0 };
  const byPlatform: Record<string, number> = {};
  const byAgent = new Map<string, number>();
  const buckets: Record<string, number> = {
    last_1h: 0,
    last_24h: 0,
    last_7d: 0,
  };
  const nowMs = Date.now();
  for (const ev of events) {
    byReason[ev.reason] = (byReason[ev.reason] ?? 0) + 1;
    byKind[ev.kind] = (byKind[ev.kind] ?? 0) + 1;
    byPlatform[ev.platform] = (byPlatform[ev.platform] ?? 0) + 1;
    byAgent.set(ev.agent, (byAgent.get(ev.agent) ?? 0) + 1);
    const ageMs = nowMs - Date.parse(ev.ts);
    if (ageMs <= 3600 * 1000) buckets.last_1h++;
    if (ageMs <= 24 * 3600 * 1000) buckets.last_24h++;
    if (ageMs <= 7 * 86400 * 1000) buckets.last_7d++;
  }

  const byAgentSorted = Array.from(byAgent.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([agent, count]) => ({ agent, count }));

  // Most-recent first for the events table.
  events.sort((a, b) => b.ts.localeCompare(a.ts));
  const recent = events.slice(0, limit);

  const data = {
    since: opts.since,
    telemetry: {
      source: diagnosticEvents.source,
      authoritative: diagnosticEvents.authoritative,
      reason: diagnosticEvents.reason,
    },
    total: events.length,
    by_reason: byReason,
    by_kind: byKind,
    by_platform: byPlatform,
    by_agent: byAgentSorted,
    by_time_bucket: buckets,
    events: recent,
  };

  if (opts.csv) {
    emit.config({ format: "csv" });
    emit.data(
      data.telemetry.authoritative
        ? recent
        : [
            {
              status: "unavailable",
              source: data.telemetry.source,
              reason: data.telemetry.reason,
            },
          ],
    );
    return;
  }
  if (opts.json) {
    emit.data(data);
    return;
  }
  emit.data(data);

  // TTY rendering: table-ish summary + recent events.
  if (process.stdout.isTTY) {
    const lines: string[] = [];
    lines.push(
      `Heal events: ${events.length} total in last ${opts.since} (health.pidmap_heal + health.heartbeat_heal)`,
    );
    if (!data.telemetry.authoritative) {
      lines.push(
        `  unavailable: ${data.telemetry.reason ?? "diagnostic event source is incomplete"}`,
      );
      emit.text(`${lines.join("\n")}\n`);
      return;
    }
    lines.push("");
    if (events.length === 0) {
      lines.push("  (none; pid-map/heartbeat drift is not happening in this window)");
      emit.text(`${lines.join("\n")}\n`);
      return;
    }
    lines.push("By kind:");
    for (const kind of ["pidmap", "heartbeat"] as const) {
      const count = byKind[kind] ?? 0;
      if (count > 0) lines.push(`  ${kind.padEnd(10)} ${count}`);
    }
    lines.push("");
    lines.push("By platform:");
    for (const [platform, count] of Object.entries(byPlatform).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${formatPlatformLabel(platform).padEnd(10)} ${count}`);
    }
    lines.push("");
    lines.push("By reason:");
    for (const reason of ["missing", "stale"] as const) {
      const count = byReason[reason] ?? 0;
      if (count > 0) lines.push(`  ${reason.padEnd(8)} ${count}`);
    }
    lines.push("");
    lines.push("By agent:");
    for (const { agent, count } of byAgentSorted.slice(0, 10)) {
      lines.push(`  ${agent.padEnd(20)} ${count}`);
    }
    if (byAgentSorted.length > 10) {
      lines.push(`  +${byAgentSorted.length - 10} more`);
    }
    lines.push("");
    lines.push("By time bucket:");
    lines.push(`  last 1h   ${buckets.last_1h}`);
    lines.push(`  last 24h  ${buckets.last_24h}`);
    lines.push(`  last 7d   ${buckets.last_7d}`);
    lines.push("");
    lines.push(`Recent (most recent first, capped at ${limit}):`);
    for (const ev of recent) {
      const reasonLabel = ev.prior ? `${ev.reason} prior=${ev.prior}` : ev.reason;
      const pidPart = ev.pid ? ` pid=${ev.pid.padEnd(7)}` : " ".repeat(12);
      lines.push(
        `  ${ev.ts}  ${ev.kind.padEnd(9)} ${formatPlatformLabel(ev.platform).padEnd(6)} ${ev.agent.padEnd(20)}${pidPart} ${reasonLabel}`,
      );
    }
    emit.text(`${lines.join("\n")}\n`);
  }
}

interface HealthReport {
  since: string;
  generated_at: string;
  event_telemetry: {
    source: "v3";
    authoritative: boolean;
    reason?: string;
  };
  active_agents: {
    source: "event-ledger-v3";
    total: number;
    by_platform: Record<string, number>;
    by_kind: Record<string, number>;
    by_schema_version: Record<string, number>;
    stale: number;
  };
  heal_events: {
    total: number;
    by_kind: { pidmap: number; heartbeat: number };
    by_reason: { missing: number; stale: number };
    by_platform: Record<string, number>;
    top_agents: Array<{ agent: string; count: number }>;
  };
  councils: {
    active: number;
    archived_in_window: number;
    advanced_in_window: number;
    closed_in_window: number;
  };
  // Heartbeats removed by stale-sweep in the window (health.heartbeat_swept).
  swept_events: {
    total: number;
    by_reason: Record<string, number>;
  };
  // agent-hook failures in the window, from .harnery/debug/agent-hook.errors.ndjson,
  // grouped by `phase`. A dominant phase is the fastest pointer to a systemic hook
  // bug (e.g. a stop-projection crash that caused ~200 errors/day until it was fixed).
  hook_errors: {
    total: number;
    last_1h: number;
    latest_at: string | null;
    by_phase: Record<string, number>;
    by_error: Record<string, number>;
    top: Array<{ phase: string; count: number; sample: string }>;
    top_errors: Array<{ error: string; count: number; phase: string }>;
    recent_top_errors: Array<{ error: string; count: number; phase: string }>;
  };
  // Canonical event stream growth + drain lag.
  stream: {
    source: "v3";
    authoritative: boolean;
    reason?: string;
    bytes: number;
    lines: number;
    cursor_backlog: number;
  };
  // Heartbeats present in active/ but broken: no name, unparseable, or an
  // absurd (epoch-ish) last_heartbeat. These are the `agent-unknown` peer-table
  // ghosts; a positive count means dead files the sweep isn't catching.
  zombies: {
    count: number;
    samples: string[];
  };
  // V3 event-ledger producer health: open tool spans, pending finalization
  // requests, intake/diagnostics spool depth, span-count pressure.
  event_ledger: EventLedgerHealthV3;
  // Stop-hook remediation cap exhaustions in the window: sessions whose
  // end-of-turn evidence never landed, so the hook stopped bouncing them and
  // let the turn end unenforced. Each one is a session that could not comply —
  // the signal that used to be visible only as a repeating notification sound.
  stop_remediation: {
    total: number;
    latest_at: string | null;
    sessions: string[];
  };
  anomalies: string[];
}

/** Open-span soft watermark per producer state. The producer-state reader
 * hard-caps at 256 spans (a state file beyond it fails to load), so surfacing
 * pressure at half that gives room to act before reads start failing. */
const SPAN_PRESSURE_SOFT_WATERMARK = 128;

export type EventLedgerHealthV3 =
  | { state: "unavailable"; reason: string }
  | {
      state: "live";
      mode: "candidate" | "active";
      open_spans: {
        total: number;
        generations: Array<{
          instance_id: string;
          generation_id: string;
          adapter: string;
          span_count: number;
          /** False = spans are open with NO open turn: the orphan signature
           * (a turn ended without its tool spans being closed). */
          turn_open: boolean;
        }>;
      };
      pending_finalizations: Array<{
        request_id: string;
        trigger: string;
        generation_id: string;
        age_ms: number;
        allowed_open_span_count: number;
      }>;
      intake_spool: {
        total: number;
        groups: Array<{ adapter: string; session_hash: string; count: number }>;
      };
      diagnostics_spool: {
        /** Logical occurrences: loose files plus coalesced summary counts. */
        total: number;
        /** Physical loose diagnostic files. */
        loose_total: number;
        /** Occurrences coalesced into summaries instead of loose files. */
        summarized_total: number;
        /** Physical summary files in `diagnostic-summaries/`. */
        summary_files: number;
        last_24h: number;
        last_1h: number;
        latest_at: string | null;
        by_category: Record<string, { total: number; last_24h: number }>;
        recent_by_category: Record<string, { last_1h: number; latest_at: string | null }>;
        /** Times the summary gate failed open (loose write proceeded). */
        mitigation_fail_open: number;
      };
      span_pressure: Array<{ instance_id: string; generation_id: string; span_count: number }>;
      collection_errors: string[];
    };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read-only health counters for the V3 event ledger's producer surfaces. Never
 * mutates ledger state (no control repair, no spool drain) and never throws:
 * a non-live route returns `{ state: "unavailable" }`, and each sub-surface
 * that fails to read lands in `collection_errors` instead of aborting the rest.
 */
export function collectEventLedgerHealthV3(root: string, nowMs = Date.now()): EventLedgerHealthV3 {
  let control: ReturnType<typeof readEventV3ControlState>;
  try {
    control = readEventV3ControlState(root);
  } catch (error) {
    return { state: "unavailable", reason: `control read failed: ${errorText(error)}` };
  }
  if (control.state !== "candidate" && control.state !== "active") {
    return {
      state: "unavailable",
      reason: `${control.state}: ${control.reason}`,
    };
  }

  const collectionErrors: string[] = [];

  // 1) Open tool spans per live (non-terminal) generation + span-count pressure.
  const generations: Extract<EventLedgerHealthV3, { state: "live" }>["open_spans"]["generations"] =
    [];
  const spanPressure: Extract<EventLedgerHealthV3, { state: "live" }>["span_pressure"] = [];
  try {
    for (const { state } of listHookProducerStateRecordsV3(root)) {
      if (state.spans.length >= SPAN_PRESSURE_SOFT_WATERMARK) {
        spanPressure.push({
          instance_id: state.instance_id,
          generation_id: state.generation_id,
          span_count: state.spans.length,
        });
      }
      if (state.spans.length === 0) continue;
      generations.push({
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        adapter: state.adapter,
        span_count: state.spans.length,
        turn_open: Boolean(state.current_turn_id),
      });
    }
  } catch (error) {
    collectionErrors.push(`producer states unreadable: ${errorText(error)}`);
  }

  // 2) Pending finalization requests with age + trigger.
  const pending: Extract<EventLedgerHealthV3, { state: "live" }>["pending_finalizations"] = [];
  try {
    for (const request of listSessionFinalizationRequestsV3(root)) {
      if (request.status !== "pending") continue;
      const observedMs = Date.parse(request.observed_at);
      pending.push({
        request_id: request.request_id,
        trigger: request.trigger,
        generation_id: request.generation_id,
        age_ms: Number.isFinite(observedMs) ? Math.max(0, nowMs - observedMs) : -1,
        allowed_open_span_count: request.allowed_open_span_ids?.length ?? 0,
      });
    }
  } catch (error) {
    collectionErrors.push(`finalization requests unreadable: ${errorText(error)}`);
  }

  // 3) Intake spool depth (queued hook signals awaiting a lease-holder drain).
  let intakeTotal = 0;
  const intakeGroups: Extract<EventLedgerHealthV3, { state: "live" }>["intake_spool"]["groups"] =
    [];
  try {
    for (const group of listHookIntakeGroupsV3(root)) {
      const count = listHookIntakeRecordsV3(group.directory).length;
      if (count === 0) continue;
      intakeTotal += count;
      intakeGroups.push({ adapter: group.adapter, session_hash: group.session_hash, count });
    }
  } catch (error) {
    collectionErrors.push(`intake spool unreadable: ${errorText(error)}`);
  }

  // 4) Diagnostics spool counts by category. Filenames only (never the
  // contents): `<category>-<orderkey>.json` where the orderkey leads with a
  // zero-padded epoch-ms, which also gives the last-24h split for free.
  const byCategory: Record<string, { total: number; last_24h: number }> = {};
  const recentByCategory: Extract<
    EventLedgerHealthV3,
    { state: "live" }
  >["diagnostics_spool"]["recent_by_category"] = {};
  let diagnosticsTotal = 0;
  let diagnostics24h = 0;
  let diagnostics1h = 0;
  let latestDiagnosticMs = Number.NEGATIVE_INFINITY;
  try {
    const diagnosticsDir = join(resolve(root), EVENT_V3_LEDGER_RELATIVE_ROOT, "diagnostics");
    if (existsSync(diagnosticsDir)) {
      const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;
      const hourAgoMs = nowMs - 60 * 60 * 1000;
      for (const name of readdirSync(diagnosticsDir)) {
        const match = /^(.+)-(\d{15})-\d{20}-\d+-[0-9a-f-]+\.json$/.exec(name);
        const category = match?.[1];
        const epochMs = Number(match?.[2]);
        if (!category) continue;
        const entry = byCategory[category] ?? { total: 0, last_24h: 0 };
        const recent = recentByCategory[category] ?? { last_1h: 0, latest_at: null };
        byCategory[category] = entry;
        recentByCategory[category] = recent;
        entry.total += 1;
        diagnosticsTotal += 1;
        if (Number.isFinite(epochMs)) {
          const recordedAt = new Date(epochMs).toISOString();
          if (!recent.latest_at || epochMs > Date.parse(recent.latest_at)) {
            recent.latest_at = recordedAt;
          }
          latestDiagnosticMs = Math.max(latestDiagnosticMs, epochMs);
          if (epochMs >= dayAgoMs) {
            entry.last_24h += 1;
            diagnostics24h += 1;
          }
          if (epochMs >= hourAgoMs) {
            recent.last_1h += 1;
            diagnostics1h += 1;
          }
        }
      }
    }
  } catch (error) {
    collectionErrors.push(`diagnostics spool unreadable: ${errorText(error)}`);
  }

  // 4b) Coalesced diagnostic summaries: occurrences the producer bounded into
  // `diagnostic-summaries/` instead of loose files. Counted into the logical
  // totals so mitigation can never make an active fault look healthy; the
  // physical loose file count stays visible separately.
  let summarizedTotal = 0;
  let summaryFiles = 0;
  let mitigationFailOpen = 0;
  try {
    const listing = listDiagnosticSummariesV3(root);
    summaryFiles = listing.file_count;
    mitigationFailOpen = listing.mitigation_health?.fail_open_count ?? 0;
    if (listing.unreadable_count > 0) {
      collectionErrors.push(`${listing.unreadable_count} diagnostic summary file(s) unreadable`);
    }
    const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;
    const hourAgoMs = nowMs - 60 * 60 * 1000;
    for (const summary of listing.summaries) {
      summarizedTotal += summary.summarized_count;
      const entry = byCategory[summary.category] ?? { total: 0, last_24h: 0 };
      const recent = recentByCategory[summary.category] ?? { last_1h: 0, latest_at: null };
      byCategory[summary.category] = entry;
      recentByCategory[summary.category] = recent;
      entry.total += summary.summarized_count;
      const day = countSummarizedSinceV3([summary], dayAgoMs, undefined, nowMs);
      const hour = countSummarizedSinceV3([summary], hourAgoMs, undefined, nowMs);
      entry.last_24h += day;
      diagnostics24h += day;
      recent.last_1h += hour;
      diagnostics1h += hour;
      const lastMs = summary.last_summarized_at ? Date.parse(summary.last_summarized_at) : NaN;
      if (Number.isFinite(lastMs)) {
        latestDiagnosticMs = Math.max(latestDiagnosticMs, lastMs);
        if (!recent.latest_at || lastMs > Date.parse(recent.latest_at)) {
          recent.latest_at = new Date(lastMs).toISOString();
        }
      }
    }
  } catch (error) {
    collectionErrors.push(`diagnostic summaries unreadable: ${errorText(error)}`);
  }

  return {
    state: "live",
    mode: control.state,
    open_spans: {
      total: generations.reduce((sum, generation) => sum + generation.span_count, 0),
      generations,
    },
    pending_finalizations: pending,
    intake_spool: { total: intakeTotal, groups: intakeGroups },
    diagnostics_spool: {
      total: diagnosticsTotal + summarizedTotal,
      loose_total: diagnosticsTotal,
      summarized_total: summarizedTotal,
      summary_files: summaryFiles,
      last_24h: diagnostics24h,
      last_1h: diagnostics1h,
      latest_at: Number.isFinite(latestDiagnosticMs)
        ? new Date(latestDiagnosticMs).toISOString()
        : null,
      by_category: byCategory,
      recent_by_category: recentByCategory,
      mitigation_fail_open: mitigationFailOpen,
    },
    span_pressure: spanPressure,
    collection_errors: collectionErrors,
  };
}

/**
 * Tally stop-hook remediation-cap exhaustions in the window from
 * `.harnery/debug/agent-hook.ndjson` (rows with
 * `skipped: "stop-remediation-cap-exhausted"`). Each one is a session whose
 * end-of-turn evidence never landed, so the Stop hook gave up bouncing it and
 * let the turn end unenforced — a compliance gap an operator should see
 * without grepping the debug ledger.
 */
export function readStopRemediationExhaustions(
  root: string,
  cutoffMs: number,
): { total: number; latestAt: string | null; sessions: string[] } {
  const p = resolve(root, ".harnery", "debug", "agent-hook.ndjson");
  if (!existsSync(p)) return { total: 0, latestAt: null, sessions: [] };
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return { total: 0, latestAt: null, sessions: [] };
  }
  let total = 0;
  let latestMs = Number.NEGATIVE_INFINITY;
  const sessions = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.includes("stop-remediation-cap-exhausted")) continue;
    try {
      const e = JSON.parse(line) as { ts?: string; skipped?: string; session_id?: string };
      if (e.skipped !== "stop-remediation-cap-exhausted") continue;
      const tsMs = e.ts ? Date.parse(e.ts) : Number.NaN;
      if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
      total++;
      latestMs = Math.max(latestMs, tsMs);
      if (e.session_id && sessions.size < 5) sessions.add(e.session_id);
    } catch {
      /* skip malformed */
    }
  }
  return {
    total,
    latestAt: Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null,
    sessions: [...sessions],
  };
}

/** Tally agent-hook failures (.harnery/debug/agent-hook.errors.ndjson) in the
 * window by exact error and phase, while separating current-hour failures from
 * historical rows. Each line is {ts, error, phase, ...}. */
export function readHookErrors(
  root: string,
  cutoffMs: number,
  nowMs = Date.now(),
): {
  total: number;
  last1h: number;
  latestAt: string | null;
  byPhase: Record<string, number>;
  byError: Record<string, number>;
  top: Array<{ phase: string; count: number; sample: string }>;
  topErrors: Array<{ error: string; count: number; phase: string }>;
  recentTopErrors: Array<{ error: string; count: number; phase: string }>;
} {
  const p = resolve(root, ".harnery", "debug", "agent-hook.errors.ndjson");
  const byPhase: Record<string, number> = {};
  const byError: Record<string, number> = {};
  const sampleByPhase: Record<string, string> = {};
  const errorPhaseCounts = new Map<string, { error: string; phase: string; count: number }>();
  const recentErrorPhaseCounts = new Map<string, { error: string; phase: string; count: number }>();
  let total = 0;
  let last1h = 0;
  let latestMs = Number.NEGATIVE_INFINITY;
  if (!existsSync(p)) {
    return {
      total: 0,
      last1h: 0,
      latestAt: null,
      byPhase,
      byError,
      top: [],
      topErrors: [],
      recentTopErrors: [],
    };
  }
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return {
      total: 0,
      last1h: 0,
      latestAt: null,
      byPhase,
      byError,
      top: [],
      topErrors: [],
      recentTopErrors: [],
    };
  }
  const hourAgoMs = nowMs - 60 * 60 * 1000;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { ts?: string; phase?: string; error?: string };
      const tsMs = e.ts ? Date.parse(e.ts) : Number.NaN;
      if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
      const phase = e.phase ?? "(unknown)";
      const error = e.error ?? "(unknown)";
      byPhase[phase] = (byPhase[phase] ?? 0) + 1;
      byError[error] = (byError[error] ?? 0) + 1;
      if (!sampleByPhase[phase] && e.error) sampleByPhase[phase] = e.error;
      const errorPhaseKey = `${error}\0${phase}`;
      const errorPhase = errorPhaseCounts.get(errorPhaseKey) ?? { error, phase, count: 0 };
      errorPhase.count += 1;
      errorPhaseCounts.set(errorPhaseKey, errorPhase);
      latestMs = Math.max(latestMs, tsMs);
      if (tsMs >= hourAgoMs) {
        last1h += 1;
        const recent = recentErrorPhaseCounts.get(errorPhaseKey) ?? { error, phase, count: 0 };
        recent.count += 1;
        recentErrorPhaseCounts.set(errorPhaseKey, recent);
      }
      total++;
    } catch {
      /* skip malformed */
    }
  }
  const top = Object.entries(byPhase)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phase, count]) => ({ phase, count, sample: sampleByPhase[phase] ?? "" }));
  const topErrors = [...errorPhaseCounts.values()]
    .sort((left, right) => right.count - left.count || left.error.localeCompare(right.error))
    .slice(0, 5);
  const recentTopErrors = [...recentErrorPhaseCounts.values()]
    .sort((left, right) => right.count - left.count || left.error.localeCompare(right.error))
    .slice(0, 5);
  return {
    total,
    last1h,
    latestAt: Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null,
    byPhase,
    byError,
    top,
    topErrors,
    recentTopErrors,
  };
}

/** Canonical event stream size + drain lag (events appended after the cursor). */
function readStreamStats(root: string): HealthReport["stream"] {
  const read = readAgentDiagnosticEventsInWindow(root, 0);
  return {
    source: "v3",
    authoritative: read.authoritative,
    ...(read.reason ? { reason: read.reason } : {}),
    bytes: read.bytes,
    lines: read.events.length,
    cursor_backlog: 0,
  };
}

/** One rendered line in a trace. */
export interface TraceEntry {
  ts: string;
  event_type: string;
  detail: string;
}

export function traceInstanceIdsForEventSource(
  nativeInstanceIds: readonly string[],
  source: "v3",
): string[] {
  void source;
  return nativeInstanceIds.map((instanceId) => liveInstanceIdV3(instanceId));
}

/** Map a canonical event to a concise trace line, or null to drop it. */
export function traceLine(ev: CanonicalEvent, allTools: boolean): TraceEntry | null {
  const d = (ev.payload ?? {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof d[k] === "string" ? (d[k] as string) : "");
  const object = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const clip = (v: string, n = 70): string => (v.length <= n ? v : `${v.slice(0, n - 1)}…`);
  const recovery =
    typeof d.recovery === "object" && d.recovery !== null
      ? (d.recovery as { reason?: unknown })
      : null;
  const recoveryReason = typeof recovery?.reason === "string" ? recovery.reason : "";
  const recoveryDetail = recoveryReason ? ` · RECOVERY reason=${recoveryReason}` : "";
  let detail = "";
  switch (ev.event_type) {
    case "session.started":
      detail = "generation started";
      break;
    case "session.resumed":
      detail = "generation resumed";
      break;
    case "session.ended":
      detail = `outcome=${s("outcome") || "unknown"}${s("reason") ? ` · reason=${s("reason")}` : ""}`;
      break;
    case "session.termination_observed":
      detail = `provisional ${s("observation") || "termination"}${s("reason") ? ` · reason=${s("reason")}` : ""}`;
      break;
    case "agent.delegated":
      detail = `delegated child=${s("child_generation_id") || "unknown"}`;
      break;
    case "agent.started":
      detail = `child started=${s("child_generation_id") || "unknown"}`;
      break;
    case "agent.completed":
      detail = `child completed=${s("child_generation_id") || "unknown"} · outcome=${s("outcome") || "unknown"}`;
      break;
    case "turn.started":
      detail = `intent=${s("intent_kind") || "unknown"}`;
      break;
    case "turn.completed":
      detail = `outcome=${s("outcome") || "unknown"}`;
      break;
    case "tool.requested": {
      const tool = object(d.tool);
      detail = `${typeof tool.name === "string" ? tool.name : "tool"} requested (content omitted)${recoveryDetail}`;
      break;
    }
    case "tool.completed": {
      const tool = object(d.tool);
      detail = `${typeof tool.name === "string" ? tool.name : "tool"} · outcome=${s("outcome") || "unknown"}${recoveryDetail}`;
      break;
    }
    case "command.started":
      if (!allTools) return null;
      detail = "command started (content omitted)";
      break;
    case "command.completed":
      if (!allTools && !recoveryReason) return null;
      detail = `outcome=${s("outcome") || "unknown"}${recoveryDetail}`;
      break;
    case "coord.task_changed":
    case "coord.lifecycle_changed":
    case "coord.presence_changed":
      detail = `${s("prior_state") || "unknown"} → ${s("new_state") || "unknown"}${s("reason") ? ` · ${clip(s("reason"), 55)}` : ""}`;
      break;
    case "coord.status_observed":
      detail = s("status") || "status observed";
      break;
    case "coord.claim_changed": {
      const target = object(d.target);
      detail = `${s("operation") || "changed"}${typeof target.display === "string" ? ` · ${clip(target.display)}` : ""}`;
      break;
    }
    case "coord.message_observed":
      detail = `${s("direction") || "observed"} · peer=${s("peer_instance_id") || "unknown"}`;
      break;
    case "coord.identity_attested":
      detail = `${s("identity_id") || "identity"} · method=${s("method") || "unknown"}`;
      break;
    case "wait.started":
      detail = s("kind") || "wait started";
      break;
    case "wait.ended":
      detail = `outcome=${s("outcome") || "unknown"}`;
      break;
    case "artifact.observed": {
      const artifact = object(d.artifact);
      detail = `operation=${s("operation") || "observed"}${typeof artifact.kind === "string" ? ` · kind=${artifact.kind}` : ""}`;
      break;
    }
    case "progress.observed":
      detail = s("kind") || "progress";
      break;
    case "health.observed":
      detail = `${s("subsystem") || "unknown"} · ${s("severity") || "unknown"} · ${s("condition") || "unknown"}`;
      break;
    case "council.state_changed":
      detail = `${s("council_id") || "council"} · ${s("prior_state") || "unknown"} → ${s("new_state") || "unknown"}`;
      break;
    case "decision.state_changed":
      detail = `${s("decision_id") || "decision"} · ${s("prior_state") || "unknown"} → ${s("new_state") || "unknown"}`;
      break;
    case "lifecycle.recovered":
      detail = `recovered=${s("recovery_kind") || "unknown"}`;
      break;
    case "lifecycle.sweep_observed":
      detail = `${s("observation") || "sweep"}${typeof d.age_ms === "number" ? ` · age=${Math.round(d.age_ms / 1000)}s` : ""}`;
      break;
    default:
      return null;
  }
  return { ts: ev.ts, event_type: ev.event_type, detail };
}

export function pendingFinalizationTraceEntries(
  requests: readonly SessionFinalizationRequestV3[],
  instanceId: string,
): TraceEntry[] {
  return requests
    .filter((request) => request.status === "pending" && request.instance_id === instanceId)
    .map((request) => ({
      ts: request.observed_at,
      event_type: "session.finalization_pending",
      detail: `trigger=${request.trigger} · request=${request.request_id}${request.allowed_open_span_ids?.length ? ` · allowed_open_spans=${request.allowed_open_span_ids.length}` : ""}`,
    }));
}

function runTrace(
  name: string,
  opts: { since?: string; limit: string; allTools?: boolean; json?: boolean },
): void {
  if (opts.json) emit.config({ format: "json" });
  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }

  // Resolve the arg → instance_id. Accept agent-Foo / Foo (name) or a raw id.
  const nameById = buildNameById(root);
  const wanted = name.startsWith("agent-") ? name.slice("agent-".length) : name;
  const wantedLower = wanted.toLowerCase();
  let targetId: string | null = null;
  if (nameById.has(wanted)) {
    targetId = wanted; // arg was a raw instance_id present in name-history
  } else {
    // name match: may resolve to several instances over time; pick the one
    // with the most-recent event below (collect all candidates first).
    const candidates = [...nameById.entries()].filter(([, n]) => n.toLowerCase() === wantedLower);
    if (candidates.length === 1) targetId = candidates[0]![0];
    else if (candidates.length > 1)
      targetId = candidates.map(([id]) => id).join("\x00"); // sentinel; resolved below
    else if (/^(?:inst_)?[0-9a-z._-]{8,}$/i.test(wanted)) targetId = wanted;
  }
  if (!targetId) {
    emit.error({
      code: "not_found",
      message: `no agent named '${name}' in .name-history (and not an id)`,
    });
    process.exit(1);
  }

  const sinceMs = opts.since ? Date.now() - (parseWindowSecs(opts.since) ?? 0) * 1000 : 0;
  const limit = Math.max(1, Number.parseInt(opts.limit, 10) || 200);
  const diagnosticRead = readAgentDiagnosticEventsInWindow(root, sinceMs);
  const nativeCandidateIds = targetId.includes("\x00") ? targetId.split("\x00") : [targetId];
  const candidateIds = traceInstanceIdsForEventSource(nativeCandidateIds, diagnosticRead.source);
  const byId = new Map<string, CanonicalEvent[]>();
  for (const ev of diagnosticRead.events) {
    if (!ev.instance_id || !candidateIds.includes(ev.instance_id)) continue;
    const arr = byId.get(ev.instance_id) ?? [];
    arr.push(ev);
    byId.set(ev.instance_id, arr);
  }
  // If the name mapped to multiple instances, trace the one with the latest event.
  let resolvedId = candidateIds[0]!;
  if (candidateIds.length > 1) {
    let latest = -1;
    for (const id of candidateIds) {
      const evs = byId.get(id);
      const last = evs?.length ? Date.parse(evs[evs.length - 1]!.ts) : -1;
      if (last > latest) {
        latest = last;
        resolvedId = id;
      }
    }
  }

  const events = byId.get(resolvedId) ?? [];
  let state = foldSessionState(events, { instance_id: resolvedId });
  let sessionState: "live" | "ended" = events.some((event) => event.event_type === "session.ended")
    ? "ended"
    : "live";
  if (diagnosticRead.source === "v3" && diagnosticRead.authoritative) {
    try {
      const view = projectCoordinationViewV3(readLedgerV3(root));
      const liveGeneration = view.instances[resolvedId];
      const terminalGeneration = Object.values(view.terminal_generations).find(
        (candidate) => candidate.instance_id === resolvedId,
      );
      const generation = liveGeneration ?? terminalGeneration;
      if (generation) {
        sessionState = terminalGeneration && !liveGeneration ? "ended" : "live";
        const lifecycleState = generation.lifecycle_state;
        state = {
          activity: generation.activity === "terminal" ? "idle" : generation.activity,
          activity_updated_at: generation.last_observed_at,
          activity_source: "event-v3-coordination-view",
          task_state:
            lifecycleState === "active" || lifecycleState === "blocked" || lifecycleState === "done"
              ? lifecycleState
              : "active",
          task_state_updated_at: generation.lifecycle_state_updated_at,
        };
      }
    } catch {
      diagnosticRead.authoritative = false;
      diagnosticRead.reason = "V3 coordination projection is unavailable";
    }
  }
  let pendingFinalizations: SessionFinalizationRequestV3[] = [];
  if (diagnosticRead.source === "v3") {
    try {
      pendingFinalizations = listSessionFinalizationRequestsV3(root).filter(
        (request) => request.status === "pending" && request.instance_id === resolvedId,
      );
    } catch {
      diagnosticRead.authoritative = false;
      diagnosticRead.reason = "V3 finalization requests are unreadable";
    }
  }
  const lines = [
    ...events
      .map((ev) => traceLine(ev, !!opts.allTools))
      .filter((l): l is TraceEntry => l !== null),
    ...pendingFinalizationTraceEntries(pendingFinalizations, resolvedId),
  ]
    // Sort by timestamp, not file order: codex replays events (original ts,
    // appended later), so append-order ≠ chronological order.
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const shown = lines.slice(-limit);
  const nativeResolvedId =
    diagnosticRead.source === "v3"
      ? nativeCandidateIds[candidateIds.indexOf(resolvedId)]
      : resolvedId;
  const displayName =
    nameById.get(resolvedId) ??
    (nativeResolvedId ? nameById.get(nativeResolvedId) : undefined) ??
    resolvedId.slice(0, 8);

  const result = {
    event_source: {
      contract: diagnosticRead.source,
      authoritative: diagnosticRead.authoritative,
      reason: diagnosticRead.reason ?? null,
    },
    name: displayName,
    instance_id: resolvedId,
    other_instances: candidateIds.filter((id) => id !== resolvedId),
    pending_finalizations: pendingFinalizations,
    total_events: events.length,
    session_state: sessionState,
    activity: state.activity,
    activity_updated_at: state.activity_updated_at ?? null,
    activity_source: state.activity_source ?? null,
    task_state: state.task_state,
    task_state_scope: sessionState === "ended" ? "historical" : "current",
    task_state_updated_at: state.task_state_updated_at ?? null,
    task_state_reason: state.task_state_reason ?? null,
    shown: shown.length,
    entries: shown,
  };

  if (opts.json) {
    emit.data(result);
    return;
  }
  emit.data(result);
  const header = `Trace: agent-${displayName}  (${resolvedId.slice(0, 8)}…)  ${events.length} events${result.other_instances.length ? ` · ${result.other_instances.length} older instance(s) of this name` : ""}`;
  process.stdout.write(`${header}\n`); // lint-ok-emission: human trace view
  process.stdout.write(
    `  activity=${state.activity} · session=${sessionState} · lifecycle=${sessionState === "ended" ? `historical(${state.task_state})` : state.task_state}${sessionState !== "ended" && state.task_state === "blocked" && state.task_state_reason ? `: ${state.task_state_reason}` : ""}\n`,
  ); // lint-ok-emission: human trace view
  if (!diagnosticRead.authoritative) {
    process.stdout.write(`  unavailable: ${diagnosticRead.reason ?? "event source incomplete"}\n`); // lint-ok-emission: explicit no-fallback diagnostic
  }
  if (shown.length === 0) {
    process.stdout.write("  (no events)\n"); // lint-ok-emission: human trace view
    return;
  }
  for (const l of shown) {
    const t = formatLocalTime(new Date(l.ts)).replace(/^[A-Za-z]{3}, /, ""); // drop weekday for density
    process.stdout.write(`  ${t}  ${l.event_type.padEnd(22)} ${l.detail}\n`); // lint-ok-emission: human trace view
  }
}

export interface ActiveAgentHealthSummary {
  source: "event-ledger-v3";
  total: number;
  by_platform: Record<string, number>;
  by_kind: Record<string, number>;
  by_schema_version: Record<string, number>;
  stale: number;
}

type ActiveHealthHeartbeat = {
  instance_id: string;
  platform?: string;
  kind?: string;
  schema_version?: number;
  last_heartbeat?: string;
};

/**
 * V3 generations, not disposable heartbeat caches, are the active-agent authority.
 */
export function collectActiveAgentHealth(
  root: string,
  nowMs = Date.now(),
  readRows: (root: string) => ActiveHealthHeartbeat[] = readLiveCoordinationRows,
  freshnessSeconds = freshnessCutoffSecs(),
): ActiveAgentHealthSummary {
  const source: ActiveAgentHealthSummary["source"] = "event-ledger-v3";
  let heartbeats: ActiveHealthHeartbeat[] = [];
  try {
    const control = readEventV3ControlState(root);
    if (control.state === "candidate" || control.state === "active") {
      heartbeats = readRows(root);
    }
  } catch {
    // The event-ledger section reports the authority read failure. Do not
    // substitute stale cache rows for a live V3 route.
  }

  const byPlatform: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const bySchema: Record<string, number> = {};
  let stale = 0;
  for (const heartbeat of heartbeats) {
    const platform = formatPlatformLabel(heartbeat.platform);
    byPlatform[platform] = (byPlatform[platform] ?? 0) + 1;
    const kind = heartbeat.kind ?? "unknown";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    // These rows exist only after an authority-safe V3 projection. The
    // disposable heartbeat file has its own cache-format version, which must
    // not be reported as the ledger schema version.
    bySchema.v3 = (bySchema.v3 ?? 0) + 1;
    const lastObservedMs = heartbeat.last_heartbeat
      ? Date.parse(heartbeat.last_heartbeat)
      : Number.NaN;
    const ageMs = Number.isFinite(lastObservedMs)
      ? nowMs - lastObservedMs
      : Number.POSITIVE_INFINITY;
    if (ageMs > freshnessSeconds * 1000) stale += 1;
  }
  return {
    source,
    total: heartbeats.length,
    by_platform: byPlatform,
    by_kind: byKind,
    by_schema_version: bySchema,
    stale,
  };
}

function runHealth(opts: { since: string; json?: boolean }): void {
  if (opts.json) emit.config({ format: "json" });

  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }

  const sinceSecs = parseWindowSecs(opts.since);
  if (sinceSecs === null) {
    emit.error({
      code: "bad_since",
      message: `invalid --since value '${opts.since}': expected Nh or Nd (e.g. 24h, 7d)`,
    });
    process.exit(1);
  }

  const nowMs = Date.now();
  const cutoffMs = nowMs - sinceSecs * 1000;
  const activeDir = resolve(root, ".harnery/active");
  const councilsDir = resolve(root, ".harnery/councils");

  // Coordination telemetry reads from the canonical V3 ledger.
  // Heals come from health.observed; council activity from council.state_changed.
  const heal: HealEvent[] = [];
  let councilAdvanced = 0;
  let councilClosed = 0;
  let councilArchived = 0;
  let sweptTotal = 0;
  const sweptByReason: Record<string, number> = {};

  const nameById = buildNameById(root);
  const diagnosticEvents = readAgentDiagnosticEventsInWindow(root, cutoffMs);
  for (const ev of diagnosticEvents.events) {
    const healEv = canonicalToHealEvent(ev, nameById);
    if (healEv) {
      heal.push(healEv);
      continue;
    }
    if (ev.event_type === "council.state_changed") {
      const state = String(ev.payload?.new_state ?? "");
      if (state === "round_open") councilAdvanced++;
      if (state === "closed") councilClosed++;
      if (state === "archived") councilArchived++;
      continue;
    }
    switch (ev.event_type) {
      case "lifecycle.sweep_observed": {
        sweptTotal++;
        const reason = String(ev.payload?.observation ?? "unknown");
        sweptByReason[reason] = (sweptByReason[reason] ?? 0) + 1;
        break;
      }
    }
  }

  const hookErrors = readHookErrors(root, cutoffMs, nowMs);
  const stopRemediation = readStopRemediationExhaustions(root, cutoffMs);
  const stream = readStreamStats(root);
  const eventLedger = collectEventLedgerHealthV3(root);

  // Canonical health.* events carry the full instance_id, already resolved to
  // `agent-<name>` (or `agent-<hex8>` fallback) by canonicalToHealEvent via
  // buildNameById; no hex8→name dedup pass needed anymore.
  const healByReason: Record<string, number> = { missing: 0, stale: 0 };
  const healByKind: Record<string, number> = { pidmap: 0, heartbeat: 0 };
  const healByPlatform: Record<string, number> = {};
  const healByAgent = new Map<string, number>();
  for (const ev of heal) {
    healByReason[ev.reason] = (healByReason[ev.reason] ?? 0) + 1;
    healByKind[ev.kind] = (healByKind[ev.kind] ?? 0) + 1;
    healByPlatform[ev.platform] = (healByPlatform[ev.platform] ?? 0) + 1;
    healByAgent.set(ev.agent, (healByAgent.get(ev.agent) ?? 0) + 1);
  }
  const healTopAgents = Array.from(healByAgent.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([agent, count]) => ({ agent, count }));

  const activeAgents = collectActiveAgentHealth(root, nowMs);
  // Zombies: files in active/ that are broken: unparseable, nameless, or an
  // absurd (epoch-ish) last_heartbeat. These show as `agent-unknown` ghosts and
  // mean dead files the sweep isn't reaping.
  let zombieCount = 0;
  const zombieSamples: string[] = [];
  const ABSURD_AGE_MS = 24 * 60 * 60 * 1000; // > 1 day = clearly not a live, self-healing agent
  if (existsSync(activeDir)) {
    for (const file of readdirSync(activeDir)) {
      if (!file.endsWith(".json")) continue;
      const idFromFile = file.replace(/\.json$/, "");
      let hb: Heartbeat | null = null;
      try {
        hb = JSON.parse(readFileSync(resolve(activeDir, file), "utf8")) as Heartbeat;
      } catch {
        hb = null;
      }
      if (!hb || typeof hb.instance_id !== "string") {
        zombieCount++;
        if (zombieSamples.length < 5)
          zombieSamples.push(`${idFromFile.slice(0, 12)} (unparseable/no-id)`);
        continue;
      }
      const lastHbMs = hb.last_heartbeat ? Date.parse(hb.last_heartbeat) : Number.NaN;
      const ageMs = Number.isFinite(lastHbMs) ? nowMs - lastHbMs : Number.POSITIVE_INFINITY;
      // Zombie heuristics on a parseable heartbeat: no name, or an age so large
      // it can only be a broken/epoch timestamp (a real agent would have healed).
      if (!hb.name || hb.name === "unknown" || ageMs > ABSURD_AGE_MS) {
        zombieCount++;
        if (zombieSamples.length < 5) {
          const why = !hb.name || hb.name === "unknown" ? "no-name" : "epoch-age";
          zombieSamples.push(`${idFromFile.slice(0, 12)} (${why})`);
        }
      }
    }
  }

  // Active councils on disk (excluding archive/).
  let activeCouncils = 0;
  if (existsSync(councilsDir)) {
    for (const entry of readdirSync(councilsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "archive") continue;
      const manifestPath = resolve(councilsDir, entry.name, "manifest.json");
      if (existsSync(manifestPath)) activeCouncils++;
    }
  }

  // Anomaly detection.
  const anomalies: string[] = [];
  for (const { agent, count } of healTopAgents) {
    if (count >= 5) {
      anomalies.push(
        `${agent} self-healed ${count}x in ${opts.since}; possible idle-prune loop or PID instability`,
      );
    }
  }
  if (activeAgents.stale > 0) {
    const noun = activeAgents.source === "event-ledger-v3" ? "V3 generation" : "heartbeat";
    const action =
      activeAgents.source === "event-ledger-v3"
        ? "lifecycle reconciliation may be delayed"
        : "heal mechanism may not be firing";
    anomalies.push(
      `${activeAgents.stale} active ${noun}(s) without activity for ${Math.floor(freshnessCutoffSecs() / 60)}min; ${action}`,
    );
  }
  const expectedSchema = "v3";
  const unexpectedSchemas = Object.keys(activeAgents.by_schema_version).filter(
    (schema) => schema !== expectedSchema,
  );
  if (unexpectedSchemas.length > 0) {
    anomalies.push(
      `Unexpected active-agent schema versions in use: ${unexpectedSchemas.join(", ")} (expected ${expectedSchema})`,
    );
  }
  // Only recent hook failures are active anomalies. Historical rows remain in
  // the report with exact error signatures and their latest timestamp.
  if (hookErrors.last1h > 0) {
    const top = hookErrors.recentTopErrors[0];
    const detail = top ? `: top '${top.error.slice(0, 80)}' x${top.count} (${top.phase})` : "";
    anomalies.push(`agent-hook errored ${hookErrors.last1h}x in the last hour${detail}`);
  }
  if (stream.cursor_backlog > 500) {
    anomalies.push(
      `projection cursor is ${stream.cursor_backlog} events behind; drain lagging (stop projection may be failing)`,
    );
  }
  // Raw V3 stream size is not an anomaly; catalog rotation bounds readers.
  if ((sweptByReason.unparseable ?? 0) > 0) {
    anomalies.push(
      `${sweptByReason.unparseable} heartbeat(s) swept as unparseable in ${opts.since}; possible corruption or a non-atomic writer`,
    );
  }
  if (zombieCount > 0) {
    anomalies.push(
      `${zombieCount} zombie heartbeat(s) in active/ (${zombieSamples.join(", ")}); broken files the sweep isn't reaping`,
    );
  }
  if (stopRemediation.total > 0) {
    const who =
      stopRemediation.sessions.length > 0
        ? ` (sessions: ${stopRemediation.sessions.map((s) => s.slice(0, 8)).join(", ")})`
        : "";
    anomalies.push(
      `stop-hook remediation cap exhausted ${stopRemediation.total}x in ${opts.since}${who}; these sessions ended turns without the end-of-turn ritual — check why their evidence never lands`,
    );
  }
  if (eventLedger.state === "live") {
    // Open spans whose generation has no open turn: the turn ended without its
    // tool spans closing, so an explicit end can only queue, never finalize.
    const orphanGenerations = eventLedger.open_spans.generations.filter(
      (generation) => !generation.turn_open,
    );
    if (orphanGenerations.length > 0) {
      const orphanSpans = orphanGenerations.reduce(
        (sum, generation) => sum + generation.span_count,
        0,
      );
      anomalies.push(
        `${orphanSpans} open tool span(s) across ${orphanGenerations.length} generation(s) with no open turn; orphaned spans block clean session end`,
      );
    }
    for (const pressure of eventLedger.span_pressure) {
      anomalies.push(
        `${pressure.instance_id} (${pressure.generation_id}) holds ${pressure.span_count} open spans (soft watermark ${SPAN_PRESSURE_SOFT_WATERMARK}; the reader's 256-span cap makes the state unreadable)`,
      );
    }
    for (const collectionError of eventLedger.collection_errors) {
      anomalies.push(`event-ledger health: ${collectionError}`);
    }
  }

  const report: HealthReport = {
    since: opts.since,
    generated_at: new Date().toISOString(),
    event_telemetry: {
      source: diagnosticEvents.source,
      authoritative: diagnosticEvents.authoritative,
      ...(diagnosticEvents.reason ? { reason: diagnosticEvents.reason } : {}),
    },
    active_agents: {
      source: activeAgents.source,
      total: activeAgents.total,
      by_platform: activeAgents.by_platform,
      by_kind: activeAgents.by_kind,
      by_schema_version: activeAgents.by_schema_version,
      stale: activeAgents.stale,
    },
    heal_events: {
      total: heal.length,
      by_kind: { pidmap: healByKind.pidmap, heartbeat: healByKind.heartbeat },
      by_reason: { missing: healByReason.missing, stale: healByReason.stale },
      by_platform: healByPlatform,
      top_agents: healTopAgents,
    },
    councils: {
      active: activeCouncils,
      archived_in_window: councilArchived,
      advanced_in_window: councilAdvanced,
      closed_in_window: councilClosed,
    },
    swept_events: { total: sweptTotal, by_reason: sweptByReason },
    hook_errors: {
      total: hookErrors.total,
      last_1h: hookErrors.last1h,
      latest_at: hookErrors.latestAt,
      by_phase: hookErrors.byPhase,
      by_error: hookErrors.byError,
      top: hookErrors.top,
      top_errors: hookErrors.topErrors,
      recent_top_errors: hookErrors.recentTopErrors,
    },
    stream,
    zombies: { count: zombieCount, samples: zombieSamples },
    event_ledger: eventLedger,
    stop_remediation: {
      total: stopRemediation.total,
      latest_at: stopRemediation.latestAt,
      sessions: stopRemediation.sessions,
    },
    anomalies,
  };

  if (opts.json) {
    emit.data(report);
    return;
  }
  emit.data(report);
  renderHealthBox(report);
}

function renderHealthBox(report: HealthReport): void {
  const platforms = Object.entries(report.active_agents.by_platform)
    .map(([p, n]) => `${p} ${n}`)
    .join(" / ");
  const schemas = Object.entries(report.active_agents.by_schema_version)
    .map(([v, n]) => `${v} ${n}`)
    .join(" / ");

  const healSubparts: string[] = [];
  if (report.heal_events.by_kind.pidmap > 0) {
    healSubparts.push(`pidmap ${report.heal_events.by_kind.pidmap}`);
  }
  if (report.heal_events.by_kind.heartbeat > 0) {
    healSubparts.push(`heartbeat ${report.heal_events.by_kind.heartbeat}`);
  }
  if (report.heal_events.by_reason.stale > 0) {
    healSubparts.push(`stale ${report.heal_events.by_reason.stale}`);
  }

  const topHealer = report.heal_events.top_agents[0];
  const topHealerStr = topHealer ? `${topHealer.agent} x${topHealer.count}` : "(none)";

  const councilParts: string[] = [`${report.councils.active} active`];
  if (report.councils.advanced_in_window > 0)
    councilParts.push(`${report.councils.advanced_in_window} advanced`);
  if (report.councils.closed_in_window > 0)
    councilParts.push(`${report.councils.closed_in_window} closed`);
  if (report.councils.archived_in_window > 0)
    councilParts.push(`${report.councils.archived_in_window} archived`);

  const activeSource =
    report.active_agents.source === "event-ledger-v3" ? "ledger" : "heartbeat cache";
  const activeStr = `${report.active_agents.total}${platforms ? ` (${platforms})` : ""}${schemas ? ` · ${schemas}` : ""}${report.active_agents.stale > 0 ? ` · ${report.active_agents.stale} stale` : ""} · ${activeSource}`;

  const sweptReasonStr = Object.entries(report.swept_events.by_reason)
    .map(([r, n]) => `${r} ${n}`)
    .join(", ");
  const hookErrStr =
    report.hook_errors.total === 0
      ? "0"
      : `${report.hook_errors.total} in window · ${report.hook_errors.last_1h} in 1h`;
  const streamStr = `${(report.stream.bytes / 1048576).toFixed(1)}MB · ${report.stream.lines} lines · ${report.stream.cursor_backlog} behind`;

  const ledger = report.event_ledger;
  let ledgerStr: string;
  if (ledger.state !== "live") {
    ledgerStr = `unavailable (${ledger.reason})`;
  } else {
    const orphanGenerations = ledger.open_spans.generations.filter(
      (generation) => !generation.turn_open,
    ).length;
    const pendingAges = ledger.pending_finalizations
      .map((request) =>
        request.age_ms < 0 ? "age?" : formatAge(Math.floor(request.age_ms / 1000)),
      )
      .join(", ");
    ledgerStr = [
      `open spans ${ledger.open_spans.total}${orphanGenerations > 0 ? ` (${orphanGenerations} gen turn-closed)` : ""}`,
      `pending ends ${ledger.pending_finalizations.length}${pendingAges ? ` (${pendingAges})` : ""}`,
      `intake ${ledger.intake_spool.total}`,
      `diagnostics ${ledger.diagnostics_spool.total}${ledger.diagnostics_spool.summarized_total > 0 ? ` (${ledger.diagnostics_spool.loose_total} loose + ${ledger.diagnostics_spool.summarized_total} summarized)` : ""} (${ledger.diagnostics_spool.last_1h} in 1h / ${ledger.diagnostics_spool.last_24h} in 24h)`,
    ].join(" · ");
  }

  const rows: Array<[string, string]> = [
    ["window", `last ${report.since}`],
    [
      "event source",
      `${report.event_telemetry.source.toUpperCase()} · ${report.event_telemetry.authoritative ? "validated" : `unavailable (${report.event_telemetry.reason ?? "incomplete"})`}`,
    ],
    ["active", activeStr],
    [
      "heals",
      `${report.heal_events.total}${healSubparts.length ? ` (${healSubparts.join(", ")})` : ""}`,
    ],
    ["top healer", topHealerStr],
    ["swept", `${report.swept_events.total}${sweptReasonStr ? ` (${sweptReasonStr})` : ""}`],
    ["hook errors", hookErrStr],
    ["stream", streamStr],
    ["event ledger", ledgerStr],
    [
      "zombies",
      report.zombies.count === 0
        ? "0"
        : `${report.zombies.count} (${report.zombies.samples.join(", ")})`,
    ],
    ["councils", councilParts.join(", ")],
    ["anomalies", report.anomalies.length === 0 ? "(clean)" : `${report.anomalies.length} flagged`],
  ];

  const localTime = formatLocalTime(new Date(report.generated_at));
  const title = `Coord Health (${localTime})`;

  process.stdout.write(`${formatBox(title, rows)}\n`); // lint-ok-emission: chat-paste path; mirrors runStatus's direct write so the box surfaces in both TTY + harn-session-teed contexts

  if (report.anomalies.length > 0) {
    process.stdout.write("\n"); // lint-ok-emission: same chat-paste path
    for (const a of report.anomalies) {
      process.stdout.write(`  ! ${a}\n`); // lint-ok-emission: same
    }
  }
}

interface SampleReplayResult {
  file: string;
  event: string | null;
  status: "pass" | "fail" | "skipped" | "error";
  exit_code: number | null;
  stderr_excerpt?: string;
  message?: string;
}

function runAdapterProbe(
  id: string,
  opts: { json?: boolean; replaySamples?: boolean; sample?: string },
): void {
  if (opts.json) emit.config({ format: "json" });

  const adapter = id.trim();
  if (adapter !== "claude-code" && adapter !== "cursor") {
    emit.error({
      code: "bad_adapter",
      message: "adapter id must be claude-code or cursor",
    });
    process.exit(1);
  }

  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }

  const subagentDir =
    adapter === "cursor" ? ".harnery/.cursor-subagent-map" : `.harnery/.subagent-map/${adapter}`;
  const sampleDir =
    adapter === "cursor" ? "docs/api/cursor-hooks/samples" : "docs/api/claude-code-hooks/samples";
  const dispatchEntry =
    adapter === "cursor"
      ? "harnery/bin/agent-hook session-start --adapter cursor"
      : "harnery/bin/agent-hook session-start --adapter claude-code";

  // TS-native probe. The owner + anchor-pid resolution it reports lives in
  // `findAdapterAnchorPid` (core/hooks/cli.ts, the /proc walk mirrored below)
  // and `resolveOwner` here, so the probe reports exactly what the live hot
  // path resolves.
  const anchorTokens = new Set(["claude", "claude-code", "cursor", "codex"]);
  const override = process.env.HARNERY_AGENT_COORD_TEST_ANCHOR_PID;
  let anchorPid = override && Number(override) > 0 ? override : "";
  const chainParts: string[] = [];
  let walkPid = process.pid;
  for (let hops = 0; hops < 20; hops++) {
    let comm = "?";
    let ppid = 0;
    let got = false;
    try {
      comm = readFileSync(`/proc/${walkPid}/comm`, "utf8").trim() || "?";
      const status = readFileSync(`/proc/${walkPid}/status`, "utf8");
      const m = status.match(/^PPid:\s+(\d+)/m);
      ppid = m ? Number(m[1]) : 0;
      got = true;
    } catch {
      // non-Linux (no /proc): fall through to the portable ps walk below.
    }
    if (!got) {
      const out = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(walkPid)], {
        encoding: "utf8",
      });
      const parsed = out.status === 0 ? parsePsChainLine(out.stdout) : null;
      if (parsed) {
        comm = parsed.comm || "?";
        ppid = parsed.ppid;
      }
    }
    chainParts.push(`${walkPid}:${comm}`);
    if (!anchorPid && anchorTokens.has(comm)) anchorPid = String(walkPid);
    if (!ppid || ppid === 0) break;
    walkPid = ppid;
  }

  const data: Record<string, unknown> = {
    adapter,
    anchor_pid: anchorPid,
    hook_pid: String(process.pid),
    resolved_owner: resolveOwner() ?? "",
    ppid_chain: `${chainParts.join(" ")} `,
    subagent_map_dir: subagentDir,
    sample_ref: sampleDir,
    dispatch_entry: dispatchEntry,
    note: "heal-events counts drift; adapter-probe answers wiring",
  };

  const wantReplay = opts.replaySamples || !!opts.sample;
  let samples: SampleReplayResult[] = [];
  let replayExitCode = 0;
  if (wantReplay) {
    const result = replayAdapterSamples(adapter, root, sampleDir, opts.sample);
    samples = result.samples;
    replayExitCode = result.exitCode;
    data.samples = samples;
    data.samples_summary = result.summary;
    if (result.note) data.samples_note = result.note;
  }

  emit.data(data);
  if (process.stdout.isTTY && !opts.json) {
    const lines = [
      `Adapter probe: ${adapter}`,
      `  anchor_pid:    ${String(data.anchor_pid) || "(empty, expected in sandbox/non-IDE)"}`,
      `  hook_pid:      ${String(data.hook_pid)}`,
      `  resolved_owner: ${String(data.resolved_owner) || "(none)"}`,
      `  ppid_chain:    ${String(data.ppid_chain)}`,
      `  samples:       ${String(data.sample_ref)}`,
      `  entry:         ${String(data.dispatch_entry)}`,
    ];
    if (wantReplay) {
      const summary = data.samples_summary as
        | { total: number; pass: number; fail: number; skipped: number }
        | undefined;
      lines.push("");
      if (samples.length === 0) {
        lines.push(
          `  Sample replay: ${String(data.samples_note ?? `no .json fixtures found under ${sampleDir}`)}`,
        );
      } else {
        lines.push(
          `  Sample replay (${samples.length} fixture${samples.length === 1 ? "" : "s"}):`,
        );
        for (const s of samples) {
          const mark = s.status === "pass" ? "✓" : s.status === "skipped" ? "·" : "✗";
          const tail =
            s.status === "fail"
              ? ` (exit ${s.exit_code ?? "?"}${s.stderr_excerpt ? `, stderr: ${s.stderr_excerpt}` : ""})`
              : s.status === "skipped"
                ? ` (${s.message ?? "skipped"})`
                : s.status === "error"
                  ? ` (${s.message ?? "error"})`
                  : "";
          const eventLabel = s.event ? `[${s.event}]`.padEnd(22) : "[?]".padEnd(22);
          lines.push(`    ${mark} ${eventLabel} ${s.file}${tail}`);
        }
        if (summary) {
          lines.push(`  → ${summary.pass} pass, ${summary.fail} fail, ${summary.skipped} skipped`);
        }
      }
    }
    emit.text(`${lines.join("\n")}\n`);
  }

  if (wantReplay && replayExitCode !== 0) {
    process.exit(replayExitCode);
  }
}

/**
 * Replay every JSON fixture in <root>/<sampleDir> against the live adapter
 * dispatcher in an isolated sandbox.
 *
 * Sandbox isolation strategy:
 *   - mkdtempSync(tmpdir(), "harn-adapter-probe-") creates a non-git tmp dir.
 *   - The dispatcher's coord-root resolution falls back to
 *     `HARNERY_COORD_ROOT_OVERRIDE` when git rev-parse fails. We set it to the sandbox.
 *   - We rewrite the payload's `cwd` field (Cursor cds to it) to the sandbox,
 *     so real `.harnery/` never gets touched.
 *   - We set `HARNERY_AGENT_COORD_OFF=0` explicitly so any user-side off-switch in
 *     the environment doesn't mask adapter crashes.
 *
 * Sample shape: probe-meta wrapped (`_probe_meta.event` + `.payload`) OR bare
 * payload with `.hook_event_name`. Event name resolution falls back to the
 * filename (without `.json`) when neither field exists.
 */
function replayAdapterSamples(
  adapter: string,
  root: string,
  relativeSampleDir: string,
  filter?: string,
): {
  samples: SampleReplayResult[];
  exitCode: number;
  summary: { total: number; pass: number; fail: number; skipped: number };
  note?: string;
} {
  const sampleDir = resolve(root, relativeSampleDir);
  if (!existsSync(sampleDir)) {
    return {
      samples: [],
      exitCode: 0,
      summary: { total: 0, pass: 0, fail: 0, skipped: 0 },
      note: `sample directory not found: ${relativeSampleDir} — replay verified nothing`,
    };
  }

  const fixtures = readdirSync(sampleDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .filter((f) => !filter || f === filter || f === `${filter}.json`);

  if (fixtures.length === 0) {
    return {
      samples: [],
      exitCode: 0,
      summary: { total: 0, pass: 0, fail: 0, skipped: 0 },
      note: `no .json fixtures under ${relativeSampleDir} — replay verified nothing`,
    };
  }

  // agent-hook is the single entry point. Replay sample payloads against it,
  // mapping the adapter-native hook_event_name to the agent-hook CLI subcommand.
  const agentHook = resolve(root, "harnery/bin/agent-hook");
  if (!existsSync(agentHook)) {
    return {
      samples: fixtures.map((file) => ({
        file,
        event: null,
        status: "skipped" as const,
        exit_code: null,
        message: "harnery/bin/agent-hook not found",
      })),
      exitCode: 0,
      summary: { total: fixtures.length, pass: 0, fail: 0, skipped: fixtures.length },
    };
  }
  const EVENT_SUBCOMMAND: Record<string, string> = {
    sessionStart: "session-start",
    SessionStart: "session-start",
    sessionEnd: "session-end",
    SessionEnd: "session-end",
    preToolUse: "pre-tool-use",
    PreToolUse: "pre-tool-use",
    beforeShellExecution: "before-shell-execution",
    postToolUse: "post-tool-use",
    PostToolUse: "post-tool-use",
    postToolUseFailure: "post-tool-use-failure",
    PostToolUseFailure: "post-tool-use-failure",
    subagentStart: "sub-agent-start",
    SubagentStart: "sub-agent-start",
    subagentStop: "sub-agent-stop",
    SubagentStop: "sub-agent-stop",
    beforeSubmitPrompt: "user-prompt-submit",
    UserPromptSubmit: "user-prompt-submit",
    stop: "stop",
    Stop: "stop",
    stopFailure: "stop-failure",
    StopFailure: "stop-failure",
  };
  const adapterFlag = adapter;

  const sandbox = mkdtempSync(join(tmpdir(), "harn-adapter-probe-"));
  const results: SampleReplayResult[] = [];

  try {
    for (const file of fixtures) {
      const path = resolve(sampleDir, file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch (err) {
        results.push({
          file,
          event: null,
          status: "error",
          exit_code: null,
          message: `JSON parse failed: ${(err as Error).message}`,
        });
        continue;
      }

      const { event, payload } = extractEventAndPayload(parsed, file);
      if (!event) {
        results.push({
          file,
          event: null,
          status: "skipped",
          exit_code: null,
          message: "no hook_event_name in fixture or filename",
        });
        continue;
      }

      // Rewrite cwd so the dispatcher's repo-cwd resolution lands inside the sandbox.
      const payloadObj =
        payload && typeof payload === "object" ? { ...(payload as Record<string, unknown>) } : {};
      payloadObj.cwd = sandbox;
      if (Array.isArray(payloadObj.workspace_roots)) {
        payloadObj.workspace_roots = [sandbox];
      }

      const subcommand = EVENT_SUBCOMMAND[event] ?? event;
      const dispatch = spawnSync("bash", [agentHook, subcommand, "--adapter", adapterFlag], {
        cwd: sandbox,
        encoding: "utf8",
        input: JSON.stringify(payloadObj),
        timeout: 10_000,
        env: {
          ...process.env,
          HARNERY_COORD_ROOT_OVERRIDE: sandbox,
          HARNERY_AGENT_COORD_ADAPTER: adapter,
          HARNERY_AGENT_COORD_PLATFORM: adapter,
          HARNERY_AGENT_COORD_OFF: "0",
        },
      });

      const exit = dispatch.status ?? -1;
      const stderr = (dispatch.stderr || "").trim();
      const excerpt = stderr.length > 200 ? `${stderr.slice(0, 200)}…` : stderr;

      if (dispatch.error) {
        results.push({
          file,
          event,
          status: "error",
          exit_code: exit,
          message: dispatch.error.message,
          stderr_excerpt: excerpt || undefined,
        });
        continue;
      }

      results.push({
        file,
        event,
        status: exit === 0 ? "pass" : "fail",
        exit_code: exit,
        stderr_excerpt: exit === 0 ? undefined : excerpt || undefined,
      });
    }
  } finally {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; tmp dir will eventually age out
    }
  }

  const summary = {
    total: results.length,
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail" || r.status === "error").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };
  return { samples: results, exitCode: summary.fail > 0 ? 2 : 0, summary };
}

function extractEventAndPayload(
  parsed: unknown,
  filename: string,
): { event: string | null; payload: unknown } {
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const probeMeta = obj._probe_meta;
    if (probeMeta && typeof probeMeta === "object") {
      const meta = probeMeta as Record<string, unknown>;
      const event = typeof meta.event === "string" ? meta.event : null;
      const payload = obj.payload;
      if (event) return { event, payload };
    }
    if (typeof obj.hook_event_name === "string") {
      return { event: obj.hook_event_name, payload: obj };
    }
  }
  // Fall back to filename: `before-shell.json` → `beforeShellExecution`?
  // Too lossy; only use exact basenames that match known events.
  const base = filename.replace(/\.json$/, "");
  const fileBasedMap: Record<string, string> = {
    sessionStart: "sessionStart",
    sessionEnd: "sessionEnd",
    preToolUse: "preToolUse",
    postToolUse: "postToolUse",
    postToolUseFailure: "postToolUseFailure",
    subagentStart: "subagentStart",
    subagentStop: "subagentStop",
    beforeSubmitPrompt: "beforeSubmitPrompt",
    beforeShellExecution: "beforeShellExecution",
    stop: "stop",
  };
  return { event: fileBasedMap[base] ?? null, payload: parsed };
}

function collectPath(value: string, prev: string[]): string[] {
  return [...prev, value];
}

/** Parse "30s", "5m", "1h", "2d" into milliseconds. */
function parseDurationToMs(input: string): number | null {
  const match = input.trim().match(/^(\d+)([smhd])$/i);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2].toLowerCase();
  const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * mult[unit];
}

/** Format ms as "30s" / "5m" / "1h30m" / "2d3h". */
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / 86_400_000);
  const h = Math.round((ms % 86_400_000) / 3_600_000);
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

function runPing(name: string, message: string, opts: { json?: boolean }): void {
  if (!message || message.trim().length === 0) {
    emit.error({ code: "empty_message", message: "message is required (and non-empty)" });
    process.exit(1);
  }
  const myOwner = resolveOwner();
  if (!myOwner) {
    const root = monorepoRoot();
    emit.error(
      root
        ? sessionResolutionFailure(
            root,
            "not in an agent session; ppid walk found no pid-map entry",
          )
        : {
            code: "no_pidmap_entry",
            message: "not in an agent session; ppid walk found no pid-map entry",
          },
    );
    process.exit(1);
  }
  const peerOwner = resolveOwnerByName(name);
  if (!peerOwner) {
    emit.error({
      code: "no_peer",
      message: `no live agent named "${name}" (case-insensitive). Run \`${resolveBinName()} agents list\` to see who's active.`,
    });
    process.exit(1);
  }
  const myHb = readCurrentCoordinationRow(myOwner);
  const fromName = myHb?.name ?? "anonymous";
  const body = `from agent-${fromName}: ${message.trim()}`;
  const doc = appendEntry(peerOwner, "handoff", body);

  // Canonical delivery record: sender is the envelope owner, recipient rides
  // in data, so read-only observers can render the communication without
  // joining journal files.
  emitEventV3({
    owner: myOwner,
    session: nativeSessionIdentity(myHb, myOwner),
    adapter: normalizeAdapter(myHb?.platform),
    observation: {
      event_type: "coord.message_observed",
      direction: "sent",
      subject: peerOwner,
      body: message.trim(),
    },
  });

  const data = {
    peer: name,
    peer_instance_id: peerOwner,
    from: fromName,
    body,
    journal_path: doc.path,
    journal_bytes: doc.bytes,
  };

  if (opts.json) {
    emit.config({ format: "json" });
    emit.data(data);
    return;
  }
  emit.data(data);
  emit.text(`pinged agent-${name}: "${truncate(message.trim(), 80)}"\n`);
}

async function runWait(
  name: string,
  opts: { file: string[]; timeout: string; pollSecs: string; quiet?: boolean; json?: boolean },
): Promise<void> {
  const timeoutMs = parseDurationToMs(opts.timeout);
  const pollSecs = Number.parseInt(opts.pollSecs, 10);
  if (timeoutMs === null) {
    emit.error({
      code: "bad_timeout",
      message: `invalid --timeout: ${opts.timeout} (use 30s, 5m, 1h, 2d, or bare integer = minutes)`,
    });
    process.exit(1);
  }
  if (!Number.isFinite(pollSecs) || pollSecs <= 0) {
    emit.error({ code: "bad_poll", message: `invalid --poll-secs: ${opts.pollSecs}` });
    process.exit(1);
  }

  const peerOwner = resolveOwnerByName(name);
  if (!peerOwner) {
    emit.error({
      code: "no_peer",
      message: `no live agent named "${name}" (case-insensitive)`,
    });
    process.exit(1);
  }
  const waitFor = new Set(opts.file ?? []);

  const startMs = Date.now();
  const pollMs = pollSecs * 1000;

  if (!opts.quiet) {
    const what = waitFor.size > 0 ? `[${Array.from(waitFor).join(", ")}]` : "all held files";
    const header = `waiting for agent-${name} to release ${what} (poll ${pollSecs}s, timeout ${formatDuration(timeoutMs)})\n`;
    process.stderr.write(header); // lint-ok-emission: progress banner to stderr; data resolution stays on stdout via ctx()
  }

  let lastProgressMs = 0;
  while (true) {
    const hb = readCurrentCoordinationRow(peerOwner);
    const now = Date.now();
    const elapsedMs = now - startMs;

    if (!hb) {
      const data = { peer: name, outcome: "gone", elapsed_ms: elapsedMs, files_held: [] };
      emitWaitResult(data, opts);
      return;
    }
    const held = new Set(hb.files_touched ?? []);
    const stillBlocking =
      waitFor.size > 0 ? Array.from(waitFor).filter((f) => held.has(f)) : Array.from(held);

    if (stillBlocking.length === 0) {
      const data = {
        peer: name,
        outcome: "released",
        elapsed_ms: elapsedMs,
        files_held: Array.from(held),
      };
      emitWaitResult(data, opts);
      return;
    }

    if (elapsedMs >= timeoutMs) {
      const data = {
        peer: name,
        outcome: "timeout",
        elapsed_ms: elapsedMs,
        files_held: Array.from(held),
        still_blocking: stillBlocking,
      };
      emitWaitResult(data, opts);
      process.exit(1);
    }

    // Progress line every ~30s (or every poll if interval > 30s).
    const progressGapMs = Math.max(pollMs, 30_000);
    if (!opts.quiet && now - lastProgressMs >= progressGapMs) {
      lastProgressMs = now;
      const elapsedStr = formatAge(Math.floor(elapsedMs / 1000));
      const progress = `  [${elapsedStr}] ${stillBlocking.length} file(s) blocking\n`;
      process.stderr.write(progress); // lint-ok-emission: per-poll progress heartbeat to stderr
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function emitWaitResult(
  data: {
    peer: string;
    outcome: string;
    elapsed_ms: number;
    files_held: string[];
    still_blocking?: string[];
  },
  opts: { quiet?: boolean; json?: boolean },
): void {
  if (opts.json) {
    emit.config({ format: "json" });
    emit.data(data);
    return;
  }
  emit.data(data);
  if (opts.quiet) return;
  const elapsedStr = formatAge(Math.floor(data.elapsed_ms / 1000));
  if (data.outcome === "released") {
    emit.text(`  ✓ agent-${data.peer} released after ${elapsedStr}\n`);
  } else if (data.outcome === "gone") {
    emit.text(`  ✓ agent-${data.peer} session ended after ${elapsedStr}\n`);
  } else {
    emit.text(
      `  ✗ timed out after ${elapsedStr}; agent-${data.peer} still holds ${data.still_blocking?.length ?? 0} file(s)\n`,
    );
  }
}

function runHeal(opts: {
  owner?: string;
  kind?: string;
  sessionId?: string;
  adapter?: string;
  pid?: string;
  quarantineTransaction?: string;
  approvalRecordId?: string;
  yes?: boolean;
  json?: boolean;
}): void {
  if (opts.json) emit.config({ format: "json" });

  const requestedOwner = opts.owner?.trim() ?? "";
  const quarantineTransaction = opts.quarantineTransaction?.trim() ?? "";
  const approvalRecordId = opts.approvalRecordId?.trim() ?? "";
  const kind = opts.kind?.trim() || "cache";
  if (kind !== "pidmap" && kind !== "cache") {
    emit.error({
      code: "bad_kind",
      message: "--kind must be one of: pidmap, cache",
    });
    process.exit(1);
  }
  if (quarantineTransaction) {
    if (opts.kind || opts.pid) {
      emit.error({
        code: "conflicting_recovery_options",
        message: "--quarantine-transaction cannot be combined with --kind or --pid",
      });
      process.exit(1);
    }
    if (!opts.yes || !approvalRecordId) {
      emit.error({
        code: "transaction_quarantine_confirmation_required",
        message:
          "--quarantine-transaction requires --approval-record-id <id> and --yes; " +
          "the command abandons one uncommitted authority mutation while preserving its record",
      });
      process.exit(1);
    }
  } else if (approvalRecordId || opts.yes) {
    emit.error({
      code: "transaction_quarantine_target_required",
      message: "--approval-record-id and --yes require --quarantine-transaction <id>",
    });
    process.exit(1);
  }
  if (
    opts.adapter &&
    opts.adapter !== "claude-code" &&
    opts.adapter !== "cursor" &&
    opts.adapter !== "codex"
  ) {
    emit.error({
      code: "bad_adapter",
      message: "--adapter must be one of: claude-code, cursor, codex",
    });
    process.exit(1);
  }

  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }

  const currentSessionRepair =
    kind === "cache" &&
    opts.owner === undefined &&
    opts.sessionId === undefined &&
    opts.adapter === undefined &&
    !quarantineTransaction;

  const ownerResolution = resolveOwnerWithSource();
  const bootstrapIdentity = currentSessionRepair ? commandSessionBootstrap() : null;
  const resolvedCurrentOwner =
    bootstrapIdentity &&
    (ownerResolution.source === "none" || ownerResolution.source === "active_singleton")
      ? bootstrapIdentity.sessionId
      : ownerResolution.owner;
  const owner = requestedOwner || resolvedCurrentOwner || sessionIdentityFromEnv() || "";
  if (!owner) {
    emit.error({
      code: "session_identity_missing",
      message:
        `could not resolve the current session; run ${resolveBinName()} doctor, or pass ` +
        "--owner <instance-id> --session-id <native-session-id> --adapter <adapter>",
    });
    process.exit(1);
  }

  const currentRow = readLiveCoordinationRow(root, owner);
  const inferredAdapter = normalizeAdapter(
    opts.adapter?.trim() || currentRow?.platform || commandSessionBootstrap()?.adapter,
  );
  const sessionId =
    opts.sessionId?.trim() ||
    (currentSessionRepair ? sessionIdentityFromEnv() : null) ||
    nativeSessionIdentity(currentRow, owner);

  if (kind === "cache") {
    const refusal = cacheHealAuthorityRefusal(root, owner, sessionId, inferredAdapter, currentRow);
    if (refusal) {
      emitHealFailure(refusal.reason, refusal.message);
    }
  }

  const action = quarantineTransaction
    ? "quarantine-authority-transaction"
    : kind === "pidmap"
      ? "heal-pidmap"
      : "repair-coordination-cache";

  // Refuse to materialize a V3 cache at a truncated owner id.
  //
  // Heartbeats are keyed by the whole instance_id, so healing at an
  // abbreviated id writes `.harnery/active/<prefix>.json` while every reader
  // (`status`, `set-task`, `whoami`) resolves `<instance_id>.json`. The heal
  // reports success, the session stays broken, and an orphan file is left
  // behind that the singleton fallback can then mis-resolve other callers to.
  //
  // A distinct instance_id (subagent, workflow child) is never a prefix of its
  // own session_id, so a strict prefix is unambiguously an abbreviated id
  // rather than a legitimately different owner. Only guard the create path: an
  // existing heartbeat at `owner` means the id is real, whatever its shape.
  //
  // Two sources for the canonical id, because the reported failure arrives
  // without `--session-id`: someone copies a truncated id out of a diagnostic
  // and passes it as `--owner` alone. Comparing against `--session-id` alone
  // therefore misses the exact path that produced the orphan; a live heartbeat
  // whose instance_id this id is a prefix of settles it just as well, and is
  // present in precisely the case that matters (the session the reader was
  // trying to heal is registered, just not under the abbreviated name).
  if (kind === "cache" && !readHeartbeatCache(root, owner)) {
    const canonical =
      opts.sessionId && opts.sessionId.trim() !== owner && opts.sessionId.trim().startsWith(owner)
        ? opts.sessionId.trim()
        : liveIdWithPrefix(root, owner);
    if (canonical) {
      const source = opts.sessionId?.trim() === canonical ? "--session-id" : "a live V3 generation";
      emit.error({
        code: "truncated_owner",
        message:
          `--owner ${owner} is a prefix of ${canonical} (${source}). Cache repair requires ` +
          `the canonical instance id; re-run with --owner ${canonical}.`,
      });
      process.exit(1);
    }
  }

  // Build positional args. agent-coord's arg layout:
  //   heal-pidmap <instance_id> [<pid>]
  //   repair-coordination-cache <instance_id> [<session_id>]
  const helperArgs: string[] = [action, owner];
  if (quarantineTransaction) {
    helperArgs.push(
      quarantineTransaction,
      approvalRecordId,
      sessionId,
      `--adapter=${inferredAdapter}`,
    );
  } else {
    if (kind === "pidmap" && opts.pid) helperArgs.push(opts.pid);
    if (kind === "cache") helperArgs.push(sessionId, `--adapter=${inferredAdapter}`);
  }

  // Both recovery actions are handled by the bundled agent-coord binary.
  const helper = agentCoordOrExit(root);
  let proc = spawnSync(helper, helperArgs, {
    encoding: "utf8",
    ...coordHelperOpts(root),
  });

  let bootstrapState: "created" | "reused" | undefined;
  if (
    proc.status !== 0 &&
    currentSessionRepair &&
    missingAuthorityForCurrentSessionBootstrap(root, owner, sessionId)
  ) {
    const bootstrap = commandSessionBootstrap();
    if (
      !bootstrap ||
      bootstrap.sessionId !== sessionId ||
      bootstrap.sessionId !== owner ||
      bootstrap.adapter !== inferredAdapter
    ) {
      emitHealFailure(
        "native_identity_unverified",
        "the current adapter did not provide one matching native session id and adapter",
      );
    }
    try {
      const bootstrapped = bootstrapLiveCoordinationAuthorityV3({
        coordRoot: root,
        owner,
        nativeSessionId: bootstrap.sessionId,
        adapter: bootstrap.adapter,
      });
      bootstrapState = bootstrapped.state;
    } catch (error) {
      const reason =
        error instanceof LiveCoordinationAuthorityV3Error
          ? error.reason
          : "authority_bootstrap_failed";
      emitHealFailure(
        reason,
        "the current native session could not establish authority; no fallback cache was accepted",
      );
    }
    proc = spawnSync(helper, helperArgs, {
      encoding: "utf8",
      ...coordHelperOpts(root),
    });
  }

  if (proc.status !== 0) {
    emitHealFailure(
      healFailureReason(root, owner, sessionId, inferredAdapter),
      spawnFailureMessage(proc, `agent-coord ${action}`),
    );
  }

  // Read the derived cache to surface post-action state.
  let after: Heartbeat | null = null;
  try {
    after = readHeartbeatCache(root, owner);
  } catch {
    after = null;
  }

  const outcome = quarantineTransaction
    ? "transaction_quarantined"
    : kind === "pidmap"
      ? proc.status === 0
        ? "ok"
        : "failed"
      : after
        ? "cache_present"
        : "cache_absent";

  emit.data({
    rows: [
      {
        instance_id: owner,
        action,
        outcome,
        after,
        ...(quarantineTransaction ? { recovery: JSON.parse(proc.stdout.trim()) as unknown } : {}),
      },
    ],
    meta: {
      kind,
      automatic: currentSessionRepair && !quarantineTransaction,
      authority: "event-ledger-v3",
      adapter: kind === "cache" ? inferredAdapter : undefined,
      bootstrap: bootstrapState,
      // The path actually spawned, not a guess at the layout: the helper is
      // resolved from harnery's own package location, which differs between a
      // submodule, an installed dependency, and a standalone checkout.
      helper,
    },
  });
  if (!opts.json) {
    if (quarantineTransaction) {
      emit.text(
        `coordination recovered: ${quarantineTransaction} quarantined with approval ${approvalRecordId}; ` +
          `cache ${after ? "present" : "absent"} (${inferredAdapter})\n`,
      );
    } else if (kind === "pidmap") {
      emit.text(`agent-coord ${action} ok\n`);
    } else {
      emit.text(
        `coordination repaired: V3 authority live; ${currentSessionRepair ? "current-session " : ""}` +
          `cache ${after ? "present" : "absent"} (${inferredAdapter})\n`,
      );
    }
  }

  // Canonical health.* emission is owned by the cache writer, so it fires
  // inside the agent-coord subprocess
  // above on actual writes only: write-only telemetry, no double-emit, no
  // event when an already-correct heal no-ops. (Previously emitted here
  // unconditionally on every `harn agents heal`, which over-counted no-op heals.)
}

type HealAuthorityRefusal = {
  reason: "adapter_mismatch" | "owner_mismatch" | "session_mismatch" | "terminal_generation";
  message: string;
};

function cacheHealAuthorityRefusal(
  root: string,
  owner: string,
  sessionId: string,
  adapter: "claude-code" | "cursor" | "codex",
  currentRow: LiveCoordinationRow | null,
): HealAuthorityRefusal | null {
  if (currentRow && normalizeAdapter(currentRow.platform) !== adapter) {
    return {
      reason: "adapter_mismatch",
      message: `the live generation belongs to adapter ${normalizeAdapter(currentRow.platform)}, not ${adapter}`,
    };
  }
  let producer: ReturnType<typeof readHookProducerStateV3>;
  try {
    producer = readHookProducerStateV3(root, adapter, sessionId);
  } catch {
    return {
      reason: "session_mismatch",
      message: "the native session producer state could not be read safely",
    };
  }
  if (producer?.terminal) {
    return {
      reason: "terminal_generation",
      message: "the matching generation is terminal and cannot be repaired or reopened by heal",
    };
  }
  if (producer && producer.instance_id !== liveInstanceIdV3(owner)) {
    return {
      reason: "owner_mismatch",
      message: "the native session is bound to a different instance owner",
    };
  }
  if (currentRow && (!producer || producer.generation_id !== currentRow.v3_generation_id)) {
    return {
      reason: "session_mismatch",
      message: "the native session does not bind to the requested live generation",
    };
  }
  return null;
}

function missingAuthorityForCurrentSessionBootstrap(
  root: string,
  owner: string,
  sessionId: string,
): boolean {
  if (readLiveCoordinationRow(root, owner)) return false;
  try {
    const nativeSessionHasProducer = (["claude-code", "codex", "cursor"] as const).some(
      (adapter) => readHookProducerStateV3(root, adapter, sessionId) !== undefined,
    );
    if (nativeSessionHasProducer) return false;
    const instanceId = liveInstanceIdV3(owner);
    return !listHookProducerStateRecordsV3(root, { includeTerminal: true }).some(
      ({ state }) => state.instance_id === instanceId,
    );
  } catch {
    return false;
  }
}

function healFailureReason(
  root: string,
  owner: string,
  sessionId: string,
  adapter: "claude-code" | "cursor" | "codex",
): string {
  const refusal = cacheHealAuthorityRefusal(
    root,
    owner,
    sessionId,
    adapter,
    readLiveCoordinationRow(root, owner),
  );
  return refusal?.reason ?? "authority_missing";
}

function emitHealFailure(reason: string, message: string): never {
  emit.error({
    code: "heal_failed",
    message: `coordination heal refused (reason=${reason}): ${message}`,
  });
  process.exit(1);
}

/**
 * Emit one V3 council audit transition keyed to the exact durable manifest.
 * Falls through silently when no live session can attest the observation.
 */
function emitCouncilStateEvent(
  manifest: CouncilManifest,
  newState: string,
  priorState?: string,
): void {
  const myOwner = resolveOwner();
  if (!myOwner) return;
  const hb = readCurrentCoordinationRow(myOwner);
  emitEventV3({
    owner: myOwner,
    session: nativeSessionIdentity(hb, myOwner),
    adapter: normalizeAdapter(hb?.platform),
    observation: {
      event_type: "council.state_changed",
      council_id: manifest.council_id,
      ...(priorState ? { prior_state: priorState } : {}),
      new_state: newState,
      record: manifest,
    },
  });
}

// ──────── council subcommand impls ────────

function runCouncilCreate(
  objective: string,
  opts: {
    members: string;
    targetDoc?: string;
    steward?: string;
    autoAdvance?: boolean;
    createdBy?: string;
    json?: boolean;
  },
): void {
  if (opts.json) emit.config({ format: "json" });

  const trimmedObjective = objective.trim();
  if (!trimmedObjective) {
    emit.error({
      code: "missing_objective",
      message: "<objective> must be a non-empty string",
    });
    process.exit(1);
  }

  const members = opts.members
    .split(",")
    .map((m) => normalizeAgentName(m))
    .filter(Boolean);
  if (members.length === 0) {
    emit.error({
      code: "no_members",
      message: "--members must list at least one agent",
    });
    process.exit(1);
  }

  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }

  // Resolve convener: explicit --created-by overrides; otherwise read the
  // running agent's heartbeat. Falls back to "agent-unknown" only when neither
  // path resolves (CI / direct script invocation with no session).
  const myOwner = resolveOwner();
  let createdBy = "agent-unknown";
  if (opts.createdBy?.trim()) {
    createdBy = normalizeAgentName(opts.createdBy);
  } else if (myOwner) {
    const myHb = readCurrentCoordinationRow(myOwner);
    if (myHb?.name) {
      createdBy = normalizeAgentName(myHb.name);
    }
  }

  // Resolve steward: explicit --steward overrides; otherwise defaults to the
  // convener. If explicit, must be a member of the council.
  let steward: string | undefined;
  if (opts.steward?.trim()) {
    const normalized = normalizeAgentName(opts.steward);
    if (!members.includes(normalized)) {
      emit.error({
        code: "steward_not_a_member",
        message: `--steward '${normalized}' is not in --members list (${members.join(", ")})`,
      });
      process.exit(1);
    }
    steward = normalized;
  }

  // Mint identities for every persona referenced in the manifest (convener,
  // optional steward, and every member) so the canonical FK arrays are
  // populated before the manifest hits disk. ensureIdentity is idempotent.
  const createdByIdentity = ensureIdentity(createdBy);
  const stewardIdentity = steward ? ensureIdentity(steward) : null;
  const memberIdentities = members.map((m) => ensureIdentity(m));

  const councilId = buildCouncilId(trimmedObjective);
  const manifest: CouncilManifest = {
    schema_version: COUNCIL_SCHEMA_VERSION,
    council_id: councilId,
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    created_by: createdBy,
    created_by_id: createdByIdentity.agent_id,
    ...(steward && stewardIdentity ? { steward, steward_id: stewardIdentity.agent_id } : {}),
    objective: trimmedObjective,
    target_doc: opts.targetDoc?.trim() || null,
    members,
    member_ids: memberIdentities.map((m) => m.agent_id),
    current_round: 1,
    round_status: "open",
    status: "active",
    auto_advance: !!opts.autoAdvance,
    round_visibility: "next_round",
  };

  // Create body dir + first round dir + write invite + manifest.
  const body = councilBodyDir(councilId);
  if (!body) {
    emit.error({
      code: "no_body_dir",
      message: "could not resolve .harnery/councils/<id>/: coord root missing",
    });
    process.exit(1);
  }
  mkdirSync(resolve(body, "round-1"), { recursive: true });
  writeFileSync(resolve(body, "invite.md"), buildInviteMarkdown(manifest), "utf8");
  writeManifest(manifest);

  if (myOwner) {
    const myHbForEmit = readCurrentCoordinationRow(myOwner);
    emitEventV3({
      owner: myOwner,
      session: nativeSessionIdentity(myHbForEmit, myOwner),
      adapter: normalizeAdapter(myHbForEmit?.platform),
      observation: {
        event_type: "council.state_changed",
        council_id: manifest.council_id,
        new_state: "active",
        record: manifest,
      },
    });
  }

  // Best-effort: ping each currently-active member's journal with a
  // handoff entry pointing them at the council. Members not currently active
  // get nothing here; the Phase 2 SessionStart adapter will surface the
  // invite on their next session.
  const pingedMembers: string[] = [];
  const skippedMembers: string[] = [];
  for (const memberName of members) {
    const bareName = memberName.replace(/^agent-/, "");
    if (myOwner && readCurrentCoordinationRow(myOwner)?.name === bareName) {
      // Convener is themselves a member; skip the self-ping
      continue;
    }
    const memberOwner = resolveOwnerByName(bareName);
    if (!memberOwner) {
      skippedMembers.push(memberName);
      continue;
    }
    try {
      appendEntry(
        memberOwner,
        "handoff",
        `from ${createdBy} (council create): you're in council \`${councilId}\`; ` +
          `objective: ${trimmedObjective.slice(0, 140)}${trimmedObjective.length > 140 ? "…" : ""}. ` +
          `Run \`${resolveBinName()} agents council show ${councilId}\` for context.`,
      );
      pingedMembers.push(memberName);
    } catch {
      skippedMembers.push(memberName);
    }
  }

  emit.data({
    rows: [
      {
        council_id: councilId,
        objective: trimmedObjective,
        members,
        target_doc: manifest.target_doc,
        auto_advance: manifest.auto_advance,
        pinged_members: pingedMembers,
        skipped_members: skippedMembers,
        manifest,
      },
    ],
    meta: {
      action: "council-create",
      created_by: createdBy,
    },
  });
  if (!opts.json) {
    emit.text(
      `council ${councilId} created: round 1 open, ${members.length} member(s) (${pingedMembers.length} pinged, ${skippedMembers.length} dormant)\n` +
        `view: harn agents council show ${councilId}\n`,
    );
  }
}

function runCouncilList(opts: { status?: string; mine?: boolean; json?: boolean }): void {
  if (opts.json) emit.config({ format: "json" });

  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }

  let myName: string | null = null;
  if (opts.mine) {
    const myOwner = resolveOwner();
    if (myOwner) {
      const myHb = readCurrentCoordinationRow(myOwner);
      if (myHb?.name) myName = normalizeAgentName(myHb.name);
    }
    if (!myName) {
      emit.error({
        code: "no_self_name",
        message: "--mine requires resolving the running agent's name; no heartbeat found",
      });
      process.exit(1);
    }
  }

  const allManifests = listManifests();
  const filtered = allManifests.filter((m) => {
    if (opts.status && m.status !== (opts.status as CouncilStatus)) return false;
    if (opts.mine && myName && !m.members.includes(myName)) return false;
    return true;
  });

  filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));

  emit.data({
    rows: filtered.map((m) => ({
      council_id: m.council_id,
      status: m.status,
      round: m.current_round,
      round_status: m.round_status,
      members: m.members,
      created_by: m.created_by,
      created_at: m.created_at,
      objective: m.objective,
      target_doc: m.target_doc,
      auto_advance: m.auto_advance,
    })),
    meta: {
      action: "council-list",
      total_active_dir: allManifests.length,
      filtered_count: filtered.length,
      mine: opts.mine ?? false,
      status_filter: opts.status ?? null,
    },
  });
  if (!opts.json) {
    if (filtered.length === 0) {
      emit.text(
        opts.mine
          ? "no councils include you as a member.\n"
          : "no councils in .harnery/councils/.\n",
      );
      return;
    }
    const lines: string[] = [];
    for (const m of filtered) {
      const objShort = m.objective.length > 60 ? `${m.objective.slice(0, 59)}…` : m.objective;
      lines.push(
        `${m.council_id}  [${m.status}; round ${m.current_round} ${m.round_status}]  by ${m.created_by}  members=${m.members.length}\n` +
          `  └─ ${objShort}\n`,
      );
    }
    emit.text(lines.join(""));
  }
}

function runCouncilShow(id: string, opts: { json?: boolean }): void {
  if (opts.json) emit.config({ format: "json" });

  const manifest = readManifest(id) || findManifestByPartialId(id);
  if (!manifest) {
    emit.error({
      code: "council_not_found",
      message: `no council matching '${id}' in .harnery/councils/`,
    });
    process.exit(1);
  }

  // Read invite.md if present
  const body = councilBodyDir(manifest.council_id);
  let invite: string | null = null;
  if (body) {
    const invitePath = resolve(body, "invite.md");
    if (existsSync(invitePath)) {
      invite = readFileSync(invitePath, "utf8");
    }
  }

  // Read prior rounds' contributions (current round held back per
  // round_visibility=next_round).
  const visibleRound = Math.max(0, manifest.current_round - 1);
  const priorRounds: Array<{
    round: number;
    contributions: Array<{ author: string; body: string }>;
  }> = [];
  if (body && visibleRound > 0) {
    for (let r = 1; r <= visibleRound; r++) {
      const roundDir = resolve(body, `round-${r}`);
      if (!existsSync(roundDir)) continue;
      const contribs: Array<{ author: string; body: string }> = [];
      for (const f of readdirSync(roundDir).sort()) {
        if (!f.endsWith(".md")) continue;
        const author = f.slice(0, -3);
        const content = readFileSync(resolve(roundDir, f), "utf8");
        contribs.push({ author, body: content });
      }
      priorRounds.push({ round: r, contributions: contribs });
    }
  }

  // Read current-round prompts (steward-drafted routing instructions per
  // member). Each entry carries `completed` so the UI can dim/strike the
  // prompts for members who have already contributed this round.
  const currentRoundPrompts = readRoundPrompts(manifest, manifest.current_round);

  emit.data({
    rows: [
      {
        manifest,
        invite,
        prior_rounds: priorRounds,
        current_round: manifest.current_round,
        visible_through_round: visibleRound,
        steward: effectiveSteward(manifest),
        current_round_prompts: currentRoundPrompts,
      },
    ],
    meta: { action: "council-show" },
  });
  if (!opts.json) {
    const lines: string[] = [];
    if (invite) lines.push(invite);
    lines.push("---\n");
    lines.push(
      `**Status:** ${manifest.status}, round ${manifest.current_round} ${manifest.round_status}\n`,
    );
    if (priorRounds.length > 0) {
      lines.push("\n## Prior rounds\n");
      for (const r of priorRounds) {
        lines.push(`\n### Round ${r.round}\n`);
        for (const c of r.contributions) {
          lines.push(`\n#### ${c.author}\n\n${c.body}\n`);
        }
      }
    } else if (manifest.current_round > 1) {
      lines.push("\n_(Prior rounds exist but no contributions on disk yet.)_\n");
    } else {
      lines.push(
        "\n_Round 1 open. Peer contributions surface here once round 2 opens (round_visibility=next_round)._\n",
      );
    }
    emit.text(lines.join(""));
  }
}

function runCouncilClose(id: string, opts: { json?: boolean }): void {
  if (opts.json) emit.config({ format: "json" });

  const manifest = readManifest(id) || findManifestByPartialId(id);
  if (!manifest) {
    emit.error({
      code: "council_not_found",
      message: `no council matching '${id}' in .harnery/councils/`,
    });
    process.exit(1);
  }
  if (manifest.status === "archived") {
    emit.error({
      code: "already_archived",
      message: `council ${manifest.council_id} is already archived; close is a no-op`,
    });
    process.exit(1);
  }

  const next: CouncilManifest = {
    ...manifest,
    status: "closed",
    closed_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  writeManifest(next);
  emitCouncilStateEvent(next, "closed", manifest.status);

  // Build the transcript: every round's contributions in order.
  const transcript = buildTranscript(next);

  emit.data({
    rows: [
      {
        council_id: next.council_id,
        status: next.status,
        closed_at: next.closed_at,
        rounds_with_contributions: transcript.rounds.length,
        manifest: next,
      },
    ],
    meta: { action: "council-close" },
  });
  if (!opts.json) {
    emit.text(
      `council ${next.council_id} closed at ${next.closed_at}.\nmanifest kept in .harnery/councils/ (use 'harn agents council archive ${next.council_id}' to move it).\n\n${transcript.markdown}`,
    );
  }
}

function runCouncilArchive(id: string, opts: { json?: boolean }): void {
  if (opts.json) emit.config({ format: "json" });

  const manifest = readManifest(id) || findManifestByPartialId(id);
  if (!manifest) {
    emit.error({
      code: "council_not_found",
      message: `no council matching '${id}' in .harnery/councils/`,
    });
    process.exit(1);
  }

  const next: CouncilManifest = {
    ...manifest,
    status: "archived",
    archived_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  // Write the archived manifest BEFORE moving, so the moved file carries the
  // updated status. moveToArchive then physically relocates the artifacts.
  writeManifest(next);
  moveToArchive(next.council_id);
  emitCouncilStateEvent(next, "archived", manifest.status);

  emit.data({
    rows: [
      {
        council_id: next.council_id,
        status: next.status,
        archived_at: next.archived_at,
        manifest: next,
      },
    ],
    meta: { action: "council-archive" },
  });
  if (!opts.json) {
    emit.text(
      `council ${next.council_id} archived at ${next.archived_at}, moved to .harnery/councils/archive/.\n`,
    );
  }
}

function runCouncilUnarchive(id: string, opts: { json?: boolean }): void {
  if (opts.json) emit.config({ format: "json" });

  // Unarchive sources from the archive dir; the active dir is empty by
  // definition for an archived council. readArchivedManifest scopes the
  // lookup; we accept the full council_id only here (no partial-id
  // search across archive) to keep the safety surface tight.
  const manifest = readArchivedManifest(id);
  if (!manifest) {
    emit.error({
      code: "council_not_found",
      message: `no archived council matching '${id}' in .harnery/councils/archive/`,
    });
    process.exit(1);
  }
  if (manifest.status !== "archived") {
    emit.error({
      code: "council_not_archived",
      message: `council ${manifest.council_id} is ${manifest.status}, not archived; nothing to unarchive`,
    });
    process.exit(1);
  }

  // Restore status from closed_at: set means it was closed before archive,
  // empty means it was archived from an active state (unusual but valid).
  const restoredStatus: CouncilManifest["status"] = manifest.closed_at ? "closed" : "active";
  // Strip archived_at off the manifest. Keep closed_at if it was set so the
  // close-out handoff detection + banner state survive the round-trip.
  const { archived_at: _archived_at, ...rest } = manifest;
  void _archived_at;
  const next: CouncilManifest = {
    ...rest,
    status: restoredStatus,
  };
  // Physically move first (rename within active dir), then write the
  // updated manifest. moveFromArchive is no-op when source missing
  // (allows re-running for testing).
  moveFromArchive(next.council_id);
  writeManifest(next);
  emitCouncilStateEvent(next, restoredStatus, "archived");

  emit.data({
    rows: [
      {
        council_id: next.council_id,
        status: next.status,
        closed_at: next.closed_at,
        manifest: next,
      },
    ],
    meta: { action: "council-unarchive" },
  });
  if (!opts.json) {
    emit.text(
      `council ${next.council_id} unarchived: status restored to ${next.status}, manifest moved back to .harnery/councils/.\n`,
    );
  }
}

function runCouncilDelete(id: string, opts: { yes?: boolean; json?: boolean }): void {
  if (opts.json) emit.config({ format: "json" });

  // Source from the archive dir only; refusing implicit-by-omission means
  // we never confuse delete with archive.
  const manifest = readArchivedManifest(id);
  if (!manifest) {
    emit.error({
      code: "council_not_archived",
      message: `no archived council matching '${id}' in .harnery/councils/archive/; archive it first (the trash-can pattern; archive is reversible, delete is not)`,
    });
    process.exit(1);
  }

  const archive = councilsArchiveDir();
  const manifestPath = archive ? `${archive}/${manifest.council_id}.json` : null;
  const bodyDir = archive ? `${archive}/${manifest.council_id}` : null;

  if (!opts.yes) {
    // Dry-run: print the targets and exit 0. The web UI doesn't go through
    // this path (it always passes --yes) so this gate only
    // catches operator-side fumbles.
    emit.data({
      rows: [
        {
          council_id: manifest.council_id,
          would_delete: [manifestPath, bodyDir].filter(Boolean),
          confirmed: false,
        },
      ],
      meta: { action: "council-delete", dry_run: true },
    });
    if (!opts.json) {
      emit.text(
        `dry-run, would delete:\n  ${manifestPath}\n  ${bodyDir}/\npass --yes to confirm.\n`,
      );
    }
    return;
  }

  const removed = deleteArchivedCouncil(manifest.council_id);
  if (removed) {
    emitCouncilStateEvent(manifest, "deleted", "archived");
  }

  emit.data({
    rows: [
      {
        council_id: manifest.council_id,
        removed,
        confirmed: true,
      },
    ],
    meta: { action: "council-delete" },
  });
  if (!opts.json) {
    emit.text(
      removed
        ? `council ${manifest.council_id} deleted: manifest + body dir removed from .harnery/councils/archive/.\n`
        : `council ${manifest.council_id} had nothing to delete (already gone).\n`,
    );
  }
}

function runCouncilSetSteward(
  id: string,
  stewardArg: string | undefined,
  opts: { clear?: boolean; allowUnknown?: boolean; json?: boolean },
): void {
  if (opts.json) emit.config({ format: "json" });

  const lookup = readManifest(id) || findManifestByPartialId(id);
  if (!lookup) {
    emit.error({
      code: "council_not_found",
      message: `no council matching '${id}' in .harnery/councils/`,
    });
    process.exit(1);
  }

  let steward: string | null;
  if (opts.clear || !stewardArg) {
    steward = null;
  } else {
    steward = normalizeAgentName(stewardArg);
    if (!/^agent-[A-Za-z][A-Za-z0-9_-]*$/.test(steward)) {
      emit.error({
        code: "invalid_steward",
        message: `invalid steward '${stewardArg}' (must match agent-[A-Za-z][A-Za-z0-9_-]*)`,
      });
      process.exit(1);
    }
    if (!opts.allowUnknown) {
      const known = listKnownAgents();
      if (!known.some((a) => a.name === steward)) {
        const known_names = known.map((a) => a.name).join(", ") || "(none)";
        emit.error({
          code: "steward_not_known",
          message: `'${steward}' is not a known agent (active heartbeats + journals archived in the last 30 days). Pass --allow-unknown to bootstrap. Known: ${known_names}`,
        });
        process.exit(1);
      }
    }
  }

  let next: CouncilManifest;
  try {
    next = setCouncilSteward(lookup.council_id, steward);
  } catch (err) {
    emit.error({
      code: "council_set_steward_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  emit.data({
    rows: [
      {
        council_id: next.council_id,
        status: next.status,
        steward: next.steward ?? null,
        manifest: next,
      },
    ],
    meta: { action: "council-set-steward" },
  });
  if (!opts.json) {
    const label = steward ?? `(cleared, defaults to ${next.created_by})`;
    emit.text(`council ${next.council_id} steward set to ${label}.\n`);
  }
}

/** Build a markdown journal of every round's contributions on disk. */
function buildTranscript(manifest: CouncilManifest): {
  markdown: string;
  rounds: Array<{ round: number; contributions: number }>;
} {
  const body = councilBodyDir(manifest.council_id);
  const out: string[] = [];
  const rounds: Array<{ round: number; contributions: number }> = [];
  out.push(`# Council transcript: ${manifest.council_id}\n`);
  out.push(`**Objective:** ${manifest.objective}\n`);
  out.push(`**Members:** ${manifest.members.join(", ")}\n`);
  out.push(`**Convened by:** ${manifest.created_by}\n`);
  out.push(`**Status:** ${manifest.status}`);
  if (manifest.closed_at) out.push(` (closed ${manifest.closed_at})`);
  out.push("\n\n");

  if (!body || !existsSync(body)) {
    return { markdown: out.join(""), rounds };
  }
  for (let r = 1; r <= manifest.current_round; r++) {
    const roundDir = resolve(body, `round-${r}`);
    if (!existsSync(roundDir)) continue;
    const files = readdirSync(roundDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    if (files.length === 0) continue;
    rounds.push({ round: r, contributions: files.length });
    out.push(`## Round ${r}\n\n`);
    for (const f of files) {
      const author = f.slice(0, -3);
      const content = readFileSync(resolve(roundDir, f), "utf8");
      out.push(`### ${author}\n\n${content}\n\n`);
    }
  }
  return { markdown: out.join(""), rounds };
}

const CONTRIBUTION_MAX_BYTES = 4 * 1024;

function runCouncilContribute(
  id: string,
  opts: { message?: string; file?: string; as?: string; json?: boolean },
): void {
  if (opts.json) emit.config({ format: "json" });

  if (!opts.message && !opts.file) {
    emit.error({
      code: "missing_body",
      message: "must pass either --message <inline> or --file <path>",
    });
    process.exit(1);
  }
  if (opts.message && opts.file) {
    emit.error({
      code: "ambiguous_body",
      message: "pass only one of --message or --file, not both",
    });
    process.exit(1);
  }

  const manifest = readManifest(id) || findManifestByPartialId(id);
  if (!manifest) {
    emit.error({
      code: "council_not_found",
      message: `no council matching '${id}'`,
    });
    process.exit(1);
  }
  if (manifest.status !== "active") {
    emit.error({
      code: "council_not_active",
      message: `council ${manifest.council_id} is ${manifest.status}; cannot accept contributions`,
    });
    process.exit(1);
  }

  // Resolve the contributor name. Two paths:
  // 1. --as <member> override: caller explicitly names the council seat. Used
  //    for cross-adapter councils where each reviewer agent has a different
  //    auto-generated session name from a different name pool; they can
  //    contribute under a fixed seat name without renaming the session.
  // 2. Heartbeat-derived (default): resolve owner via ppid walk + read the
  //    .name field on the heartbeat. Original behavior.
  let myName: string;
  let actualName: string | null = null;
  if (opts.as) {
    myName = normalizeAgentName(opts.as);
    if (!manifest.members.includes(myName)) {
      emit.error({
        code: "not_a_member",
        message: `--as '${myName}' is not a member of council ${manifest.council_id}; members: ${manifest.members.join(", ")}`,
      });
      process.exit(1);
    }
    // Best-effort: capture the actual session name for the stderr note.
    // Failure is non-fatal; the override is the whole point.
    try {
      const myOwner = resolveOwner();
      if (myOwner) {
        const myHb = readCurrentCoordinationRow(myOwner);
        if (myHb?.name) actualName = normalizeAgentName(myHb.name);
      }
    } catch {
      /* non-fatal */
    }
  } else {
    const myOwner = resolveOwner();
    if (!myOwner) {
      emit.error({
        code: "no_self",
        message:
          "not in an agent session; can't determine who is contributing (pass --as <member> to override)",
      });
      process.exit(1);
    }
    const myHb = readCurrentCoordinationRow(myOwner);
    if (!myHb?.name) {
      emit.error({
        code: "no_self_name",
        message: `resolved owner ${myOwner} has no name on heartbeat (pass --as <member> to override)`,
      });
      process.exit(1);
    }
    myName = normalizeAgentName(myHb.name);
    if (!manifest.members.includes(myName)) {
      emit.error({
        code: "not_a_member",
        message: `${myName} is not a member of council ${manifest.council_id}; members: ${manifest.members.join(", ")} (pass --as <member> to override)`,
      });
      process.exit(1);
    }
  }

  // Load body
  let body: string;
  if (opts.message) {
    if (opts.message.length > CONTRIBUTION_MAX_BYTES) {
      emit.error({
        code: "message_too_long",
        message: `--message exceeds ${CONTRIBUTION_MAX_BYTES} byte cap; use --file for longer contributions`,
      });
      process.exit(1);
    }
    body = opts.message;
  } else {
    const filePath = opts.file as string;
    if (!existsSync(filePath)) {
      emit.error({
        code: "file_not_found",
        message: `--file path does not exist: ${filePath}`,
      });
      process.exit(1);
    }
    body = readFileSync(filePath, "utf8");
  }

  // Idempotency: if the contributor already has a file in this round, refuse
  // (force re-contribution would erase prior work without a "are you sure").
  const existing = contributorsInRound(manifest.council_id, manifest.current_round);
  if (existing.includes(myName)) {
    emit.error({
      code: "already_contributed",
      message: `${myName} already contributed to round ${manifest.current_round}; delete .harnery/councils/${manifest.council_id}/round-${manifest.current_round}/${myName}.md first if you need to re-submit`,
    });
    process.exit(1);
  }

  const path = writeContribution(manifest.council_id, manifest.current_round, myName, body);
  emitCouncilStateEvent(manifest, "contribution_recorded", manifest.round_status);

  // Update manifest: if all members have now contributed, flip round_status.
  const contributorsNow = contributorsInRound(manifest.council_id, manifest.current_round);
  const allIn = manifest.members.every((m) => contributorsNow.includes(m));
  let nextManifest = manifest;
  let autoAdvanced = false;
  if (allIn) {
    nextManifest = { ...manifest, round_status: "collected" };
    writeManifest(nextManifest);
    emitCouncilStateEvent(nextManifest, "round_closed", manifest.round_status);
    if (manifest.auto_advance) {
      nextManifest = advanceCouncil(nextManifest, /*force=*/ false);
      emitCouncilStateEvent(nextManifest, "round_open", "round_closed");
      autoAdvanced = true;
    }
  }

  emit.data({
    rows: [
      {
        council_id: manifest.council_id,
        contributor: myName,
        actual_session_name: actualName,
        round: manifest.current_round,
        bytes_written: Buffer.byteLength(body, "utf8"),
        path,
        round_status: nextManifest.round_status,
        all_members_in: allIn,
        auto_advanced: autoAdvanced,
        current_round: nextManifest.current_round,
      },
    ],
    meta: { action: "council-contribute" },
  });
  if (!opts.json) {
    let summary = `${myName} contributed to round ${manifest.current_round} of ${manifest.council_id} (${contributorsNow.length}/${manifest.members.length} members in).`;
    if (allIn) summary += " round is collected";
    if (autoAdvanced) summary += `; auto-advanced to round ${nextManifest.current_round}.`;
    else if (allIn) summary += ".";
    if (opts.as && actualName && actualName !== myName) {
      summary += ` (contributed as '${myName}'; actual session is '${actualName}')`;
    }
    emit.text(`${summary}\n`);
  }
}

function runCouncilPrompt(
  id: string,
  member: string,
  opts: { message?: string; file?: string; as?: string; json?: boolean },
): void {
  if (opts.json) emit.config({ format: "json" });

  if (!opts.message && !opts.file) {
    emit.error({
      code: "missing_body",
      message: "must pass either --message <inline> or --file <path>",
    });
    process.exit(1);
  }
  if (opts.message && opts.file) {
    emit.error({
      code: "ambiguous_body",
      message: "pass only one of --message or --file, not both",
    });
    process.exit(1);
  }

  const manifest = readManifest(id) || findManifestByPartialId(id);
  if (!manifest) {
    emit.error({
      code: "council_not_found",
      message: `no council matching '${id}'`,
    });
    process.exit(1);
  }
  if (manifest.status !== "active") {
    emit.error({
      code: "council_not_active",
      message: `council ${manifest.council_id} is ${manifest.status}; cannot accept prompts`,
    });
    process.exit(1);
  }

  // Validate target member is on the council.
  const targetName = normalizeAgentName(member);
  if (!manifest.members.includes(targetName)) {
    emit.error({
      code: "not_a_member",
      message: `'${targetName}' is not a member of council ${manifest.council_id}; members: ${manifest.members.join(", ")}`,
    });
    process.exit(1);
  }

  // Resolve caller identity (steward authority check). Same --as override
  // shape as `contribute` for cross-adapter scripting.
  let callerName: string;
  let actualName: string | null = null;
  if (opts.as) {
    callerName = normalizeAgentName(opts.as);
    try {
      const myOwner = resolveOwner();
      if (myOwner) {
        const myHb = readCurrentCoordinationRow(myOwner);
        if (myHb?.name) actualName = normalizeAgentName(myHb.name);
      }
    } catch {
      /* non-fatal */
    }
  } else {
    const myOwner = resolveOwner();
    if (!myOwner) {
      emit.error({
        code: "no_self",
        message:
          "not in an agent session; can't determine steward identity (pass --as <steward> to override)",
      });
      process.exit(1);
    }
    const myHb = readCurrentCoordinationRow(myOwner);
    if (!myHb?.name) {
      emit.error({
        code: "no_self_name",
        message: `resolved owner ${myOwner.slice(0, 8)} has no name on heartbeat (pass --as <steward> to override)`,
      });
      process.exit(1);
    }
    callerName = normalizeAgentName(myHb.name);
  }

  // Steward authority: only the designated steward (defaults to convener) may
  // write prompts. This stops peer contributors from overwriting each other's
  // routing instructions mid-council.
  const stewardName = effectiveSteward(manifest);
  if (callerName !== stewardName) {
    emit.error({
      code: "not_the_steward",
      message: `${callerName} is not the steward of council ${manifest.council_id} (steward: ${stewardName}). Stewardship is set at council creation via --steward, or by direct manifest edit.`,
    });
    process.exit(1);
  }

  // Load body
  let body: string;
  if (opts.message) {
    if (opts.message.length > CONTRIBUTION_MAX_BYTES) {
      emit.error({
        code: "message_too_long",
        message: `--message exceeds ${CONTRIBUTION_MAX_BYTES} byte cap; use --file for longer prompts`,
      });
      process.exit(1);
    }
    body = opts.message;
  } else {
    const filePath = opts.file as string;
    if (!existsSync(filePath)) {
      emit.error({
        code: "file_not_found",
        message: `--file path does not exist: ${filePath}`,
      });
      process.exit(1);
    }
    body = readFileSync(filePath, "utf8");
  }

  // Prompts are idempotent: overwriting an existing one is intended (the
  // steward refines as the round evolves). No "already wrote" guard here.
  const path = writePrompt(manifest.council_id, manifest.current_round, targetName, body);

  // Did the target already contribute? If so, the prompt is being written
  // for archival/audit only; surface that to the steward.
  const contributorsNow = contributorsInRound(manifest.council_id, manifest.current_round);
  const targetAlreadyIn = contributorsNow.includes(targetName);

  emit.data({
    rows: [
      {
        council_id: manifest.council_id,
        steward: stewardName,
        target: targetName,
        actual_session_name: actualName,
        round: manifest.current_round,
        bytes_written: Buffer.byteLength(body, "utf8"),
        path,
        target_already_contributed: targetAlreadyIn,
      },
    ],
    meta: { action: "council-prompt" },
  });
  if (!opts.json) {
    let summary = `${stewardName} wrote round-${manifest.current_round} prompt for ${targetName} (${Buffer.byteLength(body, "utf8")} bytes).`;
    if (targetAlreadyIn) {
      summary += ` Note: ${targetName} has already contributed to this round.`;
    }
    if (opts.as && actualName && actualName !== callerName) {
      summary += ` (acting as '${callerName}'; actual session is '${actualName}')`;
    }
    emit.text(`${summary}\n`);
  }
}

function runCouncilStatus(id: string, opts: { json?: boolean }): void {
  if (opts.json) emit.config({ format: "json" });

  const manifest = readManifest(id) || findManifestByPartialId(id);
  if (!manifest) {
    emit.error({
      code: "council_not_found",
      message: `no council matching '${id}'`,
    });
    process.exit(1);
  }

  const contributors = contributorsInRound(manifest.council_id, manifest.current_round);
  const pending = manifest.members.filter((m) => !contributors.includes(m));
  const allIn = pending.length === 0;

  emit.data({
    rows: [
      {
        council_id: manifest.council_id,
        status: manifest.status,
        current_round: manifest.current_round,
        round_status: manifest.round_status,
        members: manifest.members,
        contributors,
        pending,
        all_in: allIn,
        auto_advance: manifest.auto_advance,
      },
    ],
    meta: { action: "council-status" },
  });
  if (!opts.json) {
    const lines: string[] = [];
    lines.push(`council ${manifest.council_id}: ${manifest.status}`);
    lines.push(
      `  round ${manifest.current_round} ${manifest.round_status}: ${contributors.length}/${manifest.members.length} members in`,
    );
    if (contributors.length > 0) {
      lines.push(`  contributed: ${contributors.join(", ")}`);
    }
    if (pending.length > 0) {
      lines.push(`  pending: ${pending.join(", ")}`);
    }
    if (allIn && manifest.round_status === "open") {
      lines.push(
        `  (round is full but still marked 'open'; re-run any contribute to fix, or call 'council advance' to roll forward)`,
      );
    }
    emit.text(`${lines.join("\n")}\n`);
  }
}

function runCouncilAdvance(id: string, opts: { force?: boolean; json?: boolean }): void {
  if (opts.json) emit.config({ format: "json" });

  const manifest = readManifest(id) || findManifestByPartialId(id);
  if (!manifest) {
    emit.error({
      code: "council_not_found",
      message: `no council matching '${id}'`,
    });
    process.exit(1);
  }
  if (manifest.status !== "active") {
    emit.error({
      code: "council_not_active",
      message: `council ${manifest.council_id} is ${manifest.status}; cannot advance`,
    });
    process.exit(1);
  }

  const contributors = contributorsInRound(manifest.council_id, manifest.current_round);
  const pending = manifest.members.filter((m) => !contributors.includes(m));
  if (pending.length > 0 && !opts.force) {
    emit.error({
      code: "pending_contributions",
      message: `pending members in round ${manifest.current_round}: ${pending.join(", ")}. Re-run with --force to advance anyway.`,
    });
    process.exit(1);
  }

  const next = advanceCouncil(manifest, !!opts.force);
  emitCouncilStateEvent(manifest, "round_closed", manifest.round_status);
  emitCouncilStateEvent(next, "round_open", "round_closed");

  emit.data({
    rows: [
      {
        council_id: next.council_id,
        previous_round: manifest.current_round,
        new_round: next.current_round,
        forced: !!opts.force,
        dropped_members: pending,
        contributors_in_previous: contributors,
        manifest: next,
      },
    ],
    meta: { action: "council-advance" },
  });
  if (!opts.json) {
    const dropped = pending.length > 0 ? ` (dropped: ${pending.join(", ")})` : "";
    emit.text(
      `council ${next.council_id} advanced from round ${manifest.current_round} → ${next.current_round}${dropped}. Round ${next.current_round} is open.\n`,
    );
  }
}

/**
 * Shared advance helper used by both `advance` and auto-advance from
 * `contribute`. Increments current_round, flips round_status back to open,
 * creates the new round directory, writes the manifest, and pings each
 * member's journal with the advance notification.
 */
function advanceCouncil(manifest: CouncilManifest, force: boolean): CouncilManifest {
  const nextRound = manifest.current_round + 1;
  const next: CouncilManifest = {
    ...manifest,
    current_round: nextRound,
    round_status: "open",
  };
  // Create round-N+1 directory
  const rd = roundDir(manifest.council_id, nextRound);
  if (rd && !existsSync(rd)) mkdirSync(rd, { recursive: true });
  writeManifest(next);

  // Ping each member's journal with the advance notification.
  // (Convener already knows; we skip pinging them if they convened it from
  // their own session.)
  const myOwner = resolveOwner();
  const myName = myOwner ? normalizeAgentName(readCurrentCoordinationRow(myOwner)?.name ?? "") : "";
  for (const memberName of next.members) {
    if (memberName === myName) continue;
    const bareName = memberName.replace(/^agent-/, "");
    const memberOwner = resolveOwnerByName(bareName);
    if (!memberOwner) continue;
    try {
      appendEntry(
        memberOwner,
        "handoff",
        `from council advance (${manifest.council_id}): round ${nextRound} is now open${force ? " (advanced with --force; some round-N members dropped)" : ""}. Run 'harn agents council show ${manifest.council_id}' to read prior round + 'harn agents council contribute ${manifest.council_id}' to weigh in.`,
      );
    } catch {
      /* best-effort; member journal may not exist yet */
    }
  }
  return next;
}

// ──────── end council impls ────────

// Hard cap on box width. Values longer than the per-row budget word-wrap to
// continuation lines (blank key column, value resumes indented). Picked to
// stay readable in narrow terminals + chat clients while giving long
// Task values need room to breathe.
const MAX_BOX_CONTENT_WIDTH = 100;

function formatBox(title: string, rows: Array<[string, string]>): string {
  const titleStr = ` ${title} `;
  const keyWidth = Math.max(...rows.map(([k]) => k.length));

  // Per-row value budget: content_width (≤ MAX_BOX_CONTENT_WIDTH) minus
  // leading space, key + padding, two-space gap, trailing space.
  const valueBudget = Math.max(20, MAX_BOX_CONTENT_WIDTH - 1 - keyWidth - 2 - 1);

  // Expand each row into 1+ visual rows by word-wrapping long values.
  // First wrapped row keeps the key; continuations get an empty key column.
  const visualRows: Array<[string, string]> = [];
  for (const [k, v] of rows) {
    const wrapped = wrapWords(v, valueBudget);
    for (let i = 0; i < wrapped.length; i++) {
      visualRows.push([i === 0 ? k : "", wrapped[i]]);
    }
  }

  const contentWidth = Math.max(
    titleStr.length + 4,
    ...visualRows.map(([_k, v]) => 1 + keyWidth + 2 + v.length + 1),
  );
  const top = `┌─${titleStr}${"─".repeat(Math.max(0, contentWidth - titleStr.length - 2))}─┐`;
  const bottom = `└${"─".repeat(contentWidth)}┘`;
  const lines = visualRows.map(([k, v]) => {
    const padding = " ".repeat(keyWidth - k.length);
    const content = ` ${k}${padding}  ${v}`;
    const fill = " ".repeat(Math.max(0, contentWidth - content.length));
    return `│${content}${fill}│`;
  });
  return [top, ...lines, bottom].join("\n");
}

// Greedy word-wrap. Preserves single-word lines that exceed maxWidth by
// hard-breaking them (rare: overly long URLs / paths). Leaves whitespace
// runs intact except at the wrap boundary.
function wrapWords(text: string, maxWidth: number): string[] {
  if (text.length <= maxWidth) return [text];
  const lines: string[] = [];
  let current = "";
  // Split keeping whitespace so we can put it back between words.
  const tokens = text.split(/(\s+)/);
  for (const token of tokens) {
    if (token.length === 0) continue;
    if ((current + token).length <= maxWidth) {
      current += token;
      continue;
    }
    // Doesn't fit. Flush current line first.
    if (current.length > 0) {
      lines.push(current.trimEnd());
      current = "";
    }
    // If the token itself is wider than the budget (e.g. a long URL/path),
    // hard-break it across rows. Otherwise start a fresh row with it.
    if (token.length > maxWidth) {
      let rest = token;
      while (rest.length > maxWidth) {
        lines.push(rest.slice(0, maxWidth));
        rest = rest.slice(maxWidth);
      }
      current = rest;
    } else {
      current = token.trimStart();
    }
  }
  if (current.length > 0) lines.push(current.trimEnd());
  return lines.length > 0 ? lines : [text];
}
