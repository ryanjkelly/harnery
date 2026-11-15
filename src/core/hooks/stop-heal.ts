/**
 * Heal a Stop verdict instead of refusing the turn (ADR 0266).
 *
 * The end-of-turn ritual protects two things: unfinished Git work is caught
 * before a turn ends, and the operator can see the session's status. Neither
 * needs the agent to remember a command. When the only missing steps are ones
 * the hook can do itself, it does them:
 *
 * - No closing status for the end of the turn (never ran, or a tool ran after
 *   it): the hook runs the same `agents status --end-turn` command, under a
 *   deadline. A pass allows the stop and shows the status to the person; a Git
 *   refusal blocks with that command's own message.
 * - The status ran but the reply did not show it: the hook renders the status
 *   and shows it to the person.
 * - No `set-task` this turn but the session already has a task: the hook
 *   records the same task again.
 *
 * Steps the hook cannot do stay refusals: unfinished Git work, a session that
 * has never declared a task (once per session), and the session-name display.
 *
 * The closing check runs as a child process of the same CLI rather than in
 * this process. The command writes its box to stdout, which is the hook's own
 * protocol channel, and it exits the process on failure; a child also gives
 * the deadline a hard edge that synchronous Git work in this process would not.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Adapter } from "../adapter.ts";
import {
  HEALABLE_STOP_RULES,
  mergeStopBlocks,
  type StopVerdict,
} from "../agents/rules/stop-hook.ts";
import type { VerdictResult } from "../agents/rules/verdict.ts";

/** Whole budget for one hook-side status run. */
export const STOP_HEAL_DEADLINE_MS = 20_000;
/** Bound handed to the closing check's automatic sync, inside the deadline. */
export const STOP_HEAL_SYNC_TIMEOUT_MS = 12_000;

export type StopHealRule =
  | "stop-hook.healed_status_run"
  | "stop-hook.healed_status_display"
  | "stop-hook.healed_task_carried"
  | "stop-hook.no_task_already_refused";

