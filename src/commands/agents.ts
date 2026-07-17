/**
 * `harn agents`: on-demand queries against the multi-agent coord layer.
 *
 *   harn agents whoami            current agent's name + instance_id + claims
 *   harn agents list              all active agents (default: fold transients)
 *   harn agents list --all        include raw kind=transient rows
 *   harn agents list --stale      include heartbeats older than the freshness window
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
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { readStreamTailBounded } from "../core/agents/events/consume.ts";
import {
  emitCanonical,
  type Heartbeat,
  monorepoRoot,
  normalizeHarness,
  readHeartbeat,
  resolveOwner,
  resolveOwnerBySessionEnv,
  resolveOwnerWithSource,
} from "../core/agents/index.ts";
import { resolveBinName } from "../core/config.ts";
import { type RemoteMachine, readRemoteMachines } from "../core/presence/index.ts";

/** Cap for CLI scans of the unbounded event ledger (`trace` / `health`). Well
 * under V8's ~512MB max string length so a `readFileSync` of the whole file can
 * never throw; covers ample recent history for a diagnostic scan. */
const STREAM_SCAN_CAP_BYTES = 128 * 1024 * 1024; // 128 MiB

import { parsePsChainLine } from "../core/hooks/resolve/anchor.ts";
import { appendEntry, resolveOwnerByName } from "../core/scratch/index.ts";
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
import {
  displayName as displayAgentName,
  ensureIdentity,
  listIdentities,
  lookupById as lookupIdentityById,
  lookupByName as lookupIdentityByName,
} from "../lib/identities/index.ts";

const FRESHNESS_SECS = 600; // 10-minute heartbeat-freshness window.

const SUBAGENT_NOTE =
  "Bash identity is process-level in v1; if you're running inside a subagent, " +
  "this resolves to the parent group's name, not the subagent's. A subagent-aware " +
  "bridge (per-shell marker file at .harnery/shells/<pid>) is out of scope.";

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

function formatPlatformLabel(platform?: string | null): string {
  if (platform === "cursor") return "Cursor";
  if (platform === "codex") return "Codex";
  return "CC";
}

interface Row {
  name: string;
  instance_id: string;
  session_id: string;
  kind: string;
  relation: "self" | "group" | "blocks" | "remote" | "unknown";
  started_at: string;
  last_heartbeat: string;
  files_touched: string[];
  last_tool?: string | null;
  last_tool_target?: string | null;
  task?: string | null;
  turn_summary?: string | null;
  turn_summary_updated_at?: string | null;
  platform?: string | null;
  /** Set on relation=remote rows: the machine label the row arrived from
   * via the cross-machine presence transport (ADR 0016). */
  machine?: string | null;
}

let emit: EmitContext;

export function registerAgentsCommand(program: Command, emitParam: EmitContext): void {
  emit = emitParam;
  const cmd = program
    .command("agents")
    .description("Query the multi-agent coordination layer (whoami / list / status / health)");

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
    .option("--stale", "Include heartbeats older than the freshness window")
    .option("--json", "JSON output (alias for --format json)")
    .action((opts: { all?: boolean; stale?: boolean; json?: boolean }) => {
      runList(opts);
    });

  cmd
    .command("status")
    .description("End-of-turn status box (name + session age + files held + peer count)")
    .option("--json", "JSON output instead of the box")
    .option(
      "--session-id <id>",
      "Lookup heartbeat by session_id directly, bypassing the ppid walk. " +
        "Use this when calling from a hook (the hook's process tree may not lead back to Claude Code's session pid). " +
        "The Stop hook payload includes session_id; pass it through.",
    )
    .action((opts: { json?: boolean; sessionId?: string }) => {
      runStatus(opts);
    });

  cmd
    .command("watch")
    .description(
      "Stream peer state changes in real time (file watcher on .harnery/active/). " +
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
      "Reconstruct one agent's coordination lifecycle from events.ndjson: " +
        "session.start → prompts → turns → tools → heals/sweeps → claims → end, " +
        "in chronological order. The answer to 'what happened to this agent / why did " +
        "it vanish?' without hand-grepping the stream. Accepts a name (agent-Foo or Foo) " +
        "or an instance_id.",
    )
    .option("--since <window>", "Only events newer than Nh|Nd (default: all)")
    .option("--limit <n>", "Show at most N most-recent events. Default: 200.", "200")
    .option("--all-tools", "Include tool.post_use + command.* (default: hidden as noise)")
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
      `Set the task on the heartbeat with this session_id directly, bypassing the ppid walk. Mirror of \`status --session-id\`: use it when the ppid walk can't resolve self (e.g. Cursor, whose shell tool calls don't descend from a pid-map-registered anchor). Discover the id via \`${resolveBinName()} agents list --json\`.`,
    )
    .action((text: string[], opts: { sessionId?: string }) => {
      runSetTask(text.join(" "), opts);
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
      "Append a 'handoff' entry to a peer agent's scratchpad. Body prefixed with " +
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
      `Block until a peer agent releases files (their \`files_touched\` becomes empty, OR they exit). Pair with \`${resolveBinName()} agents ping\` to coordinate hand-offs.`,
    )
    .option(
      "--file <path>",
      "Wait only for these specific paths (repeatable)",
      collectPath,
      [] as string[],
    )
    .option(
      "--timeout <dur>",
      "Give up after this duration; suffix s/m/h/d (e.g. 30s, 5m, 1h). Bare integer = minutes. Default 60m.",
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
      "One-screen coord-layer health rollup: heal events, schema validity, " +
        "commit-guard activity, council activity, anomalies. Designed for " +
        "daily glance + dashboard ingestion. Reads .harnery/.",
    )
    .option("--since <window>", "Window (Nh | Nd). Default: 24h.", "24h")
    .option("--json", "JSON envelope output")
    .action((opts: { since: string; json?: boolean }) => {
      runHealth(opts);
    });

  cmd
    .command("harness-probe <id>")
    .description(
      "Harness wiring probe: ppid chain, comm names, pid-map anchor, sample payload paths. " +
        "With --replay-samples, also replays every checked-in sample payload against the live " +
        "adapter in an isolated sandbox to catch adapter / payload-shape drift. " +
        "Complements heal-events (drift telemetry). Id: claude_code | cursor.",
    )
    .option("--json", "JSON envelope output")
    .option(
      "--replay-samples",
      "Replay docs/api/<harness>-hooks/samples/*.json against the live adapter in an isolated sandbox. " +
        "Exits non-zero if any sample crashes the adapter.",
    )
    .option(
      "--sample <path>",
      "Replay only the named sample file (basename match). Implies --replay-samples.",
    )
    .action((id: string, opts: { json?: boolean; replaySamples?: boolean; sample?: string }) => {
      runHarnessProbe(id, opts);
    });

  cmd
    .command("heal")
    .description(
      "Force a coord-layer recovery action on a specific agent. " +
        "Kinds: pidmap (force PIDMAP_HEAL), heartbeat (force HEARTBEAT_HEAL), " +
        "kill (rm the heartbeat file). Runs through the same heartbeat flock " +
        "the live hooks use, so it governs the operation safely.",
    )
    .requiredOption("--owner <id>", "Target agent's instance_id")
    .requiredOption("--kind <kind>", "pidmap | heartbeat | kill")
    .option(
      "--session-id <id>",
      "(--kind heartbeat) session_id to stamp on the heartbeat. " +
        "Default: inherit from existing heartbeat if one exists. " +
        "Required when no heartbeat exists yet (a heartbeat without " +
        "session_id fails schema validation and pollutes the audit trail).",
    )
    .option(
      "--pid <pid>",
      "(--kind pidmap) PID to register in pid-map. Default: walk " +
        "this shell's ppid chain for a claude process. Pass explicitly " +
        "when calling from outside Claude Code's Bash tool tree (e.g. " +
        "from cron or an external script).",
    )
    .option("--json", "JSON envelope output")
    .action(
      (opts: { owner: string; kind: string; sessionId?: string; pid?: string; json?: boolean }) => {
        runHeal(opts);
      },
    );

  registerCouncilCommands(cmd);
  registerIdentityCommands(cmd);
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
}

