import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { monorepoRoot } from "../core/agents/coord-client.ts";
import {
  emitEventV3,
  nativeSessionIdentity,
  normalizeAdapter,
  resolveOwner,
} from "../core/agents/index.ts";
import { readLiveCoordinationRow } from "../core/agents/state/live-coordination-view.ts";
import { peerInbox } from "../core/inbox/peer-messages.ts";
import {
  fetchPresence,
  publishPresence,
  readRemoteMachines,
  relayDaemonStatus,
  runRelayDaemon,
} from "../core/presence/index.ts";
import { importMail, mailStatus, publishMail } from "../core/presence/mail.ts";
import { type RelayStatus, relayStatus } from "../core/presence/relay-status.ts";
import {
  ageSeconds,
  applyDetection,
  clearPresence,
  formatAge,
  type PresenceState,
  presenceFilePath,
  readPresence,
  writePresence,
} from "../lib/presence.ts";

/**
 * `presence`: two related surfaces under one name.
 *
 *   1. Mobile/office state for agents (~/.claude/presence): get / set /
 *      clear / detect. The state file path is Claude-Code-specific but the
 *      logic is generic.
 *   2. Cross-machine session presence (ADR 0016): publish / fetch / peers —
 *      the git-refs transport that lets sessions on other machines show up
 *      in the peer table via `refs/harnery/presence/<machine>` on origin.
 *
 * Uses the injected EmitContext so composed and standalone consumers share
 * one code path.
 */