export interface ChildRun {
  status: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface StopHealDependencies {
  /** Run the CLI with `args`; must never throw. */
  runCli?: (args: string[], timeoutMs: number, env: Record<string, string>) => ChildRun;
  /** The session's current task, or undefined when none was ever declared. */
  readTask?: () => string | undefined;
  /** Record the current task again; true when the event was recorded. */
  carryTask?: (task: string) => boolean;
  /** True when an earlier stop cycle already carried the no-task refusal. */
  hasNoTaskRefusal?: () => boolean;
  markNoTaskRefusal?: () => void;
}

export interface StopHealContext {
  adapter: Adapter;
  sessionId: string;
  /**
   * Whether this project requires Git finalization at the end of a turn. When
   * it does not, the hook runs the ordinary status and never imposes the
   * commit-and-push check the project opted out of.
   */
  requireGitFinalization: boolean;
  /**
   * Whether the hook's own owned-work observation succeeded before healing.
   * When it did not, a hook-side check that fails or times out has nothing to
   * fall back on, so the original refusal stands.
   */
  gitObserved: boolean;
  deadlineMs?: number;
  syncTimeoutMs?: number;
}

export interface StopHealOutcome {
  verdict: VerdictResult;
  /** Text for the person, shown through the adapter's user-visible channel. */
  userMessage?: string;
  /** Telemetry fields for the hook's debug row. */
  debug: Record<string, unknown>;
}

const PASS_THROUGH_RULES: ReadonlySet<string> = new Set([
  "stop-hook.bypass",
  "stop-hook.workflow_child",
  "stop-hook.codex_observe_only",
  "stop-hook.no_history",
  "stop-hook.pure_prose_pass",
  "stop-hook.v3_evidence_unavailable",
  "stop-hook.background_handoff_deferred",
]);

export function healStopVerdict(
  verdict: StopVerdict,
  ctx: StopHealContext,
  deps: StopHealDependencies = {},
): StopHealOutcome {
  const untouched = { verdict: stripStopFields(verdict), debug: {} };
  if (ctx.adapter === "codex" || ctx.adapter === "opencode") return untouched;
  if (PASS_THROUGH_RULES.has(verdict.rule)) return untouched;

  const pending = verdict.allow ? [] : (verdict.pending_blocks ?? [verdict]);
  const pendingRules = new Set(pending.map((block) => block.rule));
  const hard = pending.filter((block) => !HEALABLE_STOP_RULES.has(block.rule));
  const healed: StopHealRule[] = [];
  const debug: Record<string, unknown> = {};

  if (pendingRules.has("stop-hook.rule_3_3")) {
    const task = safe(() => deps.readTask?.(), undefined)?.trim();
    if (task) {
      debug.task_carried = safe(() => deps.carryTask?.(task) ?? false, false);
      healed.push("stop-hook.healed_task_carried");
    } else if (safe(() => deps.hasNoTaskRefusal?.() ?? false, false)) {
      healed.push("stop-hook.no_task_already_refused");
    } else {
      const block = pending.find((b) => b.rule === "stop-hook.rule_3_3");
      if (block) hard.push(block);
    }
  }

  if (hard.length > 0) {
    // A refusal is coming anyway; running the closing check now would only
    // spend the deadline. Name only the steps that are still refused.
    const merged = mergeStopBlocks(hard) ?? hard[0]!;
    if (hard.some((b) => b.rule === "stop-hook.rule_3_3")) {
      safe(() => deps.markNoTaskRefusal?.(), undefined);
    }
    return {
      verdict: {
        ...merged,
        ...(verdict.remediation_cycle_anchor
          ? { remediation_cycle_anchor: verdict.remediation_cycle_anchor }
          : {}),
      },
      debug: { ...debug, healed, refused_rules: hard.map((b) => b.rule) },
    };
  }

  const needsRun = pendingRules.has("stop-hook.rule_1_3") || verdict.status_after_tools === true;
  const needsDisplay = !needsRun && pendingRules.has("stop-hook.rule_2_3");
  const deadline = ctx.deadlineMs ?? STOP_HEAL_DEADLINE_MS;
  const runCli = deps.runCli ?? defaultRunCli;

  if (needsRun) {
    const run = runCli(
      ctx.requireGitFinalization
        ? ["agents", "status", "--end-turn", "--session-id", ctx.sessionId]
        : ["agents", "status", "--session-id", ctx.sessionId],
      deadline,
      { HARNERY_END_TURN_SYNC_TIMEOUT_MS: String(ctx.syncTimeoutMs ?? STOP_HEAL_SYNC_TIMEOUT_MS) },
    );
    const box = run.stdout.trimEnd();
    if (run.status === 0 && !run.timedOut && box) {
      healed.unshift("stop-hook.healed_status_run");
      return allowHealed(healed, debug, box);
    }
    const error = parseCliError(run.stderr);
    if (!run.timedOut && ctx.requireGitFinalization && error?.code === "git_not_finalized") {
      return {
        verdict: {
          allow: false,
          exit_code: 2,
          rule: "stop-hook.git_not_finalized",
          reason: error.message,
          ...(verdict.remediation_cycle_anchor
            ? { remediation_cycle_anchor: verdict.remediation_cycle_anchor }
            : {}),
        },
        debug: { ...debug, healed, heal_check: "git_not_finalized" },
      };
    }
    // Deadline or internal failure. When the hook's own Git observation ran
    // before this, it already refused any unfinished owned work, so the
    // existing unavailable-evidence policy allows the stop. When that
    // observation was itself unavailable, nothing has established that owned
    // work is finished: keep the original refusal, which the remediation cap
    // still bounds.
    // This covers every blocked turn, not only a missing status: a status
    // that ran before a later edit satisfies the status rule, yet says nothing
    // about that edit.
    const statusBlocks = pending.filter(
      (b) => b.rule === "stop-hook.rule_1_3" || b.rule === "stop-hook.rule_2_3",
    );
    const unverified = mergeStopBlocks(statusBlocks.length > 0 ? statusBlocks : pending);
    if (ctx.requireGitFinalization && !ctx.gitObserved && unverified) {
      return {
        verdict: {
          ...unverified,
          ...(verdict.remediation_cycle_anchor
            ? { remediation_cycle_anchor: verdict.remediation_cycle_anchor }
            : {}),
        },
        debug: {
          ...debug,
          healed,
          heal_check: run.timedOut ? "timeout" : "unavailable",
          refused_rules: [unverified.rule],
          git_observed: false,
        },
      };
    }
    const detail = run.timedOut
      ? `the hook-side closing check passed its ${Math.round(deadline / 1000)}s deadline`
      : `the hook-side closing check could not run (${error?.code ?? run.error ?? `exit ${run.status}`})`;
    return {
      verdict: {
        allow: true,
        exit_code: 0,
        rule: "stop-hook.v3_evidence_unavailable",
        reason: `${detail}; Stop remains fail-open`,
      },
      debug: {
        ...debug,
        healed,
        heal_check: run.timedOut ? "timeout" : "unavailable",
        ...(error?.code ? { heal_error: error.code } : {}),
      },
    };
  }

  if (needsDisplay) {
    const run = runCli(["agents", "status", "--session-id", ctx.sessionId], deadline, {});
    const box = run.status === 0 && !run.timedOut ? run.stdout.trimEnd() : "";
    healed.unshift("stop-hook.healed_status_display");
    if (!box) debug.display_failed = run.timedOut ? "timeout" : `exit ${run.status}`;
    return allowHealed(healed, debug, box || undefined);
  }

  if (healed.length > 0) return allowHealed(healed, debug);
  return untouched;
}

function allowHealed(
  healed: StopHealRule[],
  debug: Record<string, unknown>,
  box?: string,
): StopHealOutcome {
  const rule = healed[0]!;
  return {
    verdict: {
      allow: true,
      exit_code: 0,
      rule,
      reason: `healed: ${healed.join(", ")}`,
    },
    ...(box
      ? { userMessage: formatHealedStatusMessage(box, rule === "stop-hook.healed_status_run") }
      : {}),
    debug: { ...debug, healed },
  };
}

function stripStopFields(verdict: StopVerdict): VerdictResult {
  const { pending_blocks: _pending, status_after_tools: _after, ...rest } = verdict;
  return rest;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** The CLI reports failures as `{"error":{"code","message"}}` on stderr. */
export function parseCliError(stderr: string): { code: string; message: string } | undefined {
  for (const line of stderr.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { error?: { code?: unknown; message?: unknown } };
      if (typeof parsed.error?.code === "string") {
        return {
          code: parsed.error.code,
          message: typeof parsed.error.message === "string" ? parsed.error.message : "",
        };
      }
    } catch {
      // not the error envelope
    }
  }
  return undefined;
}

/** Path of this package's CLI entry, matching the runtime (source or built). */
export function cliEntryPath(): string {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`../../cli${ext}`, import.meta.url));
}

