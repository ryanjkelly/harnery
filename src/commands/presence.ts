import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { monorepoRoot } from "../core/agents/coord-client.ts";
import {
  emitCanonical,
  normalizeHarness,
  readHeartbeat,
  resolveOwner,
} from "../core/agents/index.ts";
import { fetchPresence, publishPresence, readRemoteMachines } from "../core/presence/index.ts";
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
      "Presence: mobile/office state (get/set/clear/detect) + cross-machine session presence (publish/fetch/peers)",
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
    .command("peers")
    .description("Show sessions on other machines from the locally-known presence refs")
    .option("--json", "JSON output")
    .option("--stale", "Include machines past the stale window")
    .action((opts: { json?: boolean; stale?: boolean }) => {
      const root = requireRoot(emit);
      const machines = readRemoteMachines(root, { includeStale: opts.stale });
      if (opts.json) emit.config({ format: "json" });
      if (opts.json || !process.stdout.isTTY) {
        emit.data({ machines });
        return;
      }
      if (machines.length === 0) {
        emit.text("no remote sessions known (try `presence fetch --force`)\n");
        return;
      }
      for (const m of machines) {
        emit.text(`${m.machine}  (published ${formatAge(m.age_secs)} ago)\n`);
        for (const a of m.agents) {
          const task = a.task ? `  "${a.task.slice(0, 70)}"` : "";
          const files = a.files_touched?.length ? `  [${a.files_touched.length} files]` : "";
          emit.text(`  agent-${a.name ?? a.instance_id.slice(0, 8)}${task}${files}\n`);
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
  const hb = readHeartbeat(owner);
  emitCanonical({
    type: "state.presence_change",
    owner,
    session: hb?.session_id ?? owner,
    harness: normalizeHarness(hb?.platform),
    data: { from, to, source },
  });
}