export function registerPresenceCommand(program: Command, emit: EmitContext): void {
  const cmd = program
    .command("presence")
    .description(
      "Presence: mobile/office state (get/set/clear/detect) + cross-machine session presence (publish/fetch/peers/relay-status)",
    )
    .action(() => {
      printStatus(emit);
    });

  cmd
    .command("get")
    .description('Print just the state ("mobile" / "office"), or full record with --json')
    .option("--json", "Print the full record as JSON")
    .action((opts: { json?: boolean }) => {
      const r = readPresence();
      if (opts.json) {
        emit.config({ format: "json" });
        emit.data({
          state: r.state,
          updated_at: r.updated_at,
          source: r.source,
          is_default: r.is_default,
          path: presenceFilePath(),
        });
        return;
      }
      emit.text(`${r.state}\n`);
    });

  cmd
    .command("set")
    .argument("<state>", "mobile | office")
    .description("Set state explicitly (source=cli). Hook auto-detection can still overwrite.")
    .action((state: string) => {
      if (state !== "mobile" && state !== "office") {
        emit.error({
          code: "invalid_state",
          message: `state must be "mobile" or "office" (got: ${JSON.stringify(state)})`,
        });
        process.exit(2);
      }
      const before = readPresence();
      writePresence(state as PresenceState, "cli");
      emitPresenceChange(before.state, state as PresenceState, "cli");
      printStatus(emit);
    });

  cmd
    .command("clear")
    .description('Delete the state file (next read returns the default, "office")')
    .action(() => {
      const removed = clearPresence();
      emit.data({
        ok: true,
        removed,
        path: presenceFilePath(),
      });
    });

  // ---- cross-machine session presence (ADR 0016) ----

  cmd
    .command("publish")
    .description(
      "Publish this machine's live sessions to refs/harnery/presence/<machine> on origin. " +
        "Change-batched with a keepalive; --force pushes regardless. Synchronous (errors report).",
    )
    .option("--force", "Push even if unchanged / within throttle windows")
    .action((opts: { force?: boolean }) => {
      const root = requireRoot(emit);
      const r = publishPresence(root, { force: opts.force, sync: true });
      if (r.status === "error") {
        emit.error({ code: "publish_failed", message: r.error });
        process.exit(1);
      }
      emit.data(r);
    });

  cmd
    .command("fetch")
    .description(
      "Fetch peer machines' presence refs from origin (throttled; --force bypasses). Synchronous.",
    )
    .option("--force", "Fetch even within the throttle interval")
    .action((opts: { force?: boolean }) => {
      const root = requireRoot(emit);
      const r = fetchPresence(root, { force: opts.force, sync: true });
      if (r.status === "error") {
        emit.error({ code: "fetch_failed", message: r.error });
        process.exit(1);
      }
      emit.data(r);
    });

  cmd
    .command("mail")
    .description(
      "Show cross-machine peer messages (ADR 0222): this machine's unacknowledged outbox, " +
        "acknowledgements it is publishing, and delivered/expired counts. --sync fetches, " +
        "imports, and publishes first (synchronous; errors report).",
    )
    .option(
      "--sync",
      "Fetch peers' refs, import mail addressed here, and publish this machine's ref",
    )
    .option("--json", "JSON output")
    .action((opts: { sync?: boolean; json?: boolean }) => {
      const root = requireRoot(emit);
      let sync: Record<string, unknown> | undefined;
      if (opts.sync) {
        const fetched = fetchPresence(root, { force: true, sync: true });
        if (fetched.status === "error") {
          emit.error({ code: "fetch_failed", message: fetched.error });
          process.exit(1);
        }
        const imported = importMail(root, peerInbox(root), { publish: false });
        const published = publishMail(root, { sync: true });
        if (published.status === "error") {
          emit.error({ code: "publish_failed", message: published.error });
          process.exit(1);
        }
        sync = { imported, published };
      }
      const status = mailStatus(root);
      if (opts.json) emit.config({ format: "json" });
      if (opts.json || !process.stdout.isTTY) {
        emit.data({ ...status, ...(sync ? { sync } : {}) });
        return;
      }
      emit.text(
        `${status.machine}: ${status.outbox.length} waiting for acknowledgement, ` +
          `${status.acks} acknowledgements published, ${status.delivered} delivered, ` +
          `${status.expired} expired\n`,
      );
      for (const m of status.outbox) {
        emit.text(
          `  ${m.message_id} to agent-${m.recipient} on ${m.to_machine} (queued ${m.queued_at})\n`,
        );
      }
    });

  cmd
    .command("relay-daemon")
    .description(
      "Run the relay client daemon in the foreground (normally spawned detached by the hooks " +
        "when presence.relay is configured; holds the WebSocket, publishes on heartbeat change, " +
        "caches peers' blobs for the renderers, exits when the machine goes idle).",
    )
    .action(async () => {
      const root = requireRoot(emit);
      process.exit(await runRelayDaemon(root));
    });

  cmd
    .command("relay-status")
    .description(
      "Diagnose the relay transport from local state only: configured relay, daemon pid and " +
        "liveness, last connect/disconnect/idle exit from the presence-relay log, room id " +
        "prefix, relay-cache and git-ref peers (names, agent counts, ages), and the last git publish",
    )
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      const root = requireRoot(emit);
      const status = await relayStatus(root);
      if (opts.json) emit.config({ format: "json" });
      if (opts.json || !process.stdout.isTTY) {
        emit.data(status);
        return;
      }
      emit.text(formatRelayStatus(status));
    });

  cmd
    .command("peers")
    .description(
      "Show sessions on other machines (merged from presence refs + the relay daemon's cache)",
    )
    .option("--json", "JSON output")
    .option("--stale", "Include machines past the stale window")
    .action((opts: { json?: boolean; stale?: boolean }) => {
      const root = requireRoot(emit);
      const machines = readRemoteMachines(root, { includeStale: opts.stale });
      const daemon = relayDaemonStatus(root);
      if (opts.json) emit.config({ format: "json" });
      if (opts.json || !process.stdout.isTTY) {
        emit.data({ machines, relay_daemon: daemon });
        return;
      }
      emit.text(
        daemon.running
          ? `relay daemon: running (pid ${daemon.pid}, ${daemon.url})\n`
          : "relay daemon: not running (git-refs transport only)\n",
      );
      if (machines.length === 0) {
        emit.text("no remote sessions known (try `presence fetch --force`)\n");
        return;
      }
      for (const m of machines) {
        emit.text(`${m.machine}  (published ${formatAge(m.age_secs)} ago)\n`);
        for (const a of m.agents) {
          const task = a.task ? `  "${a.task.slice(0, 70)}"` : "";
          const files = a.files_touched?.length ? `  [${a.files_touched.length} files]` : "";
          const lifecycle =
            a.task_state === "blocked" && a.task_state_reason
              ? `${a.task_state}: ${a.task_state_reason}`
              : a.task_state;
          emit.text(
            `  agent-${a.name ?? a.instance_id.slice(0, 8)}${task}${files}  activity=${a.activity} lifecycle=${lifecycle}\n`,
          );
        }
      }
    });

  cmd
    .command("detect")
    .description(
      "Internal: read prompt text from stdin, apply detection rules, update state if signal is clear",
    )
    .option("--from-stdin", "Read prompt from stdin (the only supported input mode today)")
    .option("--verbose", "Print the detection result to stderr")
    .action(async (opts: { fromStdin?: boolean; verbose?: boolean }) => {
      const prompt = await readStdin();
      if (!prompt) {
        if (opts.verbose) emit.log("(no input on stdin; skipping)", "info");
        return;
      }
      const result = applyDetection(prompt);
      if (opts.verbose) {
        emit.log(
          JSON.stringify({
            detected: result.detected,
            before: result.before,
            after: result.after,
            changed: result.changed,
          }),
          "info",
        );
      }
    });
}