export function makeCliRunner(coordRoot: string) {
  return (args: string[], timeoutMs: number, env: Record<string, string>): ChildRun => {
    try {
      const result = spawnSync(process.execPath, [cliEntryPath(), ...args], {
        cwd: coordRoot,
        env: { ...process.env, ...env, HARNERY_COORD_ROOT_OVERRIDE: coordRoot },
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
      });
      const timedOut =
        (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
        (result.status === null && result.signal === "SIGKILL");
      return {
        status: result.status,
        timedOut,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        ...(result.error && !timedOut ? { error: result.error.message } : {}),
      };
    } catch (err) {
      return { status: null, timedOut: false, stdout: "", stderr: "", error: String(err) };
    }
  };
}

function defaultRunCli(): ChildRun {
  return { status: null, timedOut: false, stdout: "", stderr: "", error: "no CLI runner" };
}

/** Prefix the person sees above a status the hook produced. */
export function formatHealedStatusMessage(box: string, ran: boolean): string {
  const lead = ran
    ? "Harnery ran the end-of-turn check for this turn:"
    : "End-of-turn status for this turn:";
  return `${lead}\n${box}`;
}

/**
 * Heal one Stop verdict for a live session, wiring the real dependencies.
 * Never throws: any internal failure returns the verdict unchanged.
 */
export async function healStopForSession(
  coordRoot: string,
  adapter: Adapter,
  instanceId: string,
  sessionId: string,
  verdict: StopVerdict,
  gitObserved: boolean,
): Promise<StopHealOutcome> {
  try {
    const { agentsRequireGitFinalization } = await import("../config.ts");
    const { readLiveCoordinationRow } = await import("../agents/state/live-coordination-view.ts");
    const { noTaskRefusedEarlier, markNoTaskRefusal } = await import("./remediation-cap.ts");
    const { recordLiveTaskChangeV3 } = await import("../agents/live-authority-v3.ts");
    const row = () => readLiveCoordinationRow(coordRoot, instanceId);
    return healStopVerdict(
      verdict,
      {
        adapter,
        sessionId,
        requireGitFinalization: agentsRequireGitFinalization(coordRoot),
        gitObserved,
      },
      {
        runCli: makeCliRunner(coordRoot),
        readTask: () => row()?.task,
        carryTask: (task) => {
          // Same authority path as `agents set-task`, with the unchanged task.
          recordLiveTaskChangeV3({
            coordRoot,
            owner: instanceId,
            nativeSessionId: row()?.session_id ?? instanceId,
            adapter,
            task,
          });
          return true;
        },
        hasNoTaskRefusal: () =>
          noTaskRefusedEarlier(coordRoot, sessionId, verdict.remediation_cycle_anchor),
        markNoTaskRefusal: () =>
          markNoTaskRefusal(coordRoot, sessionId, verdict.remediation_cycle_anchor),
      },
    );
  } catch (err) {
    return { verdict: stripStopFields(verdict), debug: { heal_error: String(err) } };
  }
}