function registerCouncilCommands(parent: Command): void {
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
        "session-events.ndjson, which are owned by separate authors.",
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
        "scratchpads archived in the last 30 days); pass --allow-unknown " +
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
        "agent's heartbeat name (useful for cross-harness councils where each " +
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

  ensureCursorSession(root);
  const resolved = resolveOwnerWithSource();
  const myOwner = resolved.owner;
  if (!myOwner) {
    emit.error({
      code: "no_pidmap_entry",
      message: "not in an agent session; ppid walk found no pid-map entry",
    });
    process.exit(1);
  }

  const hb = readHeartbeat(myOwner);
  if (!hb) {
    emit.error({
      code: "no_heartbeat",
      message: `pid-map resolved owner=${myOwner.slice(0, 8)} but no heartbeat exists`,
    });
    process.exit(1);
  }

  const row: Row = {
    name: hb.name || "unknown",
    instance_id: hb.instance_id,
    session_id: hb.session_id,
    kind: normalizeKind(hb.kind),
    relation: "self",
    started_at: hb.started_at,
    last_heartbeat: hb.last_heartbeat,
    files_touched: hb.files_touched ?? [],
    last_tool: hb.last_tool ?? null,
    last_tool_target: hb.last_tool_target ?? null,
    task: hb.task ?? null,
    turn_summary: hb.turn_summary ?? null,
    turn_summary_updated_at: hb.turn_summary_updated_at ?? null,
    platform: hb.platform ?? "claude_code",
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

  const activeDir = resolve(root, ".harnery", "active");
  if (!existsSync(activeDir)) {
    emit.data({ rows: [], note: SUBAGENT_NOTE });
    return;
  }

  // Resolve self for relation column; best-effort, missing → "unknown" on every row.
  const myOwner = resolveOwner();
  const myHb = myOwner ? readHeartbeat(myOwner) : null;
  const mySession = myHb?.session_id ?? null;

  // Read every heartbeat.
  const heartbeats: Heartbeat[] = [];
  for (const file of readdirSync(activeDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = readFileSync(resolve(activeDir, file), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.instance_id === "string") {
        heartbeats.push(parsed as Heartbeat);
      }
    } catch {
      // skip malformed
    }
  }

  // Apply staleness filter unless --stale.
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - FRESHNESS_SECS;
  const live = opts.stale
    ? heartbeats
    : heartbeats.filter((h) => {
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
        instance_id: h.instance_id,
        session_id: h.session_id,
        kind: "transient",
        relation: relationOf(h, myOwner ?? "", mySession),
        started_at: h.started_at,
        last_heartbeat: h.last_heartbeat,
        files_touched: [...(h.files_touched ?? [])].sort(),
        last_tool: h.last_tool ?? null,
        last_tool_target: h.last_tool_target ?? null,
        task: h.task ?? null,
        turn_summary: h.turn_summary ?? null,
        turn_summary_updated_at: h.turn_summary_updated_at ?? null,
        platform: h.platform ?? "claude_code",
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
      instance_id: h.instance_id,
      session_id: h.session_id,
      kind: normalizeKind(h.kind),
      relation: relationOf(h, myOwner ?? "", mySession),
      started_at: h.started_at,
      last_heartbeat: h.last_heartbeat,
      files_touched: files,
      last_tool: h.last_tool ?? null,
      last_tool_target: h.last_tool_target ?? null,
      task: h.task ?? null,
      turn_summary: h.turn_summary ?? null,
      turn_summary_updated_at: h.turn_summary_updated_at ?? null,
      platform: h.platform ?? "claude_code",
    });
  }

  // Guard missing started_at: a heartbeat seeded from a stray event can lack it
  // (legacy zombies), and an unguarded .localeCompare throws, which is exactly
  // what made `harn agents list --all --stale` crash.
  rows.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));

  // Cross-machine presence (ADR 0016): append sessions on OTHER machines from
  // the locally-fetched presence refs. Advisory rows (relation=remote) — they
  // don't participate in local claim blocking in v1.
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
        last_tool: a.last_tool ?? null,
        last_tool_target: null,
        task: a.task ?? null,
        turn_summary: a.turn_summary ?? null,
        turn_summary_updated_at: null,
        platform: a.platform ?? "claude_code",
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
  peer: Heartbeat,
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

