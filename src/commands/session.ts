import { spawn } from "node:child_process";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { resolveOwner, selfDisplayName } from "../core/agents/index.ts";
import {
  clampField,
  newCmdId,
  readLastIntent,
  writeSessionEvent,
} from "../core/agents/session-events.ts";
import { resolveBinName } from "../core/config.ts";

/** Strip the `agent-` prefix so structured event `agent` field matches heartbeat.name. */
function bareAgentName(): string {
  const full = selfDisplayName();
  return full.startsWith("agent-") ? full.slice(6) : full;
}

function selfOwnerId(): string | undefined {
  return resolveOwner() ?? undefined;
}

/**
 * `harn session`: run a command (or narrate) and emit canonical coordination
 * events for follow-along.
 *
 * Follow-along happens through the canonical `.harnery/events.ndjson` stream +
 * the `/live` web viewer (or `harn agents watch`): `harn session -- <cmd>` runs
 * the command, forwards its output to the terminal verbatim, and emits canonical
 * `command.start/output/end`; `harn session log` emits a canonical `narration`
 * event. The file-management subcommands (`tail`/`clear`/`trim`/`path`) are
 * retired no-op stubs; `trim` is a silent no-op so a SessionStart hook that
 * calls it keeps working.
 *
 * Usage:
 *   harn session "<intent>" -- <cmd> [args...]   run command, emit command.* events
 *   harn session log "<message>"                 emit a narration event
 */
let emit: EmitContext;

export function registerSessionCommand(program: Command, emitParam: EmitContext): void {
  emit = emitParam;
  const session = program
    .command("session")
    .description("Run a command (or narrate) and emit canonical coordination events");

  // Narration-only entry → canonical narration event.
  session
    .command("log <message...>")
    .description("Emit a narration event (no command run)")
    .action((messageParts: string[]) => {
      const message = messageParts.join(" ");
      writeSessionEvent("narration", bareAgentName(), {
        instance_id: selfOwnerId(),
        message: clampField(message),
      });
      emit.text(`⋯ ${message}\n`);
    });

  // Retired file-management subcommands, kept as graceful no-op stubs so
  // existing callers (hooks, muscle memory) don't error. `trim` is the one a
  // hook invokes, so it must exit 0 silently.
  session
    .command("trim")
    .description("(retired): no-op kept for hook compatibility")
    .option("-y, --yes", "(ignored)")
    .option("--max-entries <n>", "(ignored)")
    .option("--max-bytes <size>", "(ignored)")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      /* silent no-op, exit 0 */
    });

  for (const name of ["tail", "clear", "path"] as const) {
    session
      .command(name)
      .description(`(retired): watch /live or '${resolveBinName()} agents watch'`)
      .allowUnknownOption()
      .action(() => {
        emit.text(
          `Retired. Live activity flows to .harnery/events.ndjson; watch the /live web viewer or run '${resolveBinName()} agents watch'.\n`,
        );
      });
  }

  // Default form: harn session "<intent>" -- <cmd> [args]
  session
    .argument("<intent>", "One-line description of what this action is for")
    .argument("<cmd...>", "The command to run (prefix with -- if it has its own flags)")
    .allowUnknownOption()
    .action((intent: string, cmd: string[]) => {
      runLogged(intent, cmd);
    });
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Strip ONLY carriage-return redraw noise (progress bars like `docker pull`'s
 * sticky line) from a chunk before splitting into event lines. Terminal
 * forwarding keeps the raw bytes; this only cleans the canonical event copy.
 */
function stripCRNoise(text: string): string {
  return text.replace(/[^\n]*\r(?!\n)/g, "");
}

function runLogged(intent: string, cmdArg: string[]): void {
  // Strip a leading `--` separator if commander left one in.
  const cmd = cmdArg[0] === "--" ? cmdArg.slice(1) : cmdArg;
  if (cmd.length === 0) {
    emit.error({ code: "usage", message: "Usage: harn session <intent> -- <cmd> [args...]" });
    process.exit(2);
  }

  const cmdLine = cmd.map(quoteArg).join(" ");
  const agent = bareAgentName();
  const instanceId = selfOwnerId();
  const cmdId = newCmdId();

  // Intent precedence: explicit arg wins; else the PreToolUse-stamped intent
  // file; else the command line itself.
  const resolvedIntent =
    intent && intent.trim().length > 0 ? intent : (readLastIntent(instanceId) ?? cmdLine);
  writeSessionEvent("command_start", agent, {
    instance_id: instanceId,
    cmd_id: cmdId,
    intent: clampField(resolvedIntent),
    cmd: clampField(cmdLine),
  });

  const start = Date.now();
  const child = spawn(cmd[0]!, cmd.slice(1), {
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk); // lint-ok-emission: harn session forwards child stdout verbatim; this IS the command's primary purpose
    for (const line of stripCRNoise(chunk.toString("utf8")).split("\n")) {
      if (line.length === 0) continue;
      writeSessionEvent("output", agent, {
        instance_id: instanceId,
        cmd_id: cmdId,
        stream: "stdout",
        line: clampField(line),
      });
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk); // lint-ok-emission: harn session forwards child stderr verbatim; this IS the command's primary purpose
    for (const line of stripCRNoise(chunk.toString("utf8")).split("\n")) {
      if (line.length === 0) continue;
      writeSessionEvent("output", agent, {
        instance_id: instanceId,
        cmd_id: cmdId,
        stream: "stderr",
        line: clampField(line),
      });
    }
  });

  child.on("error", (err) => {
    process.stderr.write(`✗ spawn failed: ${err.message}\n`);
    process.exit(127);
  });

  child.on("close", (code, signal) => {
    const durationMs = Date.now() - start;
    writeSessionEvent("command_end", agent, {
      instance_id: instanceId,
      cmd_id: cmdId,
      exit: code ?? null,
      signal: signal ?? null,
      duration_ms: durationMs,
    });
    process.exit(code ?? 1);
  });
}

/** Shell-safe quote an argument for human-readable logging (not for eval). */
function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
