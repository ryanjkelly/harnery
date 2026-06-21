import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import {
  emitCanonical,
  normalizeHarness,
  readHeartbeat,
  resolveOwner,
} from "../core/agents/index.ts";
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
 * `presence`: mobile/office state for agents (~/.claude/presence).
 *
 * Uses the injected EmitContext so composed and standalone consumers share
 * one code path. The state file path is Claude-Code-specific (lives under
 * ~/.claude/) but the detect/set/clear logic is generic: any agent harness
 * can adopt the same convention.
 */
export function registerPresenceCommand(program: Command, emit: EmitContext): void {
  const cmd = program
    .command("presence")
    .description("Mobile/office state for agents (~/.claude/presence)")
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