async function runWatch(pollMs: number): Promise<void> {
  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }
  const activeDir = resolve(root, ".harnery", "active");
  if (!existsSync(activeDir)) {
    emit.error({ code: "no_active_dir", message: ".harnery/active/ missing" });
    process.exit(1);
  }

  const fs = await import("node:fs");
  const cache = new Map<string, Heartbeat>();

  // Seed cache + print an initial roster line per live peer.
  const initial = listActiveHeartbeats(activeDir);
  process.stderr.write(`watching ${activeDir} (Ctrl-C to exit)\n`); // lint-ok-emission: banner goes to stderr, stdout is the live stream
  for (const h of initial) {
    cache.set(h.instance_id, h);
    emitWatchLine(
      `agent-${h.name ?? "?"} present (${formatAge(secondsSince(h.started_at))} old${h.task ? `, task: "${h.task}"` : ""})`,
    );
  }

  let scheduled: NodeJS.Timeout | null = null;
  const rescan = () => {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      const current = new Map<string, Heartbeat>();
      for (const h of listActiveHeartbeats(activeDir)) current.set(h.instance_id, h);

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
            `agent-${h.name ?? "?"} started (${formatAge(secondsSince(h.started_at))} old${h.task ? `, task: "${h.task}"` : ""})`,
          );
          cache.set(id, h);
          continue;
        }
        // Diff fields we care about.
        if ((prev.task ?? "") !== (h.task ?? "")) {
          emitWatchLine(`agent-${h.name ?? "?"} task: ${h.task ? `"${h.task}"` : "(cleared)"}`);
        }
        if (
          (prev.last_tool ?? "") !== (h.last_tool ?? "") ||
          (prev.last_tool_target ?? "") !== (h.last_tool_target ?? "")
        ) {
          if (h.last_tool) {
            const target = h.last_tool_target ? ` ${truncate(h.last_tool_target, 80)}` : "";
            emitWatchLine(`agent-${h.name ?? "?"} ${h.last_tool}${target}`);
          }
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
    }, pollMs);
  };

  const watcher = fs.watch(activeDir, { persistent: true }, () => rescan());

  await new Promise<void>((resolveP) => {
    const stop = () => {
      watcher.close();
      resolveP();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function listActiveHeartbeats(activeDir: string): Heartbeat[] {
  const out: Heartbeat[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - FRESHNESS_SECS;
  for (const file of readdirSync(activeDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = readFileSync(resolve(activeDir, file), "utf8");
      const parsed = JSON.parse(raw) as Heartbeat;
      if (!parsed || typeof parsed.instance_id !== "string") continue;
      const ts = Date.parse(parsed.last_heartbeat);
      if (Number.isFinite(ts) && ts / 1000 >= cutoff) out.push(parsed);
    } catch {
      // skip
    }
  }
  return out;
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
  const activeDir = resolve(root, ".harnery", "active");
  if (!existsSync(activeDir)) {
    emit.error({ code: "no_active_dir", message: ".harnery/active/ missing" });
    process.exit(1);
  }

  // Read all heartbeats; match by name (case-insensitive). Apply freshness filter.
  const matches: Heartbeat[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - FRESHNESS_SECS;
  for (const file of readdirSync(activeDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = readFileSync(resolve(activeDir, file), "utf8");
      const parsed = JSON.parse(raw) as Heartbeat;
      if (!parsed || typeof parsed.instance_id !== "string") continue;
      if ((parsed.name ?? "").toLowerCase() !== name.toLowerCase()) continue;
      const ts = Date.parse(parsed.last_heartbeat);
      if (Number.isFinite(ts) && ts / 1000 >= cutoff) matches.push(parsed);
    } catch {
      // skip malformed
    }
  }

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

  const startedAtMs = Date.parse(hb.started_at);
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
    turn_summary: hb.turn_summary ?? null,
    turn_summary_updated_at: hb.turn_summary_updated_at ?? null,
    title: report?.title ?? null,
    files_held: hb.files_touched ?? [],
    last_tool: hb.last_tool ?? null,
    last_tool_target: hb.last_tool_target ?? null,
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
  if (data.last_tool) {
    const target = data.last_tool_target ? ` ${truncate(data.last_tool_target, 80)}` : "";
    lines.push(`  last activity:  ${data.last_tool}${target}`);
  }
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

function shouldBootstrapCursorSession(): boolean {
  return process.env.CURSOR_AGENT === "1" && cursorEnvSessionId() !== null;
}

function ensureCursorSession(root: string): void {
  if (!shouldBootstrapCursorSession()) return;
  if (resolveOwnerBySessionEnv(root)) return;

  const sessionId = cursorEnvSessionId();
  if (!sessionId) return;
  const agentHook = resolve(root, "harnery", "bin", "agent-hook");
  if (!existsSync(agentHook)) return;

  const payload = JSON.stringify({
    conversation_id: sessionId,
    session_id: sessionId,
    hook_event_name: "sessionStart",
    workspace_roots: [root],
    cwd: root,
    composer_mode: "agent",
    is_background_agent: false,
  });

  spawnSync("bash", [agentHook, "session-start", "--harness", "cursor"], {
    input: payload,
    cwd: root,
    encoding: "utf8",
    timeout: 3000,
    env: {
      ...process.env,
      HARNERY_AGENT_COORD_PLATFORM: "cursor",
      HARNERY_COORD_ROOT_OVERRIDE: root,
      CURSOR_SESSION_ID: sessionId,
      CURSOR_CONVERSATION_ID: sessionId,
    },
  });
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
    emit.error({
      code: "no_pidmap_entry",
      message: "not in an agent session; ppid walk found no pid-map entry",
    });
    process.exit(1);
  }
  // Canonicalize: absolute paths under coordRoot get the prefix stripped;
  // relative paths pass through unchanged.
  let canonical = path;
  if (path.startsWith(`${root}/`)) canonical = path.slice(root.length + 1);

  const helper = resolve(root, "harnery", "bin", "agent-coord");
  const result = spawnSync(helper, ["release-claim", myOwner, canonical], {
    encoding: "utf8",
    ...coordHelperOpts(root),
  });
  if (result.status !== 0) {
    emit.error({
      code: "release_claim_failed",
      message: result.stderr.trim() || `agent-coord exited ${result.status}`,
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
  if (!opts?.sessionId) ensureCursorSession(root);
  const myOwner = opts?.sessionId ?? resolveOwner();
  if (!myOwner) {
    emit.error({
      code: "no_pidmap_entry",
      message:
        "not in an agent session; ppid walk found no pid-map entry (pass --session-id to bypass)",
    });
    process.exit(1);
  }

  // Heartbeat mutation goes through agent-coord (atomic temp+rename).
  const helper = resolve(root, "harnery", "bin", "agent-coord");
  const result = spawnSync(helper, ["set-task", myOwner, task], {
    encoding: "utf8",
    ...coordHelperOpts(root),
  });
  if (result.status !== 0) {
    emit.error({
      code: "set_task_failed",
      message: result.stderr.trim() || `agent-coord exited ${result.status}`,
    });
    process.exit(1);
  }

  const hb = readHeartbeat(myOwner);
  emitCanonical({
    type: "state.task_set",
    owner: myOwner,
    session: hb?.session_id ?? myOwner,
    harness: normalizeHarness(hb?.platform),
    data: { task, cleared: !task || task.length === 0 },
  });

  emit.data({
    instance_id: myOwner,
    name: hb?.name ?? null,
    task: hb?.task ?? null,
    cleared: !task || task.length === 0,
  });
}

function runStatus(opts: { json?: boolean; sessionId?: string }): void {
  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "not_in_repo",
      message: "not in an agent session; coord_root() returned null",
    });
    process.exit(1);
  }

  // Identity resolution: prefer explicit --session-id (hook-friendly), fall
  // back to ppid walk for interactive shell usage.
  if (!opts.sessionId) ensureCursorSession(root);
  const myOwner = opts.sessionId ?? resolveOwner();
  if (!myOwner) {
    emit.error({
      code: "no_pidmap_entry",
      message:
        "not in an agent session; ppid walk found no pid-map entry (pass --session-id from a hook payload)",
    });
    process.exit(1);
  }

  const hb = readHeartbeat(myOwner);
  if (!hb) {
    emit.error({
      code: "no_heartbeat",
      message: `pid-map resolved owner=${myOwner.slice(0, 8)} but no heartbeat exists`,
    });
    process.exit(1);
  }

  // Stamp .last_status_at = NOW. The verdict path reads state.status_checked
  // canonical events (emitted below), but the legacy heartbeat field is still
  // populated for back-compat with consumers reading v1 directly. The stamp
  // goes through agent-coord (atomic write).
  try {
    const helper = resolve(root, "harnery", "bin", "agent-coord");
    spawnSync(helper, ["stamp-status-call", myOwner], {
      encoding: "utf8",
      timeout: 2000,
      ...coordHelperOpts(root),
    });
  } catch {
    /* non-fatal */
  }
  emitCanonical({
    type: "state.status_checked",
    owner: myOwner,
    session: hb.session_id ?? myOwner,
    harness: normalizeHarness(hb.platform),
    data: {
      format: opts.json ? "json" : "box",
      agent_count: 0, // computed below, not yet available here; Phase 5 verdict reads owner-scope only
      included_self: true,
    },
  });

  const startedAtMs = Date.parse(hb.started_at);
  const ageSecs = Number.isFinite(startedAtMs)
    ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
    : 0;

  const activeDir = resolve(root, ".harnery", "active");
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - FRESHNESS_SECS;
  const livePeers: Heartbeat[] = [];
  let peersStale = 0;
  if (existsSync(activeDir)) {
    for (const file of readdirSync(activeDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileSync(resolve(activeDir, file), "utf8");
        const peer = JSON.parse(raw) as Heartbeat;
        if (!peer || typeof peer.instance_id !== "string") continue;
        if (peer.instance_id === myOwner) continue;
        const ts = Date.parse(peer.last_heartbeat);
        if (Number.isFinite(ts) && ts / 1000 >= cutoff) {
          livePeers.push(peer);
        } else {
          peersStale++;
        }
      } catch {
        // skip malformed
      }
    }
  }

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

  const ctxUsage = readContextUsage(hb.session_id, hb.platform);
  let ctxStr: string;
  if (!ctxUsage) {
    ctxStr = "unavailable";
  } else if (ctxUsage.percentOnly) {
    // Cursor reports percent only; absolutes are estimates against a hard-coded
    // window. Show the percent + window estimate, marked as estimated.
    const pct = Math.round((ctxUsage.used / ctxUsage.window) * 100);
    ctxStr = `~${pct}% (Cursor; ${fmtTokens(ctxUsage.window)} window est.)`;
  } else {
    ctxStr = `${fmtTokens(ctxUsage.used)} / ${fmtTokens(ctxUsage.window)} (${Math.round(
      (ctxUsage.used / ctxUsage.window) * 100,
    )}%)`;
  }

  const timeStr = formatLocalTime(new Date());
  const displayName = `agent-${hb.name || "unknown"}`;

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
        files: a.files_touched?.length ?? 0,
      })),
    })),
    pending_councils: pendingCouncils,
    context_used: ctxUsage?.used ?? null,
    context_window: ctxUsage?.window ?? null,
    timestamp_iso: new Date().toISOString(),
    timestamp_local: timeStr,
  };

  if (opts.json) {
    emit.config({ format: "json" });
    emit.data(data);
    return;
  }

  const rows: Array<[string, string]> = [
    ["session", formatAge(ageSecs)],
    ["context", ctxStr],
    ["files", filesStr],
    ["peers", peersStr],
    ["time", timeStr],
  ];
  // task + turn_summary get full text; formatBox word-wraps to MAX_BOX_CONTENT_WIDTH.
  if (hb.turn_summary && hb.turn_summary.length > 0) {
    rows.splice(1, 0, ["last turn", hb.turn_summary]);
  }
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
  // Box rendering needs predictable stdout regardless of TTY/pipe detection:
  // agent runs this via Bash (no TTY) and pastes captured stdout into chat.
  process.stdout.write(`${formatBox(displayName, rows)}\n`); // lint-ok-emission: chat-paste path; emit.text() auto-suppresses non-TTY
}