/** Human-readable `presence relay-status` (TTY without --json). Exported for tests. */
export function formatRelayStatus(s: RelayStatus): string {
  const lines: string[] = [];
  const age = (secs: number | null) => (secs === null ? "unknown age" : `${formatAge(secs)} ago`);
  const when = (e: { at: string } | null) =>
    e
      ? age(Math.max(0, Math.floor((Date.parse(s.generated_at) - Date.parse(e.at)) / 1000)))
      : "never";
  lines.push(`machine: ${s.machine}`);
  lines.push(
    s.relay.configured
      ? `relay: ${s.relay.url}`
      : "relay: not configured (git-refs transport only)",
  );
  lines.push(
    s.room.id_prefix
      ? `room: ${s.room.id_prefix}…${s.room.salted ? " (salted)" : ""}`
      : `room: unknown (${s.room.reason})`,
  );
  const d = s.daemon;
  lines.push(
    d.running
      ? `daemon: running, pid ${d.pid_record?.pid}, up ${formatAge(d.uptime_secs ?? 0)}${d.url_matches_config === false ? " (pid file names a different relay)" : ""}`
      : d.pid_record
        ? `daemon: not running (stale pid ${d.pid_record.pid})`
        : "daemon: not running",
  );
  const disc = s.log.last_disconnected;
  lines.push(`last connect: ${when(s.log.last_connected)}`);
  lines.push(
    `last disconnect: ${when(disc)}${disc ? ` (code ${disc.fields.code ?? "none"})` : ""}`,
  );
  lines.push(`last idle exit: ${when(s.log.last_idle_exit)}`);
  if (s.log.since_daemon_start) {
    const { connects, disconnects } = s.log.since_daemon_start;
    lines.push(`since daemon start: ${connects} connects, ${disconnects} disconnects logged`);
  }
  if (s.log.error) lines.push(`log: unreadable (${s.log.error})`);
  const peers = (label: string, rows: RelayStatus["relay_cache"]): void => {
    if (rows.length === 0) {
      lines.push(`${label}: none`);
      return;
    }
    lines.push(`${label}:`);
    for (const r of rows) {
      lines.push(
        `  ${r.machine}${r.self ? " (this machine)" : ""}  ${r.agents ?? "?"} agents, published ${age(r.age_secs)}${r.stale ? " (stale)" : ""}`,
      );
    }
  };
  peers("relay cache", s.relay_cache);
  peers("git refs", s.git_refs);
  lines.push(
    s.publish_state?.pushed_at
      ? `last git publish: ${age(s.publish_state.age_secs)} (${s.publish_state.agents ?? "?"} agents)`
      : "last git publish: never",
  );
  return `${lines.join("\n")}\n`;
}

function requireRoot(emit: EmitContext): string {
  const root = monorepoRoot();
  if (!root) {
    emit.error({ code: "not_in_repo", message: "coord root not found (no .harnery/ upward)" });
    process.exit(1);
  }
  return root;
}

function printStatus(emit: EmitContext): void {
  const r = readPresence();
  emit.data({
    state: r.state,
    updated_at: r.updated_at,
    source: r.source,
    is_default: r.is_default,
    age_seconds: r.is_default ? null : ageSeconds(r.updated_at),
    age_human: r.is_default ? "(default: file missing)" : formatAge(ageSeconds(r.updated_at)),
    path: presenceFilePath(),
  });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function emitPresenceChange(
  from: PresenceState,
  to: PresenceState,
  source: "cli" | "hook" | "user",
): void {
  if (from === to) return;
  const owner = resolveOwner();
  if (!owner) return;
  const root = monorepoRoot();
  const hb = root ? readLiveCoordinationRow(root, owner) : null;
  emitEventV3({
    owner,
    session: nativeSessionIdentity(hb, owner),
    adapter: normalizeAdapter(hb?.platform),
    observation: {
      event_type: "coord.presence_changed",
      prior_state: from,
      new_state: to,
      reason: `presence_${source}`,
    },
  });
}
