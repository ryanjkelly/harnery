import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { monorepoRoot, readHeartbeat, resolveOwner } from "../core/agents/index.ts";
import {
  type CheckpointReason,
  checkpointContext,
  readContextState,
  readLatestCapsule,
} from "../core/context/index.ts";
import type { Adapter } from "../core/hooks/events/schema.ts";

/**
 * `harn checkpoint`: durable context continuity across compaction.
 *
 * A checkpoint captures enough of the current work that a fresh generation of
 * the same session can resume it after the adapter compacts or restarts.
 * `create` writes a capsule, `show` prints the latest one, `status` reports the
 * phase, generation, and whatever context telemetry the adapter supplied.
 */
export function registerCheckpointCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const command = program
    .command("checkpoint")
    .description(
      "Durable context-continuity capsules: create one, show the latest, or report continuity phase.",
    )
    .option("--json", "Structured JSON output");

  command
    .command("status")
    .description("Show context-continuity phase, generation, and latest telemetry")
    .option("--session <id>", "Session id (defaults to the current agent heartbeat)")
    .option("--instance <id>", "Agent instance id (defaults to the current owner)")
    .option("--json", "Structured JSON output")
    .action((opts: { session?: string; instance?: string; json?: boolean }) => {
      try {
        const json = opts.json || Boolean(command.opts().json);
        const identity = resolveContinuityIdentity(context, opts);
        const state = readContextState(identity.coordRoot, identity.sessionId);
        if (json) {
          emit.config({ format: "json" });
          emit.data({ state, identity });
          return;
        }
        if (!state) {
          emit.text(`No context continuity state for session ${identity.sessionId}.\n`);
          return;
        }
        const sample = state.latest_context;
        const usage = sample
          ? `${sample.used_tokens ?? "?"}/${sample.window_tokens ?? "?"} tokens${sample.used_percent === undefined ? "" : ` (${sample.used_percent}%)`}`
          : "not reported by adapter";
        emit.text(
          `${[
            `Session:    ${state.session_id}`,
            `Phase:      ${state.phase}`,
            `Generation: ${state.generation}`,
            `Telemetry:  ${usage}`,
            `Capsule:    ${state.latest_capsule ?? "none"}`,
            state.degraded_reason ? `Degraded:   ${state.degraded_reason}` : "",
          ]
            .filter(Boolean)
            .join("\n")}\n`,
        );
      } catch (err) {
        emitCommandError(emit, "checkpoint_status_failed", err);
      }
    });

  command
    .command("create")
    .description("Create a durable context-continuity capsule for the current work")
    .option("--session <id>", "Session id (defaults to the current agent heartbeat)")
    .option("--instance <id>", "Agent instance id (defaults to the current owner)")
    .option("--adapter <id>", "claude-code, codex, or cursor (inferred from heartbeat)")
    .option("--reason <reason>", "manual, pressure, pre_compact, or session_end", "manual")
    .option("--note <text>", "Short continuation note for the recovered agent")
    .option("--json", "Structured JSON output")
    .action(
      (opts: {
        session?: string;
        instance?: string;
        adapter?: string;
        reason: string;
        note?: string;
        json?: boolean;
      }) => {
        try {
          const json = opts.json || Boolean(command.opts().json);
          const reason = parseCheckpointReason(opts.reason);
          const identity = resolveContinuityIdentity(context, opts);
          if (!identity.adapter) {
            throw new Error("could not infer the adapter; pass --adapter claude-code|codex|cursor");
          }
          const result = checkpointContext(identity.coordRoot, {
            sessionId: identity.sessionId,
            instanceId: identity.instanceId,
            adapter: identity.adapter,
            cwd: context?.repoRoot ?? process.cwd(),
            reason,
            continuationNote: opts.note,
          });
          const output = {
            capsule_id: result.capsule.capsule_id,
            generation: result.capsule.generation,
            path: result.state.latest_capsule,
            phase: result.state.phase,
            reused: result.reused,
          };
          if (json) {
            emit.config({ format: "json" });
            emit.data(output);
            return;
          }
          emit.text(
            `Checkpointed context generation ${output.generation}: ${output.path ?? result.path}\n`,
          );
        } catch (err) {
          emitCommandError(emit, "checkpoint_create_failed", err);
        }
      },
    );

  command
    .command("show")
    .description("Show the latest durable context-continuity capsule")
    .option("--session <id>", "Session id (defaults to the current agent heartbeat)")
    .option("--instance <id>", "Agent instance id (defaults to the current owner)")
    .option("--json", "Structured JSON output")
    .action((opts: { session?: string; instance?: string; json?: boolean }) => {
      try {
        const json = opts.json || Boolean(command.opts().json);
        const identity = resolveContinuityIdentity(context, opts);
        const capsule = readLatestCapsule(identity.coordRoot, identity.sessionId);
        if (!capsule) {
          throw new Error(`no context capsule exists for session ${identity.sessionId}`);
        }
        if (json) emit.config({ format: "json" });
        emit.data(capsule);
      } catch (err) {
        emitCommandError(emit, "checkpoint_show_failed", err);
      }
    });
}

function resolveContinuityIdentity(
  context: HarneryProgramContext | undefined,
  opts: { session?: string; instance?: string; adapter?: string },
): { coordRoot: string; instanceId: string; sessionId: string; adapter: Adapter | null } {
  const coordRoot = context?.resolveCoordRoot?.() ?? context?.repoRoot ?? monorepoRoot();
  if (!coordRoot) throw new Error("could not resolve a project containing .harnery/");
  const instanceId = opts.instance ?? resolveOwner();
  if (!instanceId) {
    throw new Error("could not resolve the current agent; pass --instance and --session");
  }
  const heartbeat = readHeartbeat(instanceId);
  const sessionId = opts.session ?? heartbeat?.session_id ?? instanceId;
  const adapter = opts.adapter
    ? parseAdapter(opts.adapter)
    : adapterFromPlatform(heartbeat?.platform);
  return { coordRoot, instanceId, sessionId, adapter };
}

function adapterFromPlatform(platform: string | undefined): Adapter | null {
  if (platform === "claude-code") return "claude-code";
  if (platform === "cursor") return "cursor";
  if (platform === "codex") return "codex";
  return null;
}

function parseAdapter(value: string): Adapter {
  if (value === "claude-code" || value === "codex" || value === "cursor") return value;
  throw new Error(`invalid adapter "${value}"; expected claude-code, codex, or cursor`);
}

function parseCheckpointReason(value: string): CheckpointReason {
  if (
    value === "manual" ||
    value === "pressure" ||
    value === "pre_compact" ||
    value === "session_end"
  ) {
    return value;
  }
  throw new Error(
    `invalid reason "${value}"; expected manual, pressure, pre_compact, or session_end`,
  );
}

function emitCommandError(emit: EmitContext, code: string, err: unknown): void {
  emit.error({ code, message: err instanceof Error ? err.message : String(err) });
  emit.setExitCode(1);
}