function formatList(items: string[], cap: number, emptyLabel: string): string {
  if (items.length === 0) return emptyLabel;
  if (items.length <= cap) return items.join(", ");
  const shown = items.slice(0, cap).join(", ");
  return `${shown}, +${items.length - cap} more`;
}

function formatPeers(
  peers: Heartbeat[],
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

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1000000) return `${Math.round(n / 1000)}K`;
  const m = n / 1000000;
  return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
}

function readContextUsage(
  sessionId: string,
  platform?: string | null,
): { used: number; window: number; percentOnly?: boolean } | null {
  if (!sessionId) return null;
  // Dispatch by platform: Codex's JSONL shape is different from Claude Code's
  // (event_msg/response_item vs user/assistant), and Codex transcripts live
  // under ~/.codex/sessions/YYYY/MM/DD/ rather than ~/.claude/projects/.
  // Cursor doesn't surface token counts in its transcript JSONL but DOES
  // store `contextUsagePercent` per composer in workspaceStorage's state.vscdb;
  // readCursorContextUsage reads that via bun:sqlite (percent-only).
  if (platform === "codex") return readCodexContextUsage(sessionId);
  if (platform === "cursor") return readCursorContextUsage(sessionId);
  return readClaudeContextUsage(sessionId);
}

function readCursorContextUsage(
  sessionId: string,
): { used: number; window: number; percentOnly: true } | null {
  // Cursor stores per-chat (composer) context usage as a percent in each
  // workspace's state.vscdb at ItemTable.composer.composerData. The value
  // is a JSON blob with .allComposers[].contextUsagePercent. We find the
  // composer matching the agent's session_id (Cursor uses session_id == composerId
  // for parent chats).
  //
  // Roots searched: ~/.config/Cursor/User/workspaceStorage (Linux native install)
  // and /mnt/c/Users/*/AppData/Roaming/Cursor/User/workspaceStorage (WSL).
  // We don't filter by workspace path; we scan every workspace's state.vscdb
  // looking for a composerId match. Cheap enough at status time (~60K per file,
  // <10ms typical). When a match is found, returns synthetic { used, window }
  // pair where the percent is what's real; absolutes are derived as
  // (window * percent / 100). Window hard-coded to a Cursor-typical 200K.
  const roots: string[] = [];
  const linuxRoot = resolve(homedir(), ".config", "Cursor", "User", "workspaceStorage");
  if (existsSync(linuxRoot)) roots.push(linuxRoot);
  try {
    if (existsSync("/mnt/c/Users")) {
      for (const u of readdirSync("/mnt/c/Users")) {
        const p = `/mnt/c/Users/${u}/AppData/Roaming/Cursor/User/workspaceStorage`;
        if (existsSync(p)) roots.push(p);
      }
    }
  } catch {
    // ignore
  }
  for (const root of roots) {
    let workspaces: string[];
    try {
      workspaces = readdirSync(root);
    } catch {
      continue;
    }
    for (const ws of workspaces) {
      const dbPath = `${root}/${ws}/state.vscdb`;
      if (!existsSync(dbPath)) continue;
      try {
        // Lazy-import bun:sqlite so non-Bun runtimes (if any) don't choke at load.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Database } = require("bun:sqlite");
        const db = new Database(dbPath, { readonly: true });
        const row = db
          .query("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
          .get() as { value: string | Uint8Array } | null;
        db.close();
        if (!row?.value) continue;
        const text =
          typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
        const parsed = JSON.parse(text);
        const composers = Array.isArray(parsed?.allComposers) ? parsed.allComposers : [];
        for (const c of composers) {
          if (c?.composerId === sessionId && typeof c?.contextUsagePercent === "number") {
            const window = 200000; // hard-coded Cursor-typical window; refine when Cursor exposes the actual ceiling
            const used = Math.round((window * c.contextUsagePercent) / 100);
            return { used, window, percentOnly: true };
          }
        }
      } catch {
        // ignore: DB locked, schema drift, etc. Move on to the next workspace.
      }
    }
  }
  return null;
}

function readClaudeContextUsage(sessionId: string): { used: number; window: number } | null {
  const root = monorepoRoot();
  if (!root) return null;
  // Claude Code's project dir scheme: prepend "-", replace "/" → "-".
  const encoded = `-${root.replace(/^\//, "").replace(/\//g, "-")}`;
  const transcriptPath = resolve(homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`);
  if (!existsSync(transcriptPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      const usage = entry?.message?.usage;
      if (entry?.type === "assistant" && usage) {
        const used =
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0);
        // Window: hardcode 1M for Opus 4.7 1M (current default). Refine to
        // model-aware lookup when other models become routine.
        return { used, window: 1000000 };
      }
    } catch {
      // skip malformed line
    }
  }
  return null;
}

function readCodexContextUsage(sessionId: string): { used: number; window: number } | null {
  // Codex transcripts: ~/.codex/sessions/YYYY/MM/DD/rollout-<TS>-<sessionId>.jsonl
  // On WSL the active install often lives on the Windows side under
  // /mnt/c/Users/<user>/.codex/sessions/; both are searched.
  const path = findCodexTranscript(sessionId);
  if (!path) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  // Walk backwards: most recent token_count event wins.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "event_msg" && entry?.payload?.type === "token_count") {
        const info = entry.payload.info;
        const used = info?.last_token_usage?.input_tokens;
        const window = info?.model_context_window;
        if (typeof used === "number" && typeof window === "number" && window > 0) {
          return { used, window };
        }
      }
    } catch {
      // skip malformed line
    }
  }
  return null;
}

function findCodexTranscript(sessionId: string): string | null {
  // Candidate roots in priority order.
  const homeRoot = resolve(homedir(), ".codex", "sessions");
  const wslRoots: string[] = [];
  try {
    if (existsSync("/mnt/c/Users")) {
      for (const entry of readdirSync("/mnt/c/Users")) {
        wslRoots.push(`/mnt/c/Users/${entry}/.codex/sessions`);
      }
    }
  } catch {
    // ignore
  }
  const roots = [homeRoot, ...wslRoots];
  const suffix = `-${sessionId}.jsonl`;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      // Recursive scan: sessions are partitioned by YYYY/MM/DD/, so depth
      // is bounded at 3 + one file per session. Cheap enough at status time.
      const stack: string[] = [root];
      while (stack.length) {
        const dir = stack.pop()!;
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          const full = `${dir}/${name}`;
          try {
            const stat = statSync(full);
            if (stat.isDirectory()) {
              stack.push(full);
            } else if (name.endsWith(suffix)) {
              return full;
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore root scan failures
    }
  }
  return null;
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

/**
 * One canonical event envelope from `.harnery/events.ndjson` (loose shape: we
 * only read the fields the health/heal aggregators need).
 */
interface CanonicalEvent {
  event_type: string;
  ts: string;
  instance_id?: string;
  harness?: string;
  data?: Record<string, unknown>;
}

/**
 * Read canonical events in a time window. The heal + council telemetry the
 * health/heal commands report lives here. Full-file read + ts filter is fine
 * for an on-demand diagnostic; events.ndjson is the canonical store.
 */
function readCanonicalEventsInWindow(root: string, cutoffMs: number): CanonicalEvent[] {
  const p = resolve(root, ".harnery", "events.ndjson");
  if (!existsSync(p)) return [];
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const out: CanonicalEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line) as CanonicalEvent;
      if (!ev.event_type || !ev.ts) continue;
      const tsMs = Date.parse(ev.ts);
      if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
      out.push(ev);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** harness ("claude-code") → legacy platform label ("claude_code") so the
 * existing formatPlatformLabel rendering keeps working unchanged. */
function harnessToPlatform(harness: string | undefined): string {
  if (harness === "claude-code") return "claude_code";
  if (harness === "cursor") return "cursor";
  if (harness === "codex") return "codex";
  return "claude_code";
}

/** Project a canonical health.* event into the HealEvent shape the aggregators
 * already consume. Returns null for non-heal events. instance_id → display name
 * via `nameById` (full-UUID keyed). */
function canonicalToHealEvent(ev: CanonicalEvent, nameById: Map<string, string>): HealEvent | null {
  if (ev.event_type !== "health.pidmap_heal" && ev.event_type !== "health.heartbeat_heal") {
    return null;
  }
  const kind = ev.event_type === "health.pidmap_heal" ? "pidmap" : "heartbeat";
  const data = ev.data ?? {};
  const reason: "missing" | "stale" = data.reason === "stale" ? "stale" : "missing";
  const instanceId = ev.instance_id ?? "";
  const name = nameById.get(instanceId);
  const agent = name ? `agent-${name}` : `agent-${instanceId.slice(0, 8) || "unknown"}`;
  const out: HealEvent = {
    ts: ev.ts,
    agent,
    kind,
    reason,
    platform: harnessToPlatform(ev.harness),
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

  // Heal telemetry lives in the canonical .harnery/events.ndjson stream
  // (health.pidmap_heal / health.heartbeat_heal), emitted by the writer on
  // actual self-heal writes.
  const cutoffMs = Date.now() - sinceSecs * 1000;
  const nameById = buildNameById(root);
  const events: HealEvent[] = [];
  for (const ev of readCanonicalEventsInWindow(root, cutoffMs)) {
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
    emit.data(recent);
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
  active_agents: {
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
  schema_invalid: { count: number; samples: string[] };
  commit_guards: {
    blocked: number;
    bypassed: number;
    suppressed: number;
    edit_blocked: number;
    shell_candidates: number;
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
    by_phase: Record<string, number>;
    top: Array<{ phase: string; count: number; sample: string }>;
  };
  // Canonical event stream growth + drain lag.
  stream: {
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
  anomalies: string[];
}

/** Tally agent-hook failures (.harnery/debug/agent-hook.errors.ndjson) in the
 * window, grouped by `phase`. Each line is {ts, error, phase, ...}. A dominant
 * phase points straight at a systemic hook bug. */
function readHookErrors(
  root: string,
  cutoffMs: number,
): {
  total: number;
  byPhase: Record<string, number>;
  top: Array<{ phase: string; count: number; sample: string }>;
} {
  const p = resolve(root, ".harnery", "debug", "agent-hook.errors.ndjson");
  const byPhase: Record<string, number> = {};
  const sampleByPhase: Record<string, string> = {};
  let total = 0;
  if (!existsSync(p)) return { total: 0, byPhase, top: [] };
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return { total: 0, byPhase, top: [] };
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { ts?: string; phase?: string; error?: string };
      const tsMs = e.ts ? Date.parse(e.ts) : Number.NaN;
      if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
      const phase = e.phase ?? "(unknown)";
      byPhase[phase] = (byPhase[phase] ?? 0) + 1;
      if (!sampleByPhase[phase] && e.error) sampleByPhase[phase] = e.error;
      total++;
    } catch {
      /* skip malformed */
    }
  }
  const top = Object.entries(byPhase)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phase, count]) => ({ phase, count, sample: sampleByPhase[phase] ?? "" }));
  return { total, byPhase, top };
}

/** Canonical event stream size + drain lag (events appended after the cursor). */
function readStreamStats(root: string): { bytes: number; lines: number; cursor_backlog: number } {
  const streamPath = resolve(root, ".harnery", "events.ndjson");
  if (!existsSync(streamPath)) return { bytes: 0, lines: 0, cursor_backlog: 0 };
  let bytes = 0;
  try {
    bytes = statSync(streamPath).size;
  } catch {
    /* ignore */
  }
  let cursor: string | null = null;
  const cursorPath = resolve(root, ".harnery", ".events-cursor");
  if (existsSync(cursorPath)) {
    try {
      cursor = readFileSync(cursorPath, "utf8").trim() || null;
    } catch {
      /* ignore */
    }
  }
  let lines = 0;
  let backlog = 0;
  let seenCursor = cursor === null; // no cursor → everything is "backlog"
  try {
    // Bounded tail read: the ledger grows without bound and a whole-file
    // readFileSync throws past V8's ~512MB string limit. lines/backlog are then
    // scoped to the scanned window; `bytes` (full size, via statSync above) still
    // reflects the true stream size for the health rollup.
    const { text } = readStreamTailBounded(streamPath, STREAM_SCAN_CAP_BYTES);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      lines++;
      if (seenCursor) {
        backlog++;
      } else if (cursor && line.includes(`"event_id":"${cursor}"`)) {
        seenCursor = true;
      }
    }
  } catch {
    /* ignore */
  }
  return { bytes, lines, cursor_backlog: backlog };
}

/** One rendered line in a trace. */
interface TraceEntry {
  ts: string;
  event_type: string;
  detail: string;
}

/** Map a canonical event to a concise trace line, or null to drop it. */
function traceLine(ev: CanonicalEvent, allTools: boolean): TraceEntry | null {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof d[k] === "string" ? (d[k] as string) : "");
  const clip = (v: string, n = 70): string => (v.length <= n ? v : `${v.slice(0, n - 1)}…`);
  let detail = "";
  switch (ev.event_type) {
    case "session.start":
      detail = `${s("source") || "startup"}${s("model") ? ` · model=${s("model")}` : ""}${s("name") ? ` · ${s("name")}` : ""}`;
      break;
    case "session.end":
      detail = `clean_exit=${d.clean_exit ?? "?"}`;
      break;
    case "subagent.start":
      detail = `${s("agent_type") || "subagent"}${s("name") ? ` · ${s("name")}` : ""}`;
      break;
    case "subagent.stop":
      detail = `clean_exit=${d.clean_exit ?? "?"}`;
      break;
    case "user_prompt.submit":
      detail = clip(s("prompt_text") || s("prompt"));
      break;
    case "turn.stop":
      detail = `status_box=${d.status_box_present ?? "?"}${s("turn_summary") ? ` · ${clip(s("turn_summary"), 50)}` : ""}`;
      break;
    case "tool.pre_use":
      detail = `${s("tool_name")}${s("tool_target") || s("intent") ? ` · ${clip(s("tool_target") || s("intent"), 60)}` : ""}`;
      break;
    case "state.task_set":
      detail = d.cleared ? "(cleared)" : clip(s("task"));
      break;
    case "state.status_checked":
      detail = "status box rendered";
      break;
    case "claim.acquire":
    case "claim.release":
    case "claim.conflict":
      detail = clip(s("path"));
      break;
    case "health.heartbeat_heal":
    case "health.pidmap_heal":
      detail = `reason=${s("reason")}`;
      break;
    case "health.heartbeat_swept":
      detail = `reason=${s("reason")}${d.age_secs !== undefined ? ` · age=${d.age_secs}s` : ""}`;
      break;
    default:
      // Noise unless --all-tools: per-line command.* + tool.post_use.
      if (!allTools) return null;
      if (
        ev.event_type === "tool.post_use" ||
        ev.event_type === "tool.post_use_failure" ||
        ev.event_type.startsWith("command.")
      ) {
        detail = s("tool_name") || "";
        break;
      }
      return null;
  }
  return { ts: ev.ts, event_type: ev.event_type, detail };
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
    else if (/^[0-9a-f-]{8,}$/i.test(wanted)) targetId = wanted; // looks like an id not in history
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
  const candidateIds = targetId.includes("\x00") ? targetId.split("\x00") : [targetId];

  // Scan the stream tail once, bucket events by instance_id for the candidates.
  // Bounded read: the ledger grows without bound and a whole-file readFileSync
  // throws past V8's ~512MB string limit. A trace of an agent whose events all
  // predate the window is reported as truncated rather than crashing.
  const streamPath = resolve(root, ".harnery", "events.ndjson");
  const byId = new Map<string, CanonicalEvent[]>();
  const { text: streamText, truncated: streamTruncated } = readStreamTailBounded(
    streamPath,
    STREAM_SCAN_CAP_BYTES,
  );
  for (const line of streamText.split("\n")) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line) as CanonicalEvent;
      if (!ev.instance_id || !candidateIds.includes(ev.instance_id)) continue;
      if (sinceMs && Date.parse(ev.ts) < sinceMs) continue;
      const arr = byId.get(ev.instance_id) ?? [];
      arr.push(ev);
      byId.set(ev.instance_id, arr);
    } catch {
      /* skip */
    }
  }
  if (streamTruncated) {
    process.stderr.write(
      `note: event ledger exceeds ${Math.round(STREAM_SCAN_CAP_BYTES / 1024 / 1024)}MB; traced only the most recent window (older events omitted)\n`,
    );
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
  const lines = events
    .map((ev) => traceLine(ev, !!opts.allTools))
    .filter((l): l is TraceEntry => l !== null)
    // Sort by timestamp, not file order: codex replays events (original ts,
    // appended later), so append-order ≠ chronological order.
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const shown = lines.slice(-limit);
  const displayName = nameById.get(resolvedId) ?? resolvedId.slice(0, 8);

  const result = {
    name: displayName,
    instance_id: resolvedId,
    other_instances: candidateIds.filter((id) => id !== resolvedId),
    total_events: events.length,
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
  if (shown.length === 0) {
    process.stdout.write("  (no events)\n"); // lint-ok-emission: human trace view
    return;
  }
  for (const l of shown) {
    const t = formatLocalTime(new Date(l.ts)).replace(/^[A-Za-z]{3}, /, ""); // drop weekday for density
    process.stdout.write(`  ${t}  ${l.event_type.padEnd(22)} ${l.detail}\n`); // lint-ok-emission: human trace view
  }
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

  const cutoffMs = Date.now() - sinceSecs * 1000;
  const activeDir = resolve(root, ".harnery/active");
  const councilsDir = resolve(root, ".harnery/councils");

  // Coordination telemetry reads from the canonical events.ndjson stream.
  // Heals come from health.*; council window-activity from council.*. The
  // commit-guard + schema-invalid counters below have NO canonical equivalent
  // yet. Their future home is the decision.* events (defined in schema.ts, not
  // yet wired). Until then they report 0 (fields kept for output-shape
  // compatibility).
  const heal: HealEvent[] = [];
  const schemaInvalid = 0;
  const schemaSamples: string[] = [];
  const commitBlocked = 0;
  const commitBypassed = 0;
  const commitSuppressed = 0;
  const editBlocked = 0;
  const shellCandidates = 0;
  let councilAdvanced = 0;
  let councilClosed = 0;
  let councilArchived = 0;
  let sweptTotal = 0;
  const sweptByReason: Record<string, number> = {};

  const nameById = buildNameById(root);
  for (const ev of readCanonicalEventsInWindow(root, cutoffMs)) {
    const healEv = canonicalToHealEvent(ev, nameById);
    if (healEv) {
      heal.push(healEv);
      continue;
    }
    switch (ev.event_type) {
      case "council.round_open":
        councilAdvanced++;
        break;
      case "council.close":
        councilClosed++;
        break;
      case "council.archive":
        councilArchived++;
        break;
      case "health.heartbeat_swept": {
        sweptTotal++;
        const reason = String((ev.data as { reason?: unknown })?.reason ?? "unknown");
        sweptByReason[reason] = (sweptByReason[reason] ?? 0) + 1;
        break;
      }
    }
  }

  const hookErrors = readHookErrors(root, cutoffMs);
  const stream = readStreamStats(root);

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

  // Active heartbeats: scan ALL files in active/, classify fresh vs stale ourselves.
  const activeByPlatform: Record<string, number> = {};
  const activeByKind: Record<string, number> = {};
  const activeBySchema: Record<string, number> = {};
  let activeTotal = 0;
  let staleHeartbeats = 0;
  // Zombies: files in active/ that are broken: unparseable, nameless, or an
  // absurd (epoch-ish) last_heartbeat. These show as `agent-unknown` ghosts and
  // mean dead files the sweep isn't reaping.
  let zombieCount = 0;
  const zombieSamples: string[] = [];
  const ABSURD_AGE_MS = 24 * 60 * 60 * 1000; // > 1 day = clearly not a live, self-healing agent
  const nowMs = Date.now();
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
      activeTotal++;
      const platform = formatPlatformLabel(hb.platform);
      activeByPlatform[platform] = (activeByPlatform[platform] ?? 0) + 1;
      const kind = hb.kind ?? "unknown";
      activeByKind[kind] = (activeByKind[kind] ?? 0) + 1;
      const sv = (hb as { schema_version?: number }).schema_version;
      const schemaKey = sv === undefined ? "v0" : `v${sv}`;
      activeBySchema[schemaKey] = (activeBySchema[schemaKey] ?? 0) + 1;
      const lastHbMs = hb.last_heartbeat ? Date.parse(hb.last_heartbeat) : Number.NaN;
      const ageMs = Number.isFinite(lastHbMs) ? nowMs - lastHbMs : Number.POSITIVE_INFINITY;
      if (ageMs > FRESHNESS_SECS * 1000) staleHeartbeats++;
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
  if (schemaInvalid > 0) {
    const sampleList = schemaSamples.slice(0, 3).join(", ");
    anomalies.push(
      `HEARTBEAT_SCHEMA_INVALID fired ${schemaInvalid}x; heartbeat shape failed validation${sampleList ? ` (samples: ${sampleList})` : ""}`,
    );
  }
  for (const { agent, count } of healTopAgents) {
    if (count >= 5) {
      anomalies.push(
        `${agent} self-healed ${count}x in ${opts.since}; possible idle-prune loop or PID instability`,
      );
    }
  }
  if (staleHeartbeats > 0) {
    anomalies.push(
      `${staleHeartbeats} active heartbeat(s) older than ${Math.floor(FRESHNESS_SECS / 60)}min; heal mechanism may not be firing`,
    );
  }
  const unexpectedSchemas = Object.keys(activeBySchema).filter((k) => k !== "v1");
  if (unexpectedSchemas.length > 0) {
    anomalies.push(
      `Unexpected heartbeat schema versions in use: ${unexpectedSchemas.join(", ")} (expected v1)`,
    );
  }
  // agent-hook failures: a dominant phase is the fastest pointer to a systemic
  // hook bug (this is the signal that would have surfaced the stop-projection
  // crash immediately instead of after an hour of log-grepping).
  if (hookErrors.total > 0) {
    const top = hookErrors.top[0];
    const detail = top
      ? `: top phase '${top.phase}' x${top.count}${top.sample ? ` (${top.sample.slice(0, 80)})` : ""}`
      : "";
    anomalies.push(`agent-hook errored ${hookErrors.total}x in ${opts.since}${detail}`);
  }
  if (stream.cursor_backlog > 500) {
    anomalies.push(
      `projection cursor is ${stream.cursor_backlog} events behind; drain lagging (stop projection may be failing)`,
    );
  }
  // NB: raw stream size is NOT an anomaly. events.ndjson is a deliberate
  // append-only ledger (names + forensics for the life of the log), and
  // consumeSince tail-reads it, so size no longer drives latency. The
  // bytes/lines still surface in the summary line for visibility;
  // cursor_backlog above is the real drain-lag signal.
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

  const report: HealthReport = {
    since: opts.since,
    generated_at: new Date().toISOString(),
    active_agents: {
      total: activeTotal,
      by_platform: activeByPlatform,
      by_kind: activeByKind,
      by_schema_version: activeBySchema,
      stale: staleHeartbeats,
    },
    heal_events: {
      total: heal.length,
      by_kind: { pidmap: healByKind.pidmap, heartbeat: healByKind.heartbeat },
      by_reason: { missing: healByReason.missing, stale: healByReason.stale },
      by_platform: healByPlatform,
      top_agents: healTopAgents,
    },
    schema_invalid: { count: schemaInvalid, samples: schemaSamples },
    commit_guards: {
      blocked: commitBlocked,
      bypassed: commitBypassed,
      suppressed: commitSuppressed,
      edit_blocked: editBlocked,
      shell_candidates: shellCandidates,
    },
    councils: {
      active: activeCouncils,
      archived_in_window: councilArchived,
      advanced_in_window: councilAdvanced,
      closed_in_window: councilClosed,
    },
    swept_events: { total: sweptTotal, by_reason: sweptByReason },
    hook_errors: { total: hookErrors.total, by_phase: hookErrors.byPhase, top: hookErrors.top },
    stream,
    zombies: { count: zombieCount, samples: zombieSamples },
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

  const guardParts: string[] = [];
  if (report.commit_guards.blocked > 0) guardParts.push(`blocked ${report.commit_guards.blocked}`);
  if (report.commit_guards.bypassed > 0)
    guardParts.push(`bypassed ${report.commit_guards.bypassed}`);
  if (report.commit_guards.suppressed > 0)
    guardParts.push(`suppressed ${report.commit_guards.suppressed}`);
  if (report.commit_guards.edit_blocked > 0)
    guardParts.push(`edit-blocked ${report.commit_guards.edit_blocked}`);
  if (report.commit_guards.shell_candidates > 0)
    guardParts.push(`shell ${report.commit_guards.shell_candidates}`);

  const councilParts: string[] = [`${report.councils.active} active`];
  if (report.councils.advanced_in_window > 0)
    councilParts.push(`${report.councils.advanced_in_window} advanced`);
  if (report.councils.closed_in_window > 0)
    councilParts.push(`${report.councils.closed_in_window} closed`);
  if (report.councils.archived_in_window > 0)
    councilParts.push(`${report.councils.archived_in_window} archived`);

  const activeStr = `${report.active_agents.total}${platforms ? ` (${platforms})` : ""}${schemas ? ` · ${schemas}` : ""}${report.active_agents.stale > 0 ? ` · ${report.active_agents.stale} stale` : ""}`;

  const sweptReasonStr = Object.entries(report.swept_events.by_reason)
    .map(([r, n]) => `${r} ${n}`)
    .join(", ");
  const hookErrStr =
    report.hook_errors.total === 0
      ? "0"
      : `${report.hook_errors.total}${report.hook_errors.top[0] ? ` (${report.hook_errors.top[0].phase} x${report.hook_errors.top[0].count})` : ""}`;
  const streamStr = `${(report.stream.bytes / 1048576).toFixed(1)}MB · ${report.stream.lines} lines · ${report.stream.cursor_backlog} behind`;

  const rows: Array<[string, string]> = [
    ["window", `last ${report.since}`],
    ["active", activeStr],
    [
      "heals",
      `${report.heal_events.total}${healSubparts.length ? ` (${healSubparts.join(", ")})` : ""}`,
    ],
    ["top healer", topHealerStr],
    ["swept", `${report.swept_events.total}${sweptReasonStr ? ` (${sweptReasonStr})` : ""}`],
    ["hook errors", hookErrStr],
    ["stream", streamStr],
    [
      "zombies",
      report.zombies.count === 0
        ? "0"
        : `${report.zombies.count} (${report.zombies.samples.join(", ")})`,
    ],
    ["schema invalid", String(report.schema_invalid.count)],
    ["commit guards", guardParts.length ? guardParts.join(", ") : "0"],
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

function runHarnessProbe(
  id: string,
  opts: { json?: boolean; replaySamples?: boolean; sample?: string },
): void {
  if (opts.json) emit.config({ format: "json" });

  const harness = id.trim();
  if (harness !== "claude_code" && harness !== "cursor") {
    emit.error({
      code: "bad_harness",
      message: "harness id must be claude_code or cursor",
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
    harness === "cursor" ? ".harnery/.cursor-subagent-map" : `.harnery/.subagent-map/${harness}`;
  const sampleDir =
    harness === "cursor" ? "docs/api/cursor-hooks/samples" : "docs/api/claude-code-hooks/samples";
  const dispatchEntry =
    harness === "cursor"
      ? "harnery/bin/agent-hook session-start --harness cursor"
      : "harnery/bin/agent-hook session-start --harness claude-code";

  // TS-native probe. The owner + anchor-pid resolution it reports lives in
  // `findHarnessAnchorPid` (core/hooks/cli.ts, the /proc walk mirrored below)
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
    harness,
    anchor_pid: anchorPid,
    hook_pid: String(process.pid),
    resolved_owner: resolveOwner() ?? "",
    ppid_chain: `${chainParts.join(" ")} `,
    subagent_map_dir: subagentDir,
    sample_ref: sampleDir,
    dispatch_entry: dispatchEntry,
    note: "heal-events counts drift; harness-probe answers wiring",
  };

  const wantReplay = opts.replaySamples || !!opts.sample;
  let samples: SampleReplayResult[] = [];
  let replayExitCode = 0;
  if (wantReplay) {
    const result = replayHarnessSamples(harness, root, sampleDir, opts.sample);
    samples = result.samples;
    replayExitCode = result.exitCode;
    data.samples = samples;
    data.samples_summary = result.summary;
  }

  emit.data(data);
  if (process.stdout.isTTY && !opts.json) {
    const lines = [
      `Harness probe: ${harness}`,
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
        lines.push(`  Sample replay: no .json fixtures found under ${sampleDir}`);
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
 * Replay every JSON fixture in <root>/<sampleDir> against the live harness
 * dispatcher in an isolated sandbox.
 *
 * Sandbox isolation strategy:
 *   - mkdtempSync(tmpdir(), "harn-harness-probe-") creates a non-git tmp dir.
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
function replayHarnessSamples(
  harness: string,
  root: string,
  relativeSampleDir: string,
  filter?: string,
): {
  samples: SampleReplayResult[];
  exitCode: number;
  summary: { total: number; pass: number; fail: number; skipped: number };
} {
  const sampleDir = resolve(root, relativeSampleDir);
  if (!existsSync(sampleDir)) {
    return {
      samples: [],
      exitCode: 0,
      summary: { total: 0, pass: 0, fail: 0, skipped: 0 },
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
    };
  }

  // agent-hook is the single entry point. Replay sample payloads against it,
  // mapping the harness-native hook_event_name to the agent-hook CLI subcommand.
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
  const harnessFlag = harness === "claude_code" ? "claude-code" : harness;

  const sandbox = mkdtempSync(join(tmpdir(), "harn-harness-probe-"));
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
      const dispatch = spawnSync("bash", [agentHook, subcommand, "--harness", harnessFlag], {
        cwd: sandbox,
        encoding: "utf8",
        input: JSON.stringify(payloadObj),
        timeout: 10_000,
        env: {
          ...process.env,
          HARNERY_COORD_ROOT_OVERRIDE: sandbox,
          HARNERY_AGENT_COORD_HARNESS: harness,
          HARNERY_AGENT_COORD_PLATFORM: harness,
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

/** Parse "30", "30s", "5m", "1h", "2d" → ms. Bare integer defaults to minutes (back-compat). */
function parseDurationToMs(input: string): number | null {
  const match = input.trim().match(/^(\d+)([smhd]?)$/i);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (match[2] || "m").toLowerCase();
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
    emit.error({
      code: "no_pidmap_entry",
      message: "not in an agent session; ppid walk found no pid-map entry",
    });
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
  const myHb = readHeartbeat(myOwner);
  const fromName = myHb?.name ?? "anonymous";
  const body = `from agent-${fromName}: ${message.trim()}`;
  const doc = appendEntry(peerOwner, "handoff", body);

  const data = {
    peer: name,
    peer_instance_id: peerOwner,
    from: fromName,
    body,
    scratch_path: doc.path,
    scratch_bytes: doc.bytes,
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
    const hb = readHeartbeat(peerOwner);
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
      const lastTool = hb.last_tool ? `, last=${hb.last_tool}` : "";
      const elapsedStr = formatAge(Math.floor(elapsedMs / 1000));
      const progress = `  [${elapsedStr}] ${stillBlocking.length} file(s) blocking${lastTool}\n`;
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
  owner: string;
  kind: string;
  sessionId?: string;
  pid?: string;
  json?: boolean;
}): void {
  if (opts.json) emit.config({ format: "json" });

  const owner = opts.owner.trim();
  const kind = opts.kind.trim();
  if (!owner) {
    emit.error({ code: "missing_owner", message: "--owner is required" });
    process.exit(1);
  }
  if (kind !== "pidmap" && kind !== "heartbeat" && kind !== "kill") {
    emit.error({
      code: "bad_kind",
      message: "--kind must be one of: pidmap, heartbeat, kill",
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

  const action =
    kind === "pidmap" ? "heal-pidmap" : kind === "heartbeat" ? "heal-heartbeat" : "kill-heartbeat";

  // Build positional args. agent-coord's arg layout:
  //   heal-pidmap <instance_id> [<pid>]
  //   heal-heartbeat <instance_id> [<session_id>]
  //   kill-heartbeat <instance_id>
  const helperArgs: string[] = [action, owner];
  if (kind === "pidmap" && opts.pid) helperArgs.push(opts.pid);
  if (kind === "heartbeat" && opts.sessionId) helperArgs.push(opts.sessionId);

  // heal-pidmap / heal-heartbeat / kill-heartbeat are handled by the
  // agent-coord binary at harnery/bin/agent-coord.
  const helper = `${root}/harnery/bin/agent-coord`;
  const proc = spawnSync(helper, helperArgs, {
    encoding: "utf8",
    ...coordHelperOpts(root),
  });

  if (proc.status !== 0) {
    emit.error({
      code: "heal_failed",
      message: proc.stderr?.trim() || `agent-coord ${action} exited non-zero`,
    });
    process.exit(1);
  }

  // Re-read the heartbeat to surface post-action state (or null if killed).
  let after: Heartbeat | null = null;
  try {
    after = readHeartbeat(owner);
  } catch {
    after = null;
  }

  // Outcome semantics differ per kind. kill-heartbeat targets the heartbeat
  // file directly; heal-heartbeat upserts it; heal-pidmap touches a pid-map
  // row whose existence is independent of the heartbeat. Reporting on
  // "heartbeat present after" for the pidmap path was misleading: it's
  // unrelated to whether the heal succeeded.
  const outcome =
    kind === "pidmap"
      ? proc.status === 0
        ? "ok"
        : "failed"
      : after
        ? "heartbeat_present"
        : "heartbeat_absent";

  emit.data({
    rows: [
      {
        instance_id: owner,
        action,
        outcome,
        after,
      },
    ],
    meta: {
      kind,
      helper: "harnery/bin/agent-coord",
    },
  });
  if (!opts.json) {
    if (kind === "pidmap") {
      emit.text(`agent-coord ${action} ok\n`);
    } else {
      emit.text(`agent-coord ${action} ok: heartbeat ${after ? "present" : "absent"} after\n`);
    }
  }

  // Canonical health.* emission is owned by the writer (heartbeat-writer.ts
  // healPidmap/healHeartbeat), so it fires inside the agent-coord subprocess
  // above on actual writes only: write-only telemetry, no double-emit, no
  // event when an already-correct heal no-ops. (Previously emitted here
  // unconditionally on every `harn agents heal`, which over-counted no-op heals.)
}

/**
 * Shared emitter for council.* events. Looks up the running agent's
 * heartbeat so each event carries a real instance_id / session_id; falls
 * through silently if no session (CI / direct invocation).
 */
function emitCouncilStateEvent(
  type: string,
  manifest: CouncilManifest,
  extraData: Record<string, unknown>,
): void {
  const myOwner = resolveOwner();
  if (!myOwner) return;
  const hb = readHeartbeat(myOwner);
  emitCanonical({
    type,
    owner: myOwner,
    session: hb?.session_id ?? myOwner,
    harness: normalizeHarness(hb?.platform),
    data: { council_id: manifest.council_id, ...extraData },
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
    const myHb = readHeartbeat(myOwner);
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
    const myHbForEmit = readHeartbeat(myOwner);
    emitCanonical({
      type: "council.open",
      owner: myOwner,
      session: myHbForEmit?.session_id ?? myOwner,
      harness: normalizeHarness(myHbForEmit?.platform),
      data: {
        council_id: councilId,
        topic: trimmedObjective,
        members,
        target_doc: manifest.target_doc ?? undefined,
      },
    });
  }

  // Best-effort: ping each currently-active member's scratchpad with a
  // handoff entry pointing them at the council. Members not currently active
  // get nothing here; the Phase 2 SessionStart adapter will surface the
  // invite on their next session.
  const pingedMembers: string[] = [];
  const skippedMembers: string[] = [];
  for (const memberName of members) {
    const bareName = memberName.replace(/^agent-/, "");
    if (myOwner && readHeartbeat(myOwner)?.name === bareName) {
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
      const myHb = readHeartbeat(myOwner);
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
  emitCouncilStateEvent("council.close", next, { closed_at: next.closed_at! });

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
  emitCouncilStateEvent("council.archive", next, {});

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
  emitCouncilStateEvent("council.unarchive", next, { restored_status: restoredStatus });

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
    emitCouncilStateEvent("council.delete", manifest, {});
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
          message: `'${steward}' is not a known agent (active heartbeats + scratchpads archived in the last 30 days). Pass --allow-unknown to bootstrap. Known: ${known_names}`,
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

/** Build a markdown transcript of every round's contributions on disk. */
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
  //    for cross-harness councils where each reviewer agent has a different
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
        const myHb = readHeartbeat(myOwner);
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
    const myHb = readHeartbeat(myOwner);
    if (!myHb?.name) {
      emit.error({
        code: "no_self_name",
        message: `resolved owner ${myOwner.slice(0, 8)} has no name on heartbeat (pass --as <member> to override)`,
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
  emitCouncilStateEvent("council.contribution", manifest, {
    round_no: manifest.current_round,
    member: myName,
    body_summary: body.length > 1000 ? `${body.slice(0, 997)}...` : body,
  });

  // Update manifest: if all members have now contributed, flip round_status.
  const contributorsNow = contributorsInRound(manifest.council_id, manifest.current_round);
  const allIn = manifest.members.every((m) => contributorsNow.includes(m));
  let nextManifest = manifest;
  let autoAdvanced = false;
  if (allIn) {
    nextManifest = { ...manifest, round_status: "collected" };
    writeManifest(nextManifest);
    emitCouncilStateEvent("council.round_close", nextManifest, {
      round_no: nextManifest.current_round,
    });
    if (manifest.auto_advance) {
      nextManifest = advanceCouncil(nextManifest, /*force=*/ false);
      emitCouncilStateEvent("council.round_open", nextManifest, {
        round_no: nextManifest.current_round,
      });
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
  // shape as `contribute` for cross-harness scripting.
  let callerName: string;
  let actualName: string | null = null;
  if (opts.as) {
    callerName = normalizeAgentName(opts.as);
    try {
      const myOwner = resolveOwner();
      if (myOwner) {
        const myHb = readHeartbeat(myOwner);
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
    const myHb = readHeartbeat(myOwner);
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
  emitCouncilStateEvent("council.round_close", manifest, {
    round_no: manifest.current_round,
  });
  emitCouncilStateEvent("council.round_open", next, {
    round_no: next.current_round,
  });

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
 * member's scratchpad with the advance notification.
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

  // Ping each member's scratchpad with the advance notification.
  // (Convener already knows; we skip pinging them if they convened it from
  // their own session.)
  const myOwner = resolveOwner();
  const myName = myOwner ? normalizeAgentName(readHeartbeat(myOwner)?.name ?? "") : "";
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
      /* best-effort; member scratchpad may not exist yet */
    }
  }
  return next;
}

// ──────── end council impls ────────

// Hard cap on box width. Values longer than the per-row budget word-wrap to
// continuation lines (blank key column, value resumes indented). Picked to
// stay readable in narrow terminals + chat clients while giving long
// turn_summary / task values room to breathe.
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
