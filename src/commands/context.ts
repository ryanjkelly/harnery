import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { monorepoRoot, readHeartbeat, resolveOwner } from "../core/agents/index.ts";
import {
  type CheckpointReason,
  checkpointContext,
  readContextState,
  readLatestCapsule,
} from "../core/context/index.ts";
import type { Harness } from "../core/hooks/events/schema.ts";
import {
  buildContext,
  type ContextReport,
  DEFAULT_SECTIONS,
  OPT_IN_SECTIONS,
  type SectionName,
} from "../lib/context/index.ts";

/**
 * `harn context`: one-shot orientation snapshot.
 *
 * Aggregates self / time / repo / commits / submodules / peers (default) plus
 * opt-in services. Useful at session start, post-compaction, or before
 * dispatching subagents. Fail-open per section.
 */
export function registerContextCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const command = program
    .command("context")
    .description(
      `One-shot orientation snapshot: self, repo, submodules, peers, recent commits. Default sections: ${DEFAULT_SECTIONS.join(" / ")}. Opt-in: ${OPT_IN_SECTIONS.join(" / ")}.`,
    )
    .option(
      "--section <name>",
      `Limit to specific sections (comma-list or repeated; valid: ${[...DEFAULT_SECTIONS, ...OPT_IN_SECTIONS].join(", ")})`,
      collectSections,
      [] as SectionName[],
    )
    .option(
      "--include <name>",
      "Add an opt-in section (e.g. services)",
      collectSections,
      [] as SectionName[],
    )
    .option("--show-clean", "Don't hide clean submodules")
    .option("--json", "Structured JSON envelope")
    .action(
      async (opts: {
        section: SectionName[];
        include: SectionName[];
        showClean?: boolean;
        json?: boolean;
      }) => {
        try {
          const sections = opts.section.length > 0 ? opts.section : DEFAULT_SECTIONS;
          const report = await buildContext({
            sections,
            include: opts.include,
            showClean: opts.showClean,
            repoRoot: context?.repoRoot,
            submodules: context?.submodules,
          });
          if (opts.json) {
            emit.config({ format: "json" });
            emit.data(report);
            return;
          }
          emit.text(`${renderReport(report)}\n`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emit.error({ code: "context_failed", message: msg });
          process.exit(1);
        }
      },
    );

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
          : "not reported by harness";
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
        emitCommandError(emit, "context_status_failed", err);
      }
    });

  command
    .command("checkpoint")
    .description("Create a durable context-continuity capsule for the current work")
    .option("--session <id>", "Session id (defaults to the current agent heartbeat)")
    .option("--instance <id>", "Agent instance id (defaults to the current owner)")
    .option("--harness <id>", "claude-code, codex, or cursor (inferred from heartbeat)")
    .option("--reason <reason>", "manual, pressure, pre_compact, or session_end", "manual")
    .option("--note <text>", "Short continuation note for the recovered agent")
    .option("--json", "Structured JSON output")
    .action(
      (opts: {
        session?: string;
        instance?: string;
        harness?: string;
        reason: string;
        note?: string;
        json?: boolean;
      }) => {
        try {
          const json = opts.json || Boolean(command.opts().json);
          const reason = parseCheckpointReason(opts.reason);
          const identity = resolveContinuityIdentity(context, opts);
          if (!identity.harness) {
            throw new Error("could not infer the harness; pass --harness claude-code|codex|cursor");
          }
          const result = checkpointContext(identity.coordRoot, {
            sessionId: identity.sessionId,
            instanceId: identity.instanceId,
            harness: identity.harness,
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
          emitCommandError(emit, "context_checkpoint_failed", err);
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
        emitCommandError(emit, "context_show_failed", err);
      }
    });
}

function resolveContinuityIdentity(
  context: HarneryProgramContext | undefined,
  opts: { session?: string; instance?: string; harness?: string },
): { coordRoot: string; instanceId: string; sessionId: string; harness: Harness | null } {
  const coordRoot = context?.resolveCoordRoot?.() ?? context?.repoRoot ?? monorepoRoot();
  if (!coordRoot) throw new Error("could not resolve a project containing .harnery/");
  const instanceId = opts.instance ?? resolveOwner();
  if (!instanceId) {
    throw new Error("could not resolve the current agent; pass --instance and --session");
  }
  const heartbeat = readHeartbeat(instanceId);
  const sessionId = opts.session ?? heartbeat?.session_id ?? instanceId;
  const harness = opts.harness
    ? parseHarness(opts.harness)
    : harnessFromPlatform(heartbeat?.platform);
  return { coordRoot, instanceId, sessionId, harness };
}

function harnessFromPlatform(platform: string | undefined): Harness | null {
  if (platform === "claude_code" || platform === "claude-code") return "claude-code";
  if (platform === "cursor") return "cursor";
  if (platform === "codex") return "codex";
  return null;
}

function parseHarness(value: string): Harness {
  if (value === "claude-code" || value === "codex" || value === "cursor") return value;
  throw new Error(`invalid harness "${value}"; expected claude-code, codex, or cursor`);
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

function collectSections(value: string, prev: SectionName[]): SectionName[] {
  const all: SectionName[] = [...DEFAULT_SECTIONS, ...OPT_IN_SECTIONS];
  const out = [...prev];
  for (const tok of value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!all.includes(tok as SectionName)) {
      throw new Error(`unknown section "${tok}". Valid: ${all.join(", ")}`);
    }
    if (!out.includes(tok as SectionName)) out.push(tok as SectionName);
  }
  return out;
}

// ─── TTY rendering ─────────────────────────────────────────────────────────

function renderReport(r: ContextReport): string {
  const lines: string[] = [];
  if (r.self) lines.push(...renderSelf(r.self));
  if (r.time) lines.push(...renderTime(r.time));
  if (r.repo) lines.push(...renderRepo(r.repo));
  if (r.commits) lines.push(...renderCommits(r.commits));
  if (r.submodules) lines.push(...renderSubmodules(r.submodules));
  if (r.peers) lines.push(...renderPeers(r.peers));
  if (r.services) lines.push(...renderServices(r.services));
  lines.push("");
  lines.push(`(elapsed: ${r.meta.elapsed_ms}ms)`);
  return lines.join("\n");
}

function section(header: string, body: string[]): string[] {
  return ["", `── ${header} ──`, ...body];
}

function renderSelf(s: NonNullable<ContextReport["self"]>): string[] {
  if ("error" in s) return section("self", [`  (unavailable: ${s.error})`]);
  const body: string[] = [];
  body.push(
    `  agent-${s.name ?? "?"}  (${formatAge(s.session_age_secs)} old, owner=${s.instance_id.slice(0, 8)}…)`,
  );
  if (s.task) body.push(`  task:    "${s.task}"`);
  if (s.last_tool) {
    const target = s.last_tool_target ? `  ${truncate(s.last_tool_target, 80)}` : "";
    body.push(`  last:    ${s.last_tool}${target}`);
  }
  if (s.files_held.length > 0) {
    body.push(`  holds ${s.files_held.length} file(s):`);
    for (const f of s.files_held.slice(0, 5)) body.push(`    ${f}`);
    if (s.files_held.length > 5) body.push(`    +${s.files_held.length - 5} more`);
  } else {
    body.push("  files:   none held");
  }
  return section("self", body);
}

function renderTime(t: NonNullable<ContextReport["time"]>): string[] {
  return section("time", [`  ${t.chicago}  (UTC: ${t.utc})`]);
}

function renderRepo(r: NonNullable<ContextReport["repo"]>): string[] {
  if ("error" in r) return section("repo", [`  (unavailable: ${r.error})`]);
  const parts: string[] = [];
  const aheadBehind =
    r.ahead > 0 || r.behind > 0 ? ` (ahead ${r.ahead}, behind ${r.behind} vs origin)` : "";
  parts.push(`  cwd:     ${r.cwd}`);
  parts.push(`  branch:  ${r.branch}${aheadBehind}`);
  const dirtyBits: string[] = [];
  if (r.staged) dirtyBits.push(`${r.staged} staged`);
  if (r.modified) dirtyBits.push(`${r.modified} modified`);
  if (r.untracked) dirtyBits.push(`${r.untracked} untracked`);
  parts.push(`  status:  ${dirtyBits.length ? dirtyBits.join(", ") : "clean"}`);
  return section("repo", parts);
}

function renderCommits(c: NonNullable<ContextReport["commits"]>): string[] {
  if ("error" in c) return section("commits", [`  (unavailable: ${c.error})`]);
  if (c.rows.length === 0) return section("commits", ["  (none)"]);
  return section(
    "commits (last 3)",
    c.rows.map((row) => `  ${row.sha}  ${truncate(row.subject, 80)}`),
  );
}

function renderSubmodules(s: NonNullable<ContextReport["submodules"]>): string[] {
  if ("error" in s) return section("submodules", [`  (unavailable: ${s.error})`]);
  if (s.rows.length === 0) {
    const tail = s.clean_omitted > 0 ? ` (${s.clean_omitted} clean omitted)` : "";
    return section("submodules", [`  all clean${tail}`]);
  }
  const lines = s.rows.map((sm) => {
    const aheadBehind = sm.ahead > 0 || sm.behind > 0 ? ` ±${sm.ahead}/${sm.behind}` : "";
    const dirty = sm.dirty ? ` (${sm.modifiedFiles}m+${sm.untrackedFiles}u)` : "";
    return `  ${sm.name.padEnd(28)} ${sm.branch}${aheadBehind}${dirty}`;
  });
  const tail = s.clean_omitted > 0 ? [`  (+${s.clean_omitted} clean omitted)`] : [];
  return section("submodules", [...lines, ...tail]);
}

function renderPeers(p: NonNullable<ContextReport["peers"]>): string[] {
  if ("error" in p) return section("peers", [`  (unavailable: ${p.error})`]);
  if (p.rows.length === 0) return section("peers", ["  (none active)"]);
  const lines = p.rows.map((peer) => {
    const taskBit = peer.task ? ` "${truncate(peer.task, 40)}"` : "";
    const filesBit = peer.files > 0 ? `${peer.files}f` : "0f";
    const lastBit = peer.last_tool ? `, last: ${peer.last_tool}` : "";
    return `  agent-${peer.name.padEnd(12)}${taskBit}  (${peer.age_min}m old, ${filesBit}${lastBit})`;
  });
  return section("peers", lines);
}

function renderServices(s: NonNullable<ContextReport["services"]>): string[] {
  if ("error" in s) return section("services", [`  (unavailable: ${s.error})`]);
  if (s.docker_compose.length === 0) return section("services", ["  (no compose project running)"]);
  const lines = s.docker_compose.map((sv) => `  ${sv.service.padEnd(20)} ${sv.status}`);
  return section("services (docker compose)", lines);
}

// ─── Format helpers ────────────────────────────────────────────────────────

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

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
