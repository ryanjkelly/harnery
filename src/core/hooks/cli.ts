/**
 * `agent-hook` CLI entry point. Phase 2: real canonical-event emission
 * alongside the legacy stream.
 *
 * Flow:
 *   1. Parse argv → event-name + harness.
 *   2. Read stdin → harness payload (JSON or empty).
 *   3. Find coord root (walk up for .harnery/).
 *   4. Resolve instance_id (env → payload → pid-map walk).
 *   5. Map event-name → canonical event_type.
 *   6. Build event data from payload + resolvers (intent, transcript scan).
 *   7. Append envelope to .harnery/events.ndjson via emit() under flock.
 *   8. (Still also writes a debug breadcrumb to .harnery/debug/ for visibility.)
 *
 * Phase 2 ship criterion: confirms parser correctness across thousands of
 * real events without affecting behavior. Always exits 0. Failures land in
 * `.harnery/debug/agent-hook.errors.ndjson` for audit but never break the
 * harness flow.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { coordEnv } from "../../lib/env.ts";
import { replayCodexJsonl } from "../agents/codex-replay.ts";
import { consumeSince, writeCursor } from "../agents/events/consume.ts";
import { evaluateStopHook } from "../agents/rules/stop-hook.ts";
import { projectHeartbeats } from "../agents/state/heartbeat-projector.ts";
import { shellMutationPaths } from "../agents/state/shell-mutation.ts";
import {
  captureImages,
  detectPresence,
  imageJanitor,
  playSound,
  resetSoundCounters,
  runSessionSyncExtension,
  runTurnSummary,
  scratchArchive,
  scratchJanitor,
  scratchRecoveryCue,
  soundForEvent,
} from "./effects/index.ts";
import { emit } from "./events/emit.ts";
import type { Harness } from "./events/schema.ts";
import { canonicalize } from "./guard-path.ts";
import { detectHarness } from "./harness/detect.ts";
import {
  extractBashCommand,
  extractToolDescription,
  type NormalizedEventType,
  normalizeEventName,
  type ParsedPayload,
  parsePayload,
} from "./harness/parse.ts";
import { parsePsChainLine, selectAnchorPid } from "./resolve/anchor.ts";
import { findCoordRoot } from "./resolve/coord-root.ts";
import { extractIntentComment, resolveIntent } from "./resolve/intent.ts";
import { resolveOwner } from "./resolve/owner.ts";
import { scanStatusBoxPresent, scanTranscriptModel } from "./resolve/transcript.ts";

interface Argv {
  eventName: string | null;
  extra: string[];
}

function parseArgv(argv: string[]): Argv {
  const out: Argv = { eventName: null, extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--harness") {
      i++; // detectHarness will re-parse; just consume the value here.
      continue;
    }
    if (arg.startsWith("--harness=")) continue;
    if (!out.eventName && !arg.startsWith("--")) {
      out.eventName = arg;
    } else {
      out.extra.push(arg);
    }
  }
  return out;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Uint8Array);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  }
}

function appendDebug(coordRoot: string, entry: Record<string, unknown>): void {
  const path = join(coordRoot, ".harnery", "debug", "agent-hook.ndjson");
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* swallow */
  }
}

function logError(coordRoot: string | null, err: unknown, context: Record<string, unknown>): void {
  if (!coordRoot) return;
  const path = join(coordRoot, ".harnery", "debug", "agent-hook.errors.ndjson");
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        ...context,
      })}\n`,
      "utf8",
    );
  } catch {
    /* swallow */
  }
}

/**
 * Spawn `agent-coord assign-name <owner> <kind>` to mint or recover the
 * hurricane-style name for this owner. Returns null on any failure so
 * session.start emission never breaks the harness flow.
 *
 * Lives at agent-hooks side (not agent-coord) to keep emitter/consumer
 * separation: we spawn rather than import.
 */
function assignNameViaAgentCoord(
  coordRoot: string,
  instanceId: string,
  kind: "session" | "subagent" | "transient",
): { name: string; kind: string } | null {
  const binary = join(coordRoot, "harnery", "bin", "agent-coord");
  if (!existsSync(binary)) return null;
  try {
    const result = spawnSync(binary, ["assign-name", instanceId, kind], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (result.status !== 0 || !result.stdout) return null;
    const parsed = JSON.parse(result.stdout.trim()) as {
      name?: string;
      kind?: string;
    };
    if (parsed.name && parsed.kind) {
      return { name: parsed.name, kind: parsed.kind };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Direct (in-process) pidmap write, avoids the spawn overhead of going via
 * the agent-coord CLI for every session.start / subagent.start. Pid-map
 * rows are essential for `harn agents whoami` ppid resolution.
 */
function writePidmapViaAgentCoord(
  coordRoot: string,
  pid: number,
  instanceId: string,
  platform: string,
): void {
  try {
    // Inline write: same atomic temp+rename pattern as
    // agent-coord/src/state/pidmap.ts but skips importing across module
    // boundaries to keep agent-hooks's deps explicit.
    const dir = join(coordRoot, ".harnery", "pid-map");
    const path = join(dir, String(pid));
    const row = `${instanceId}\t${platform}`;
    if (existsSync(path)) {
      try {
        const current = require("node:fs").readFileSync(path, "utf8");
        if (current === row) return;
      } catch {
        /* fall through */
      }
    }
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    require("node:fs").writeFileSync(tmp, row, "utf8");
    require("node:fs").renameSync(tmp, path);
  } catch {
    /* never break the harness flow */
  }
}

function clampString(s: string, max: number): { value: string; truncated: boolean } {
  if (s.length <= max) return { value: s, truncated: false };
  return { value: s.slice(0, max), truncated: true };
}

function summarizeOutput(value: unknown, headTail = 500): { summary: string; truncated: boolean } {
  const str = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (str.length <= headTail * 2) return { summary: str, truncated: false };
  return {
    summary: `${str.slice(0, headTail)}\n…[truncated]…\n${str.slice(-headTail)}`,
    truncated: true,
  };
}

interface BuildContext {
  coordRoot: string;
  payload: ParsedPayload | null;
  raw: string;
  harness: Harness;
  instanceId: string;
}

function buildEventData(
  eventType: NormalizedEventType,
  ctx: BuildContext,
): Record<string, unknown> {
  const p = ctx.payload;
  switch (eventType) {
    case "session.start": {
      const harnessPlatform =
        ctx.harness === "claude-code"
          ? "claude_code"
          : ctx.harness === "cursor"
            ? "cursor"
            : "codex";
      // Assign (or recover) name + kind via agent-coord. Idempotent: resume
      // returns the original name; new owner consumes a counter slot.
      const assigned = assignNameViaAgentCoord(ctx.coordRoot, ctx.instanceId, "session");
      // Write the harness pid-map row so `harn agents whoami` ppid-walks find
      // this owner. Prefer the payload pid (the actual claude binary), then the
      // anchor walk (the `node` ancestor for Cursor, which has no payload pid),
      // then our own process.ppid. Without the anchor, Cursor anchored on the
      // ephemeral hook bash parent, a PID that dies before the agent's next
      // shell tool call, so the ppid walk found nothing (no_pidmap_entry).
      const harnessPid = p?.pid ?? findHarnessAnchorPid(ctx.harness) ?? process.ppid;
      if (harnessPid) {
        writePidmapViaAgentCoord(ctx.coordRoot, harnessPid, ctx.instanceId, harnessPlatform);
      }
      return {
        started_at: new Date().toISOString(),
        cwd: p?.cwd ?? process.cwd(),
        // Claude Code's SessionStart payload omits `model` (Codex + Cursor
        // supply it). Fall back to the transcript, populated on `resume`, and
        // backfilled later by `turn.stop` for a fresh `startup` session.
        model: p?.model ?? scanTranscriptModel(p?.transcript_path),
        pid: harnessPid,
        source: p?.source,
        platform: harnessPlatform,
        name: assigned?.name,
        kind: "session",
        agent_id: ctx.instanceId,
      };
    }

    case "session.end":
      return {
        ended_at: new Date().toISOString(),
        clean_exit: p?.clean_exit ?? true,
      };

    case "user_prompt.submit": {
      const prompt = p?.prompt ?? "";
      const { value, truncated } = clampString(prompt, 4000);
      return { prompt_text: value, ...(truncated ? { truncated: true } : {}) };
    }

    case "turn.stop": {
      return {
        // Backfill the model for harnesses that omit it at session.start
        // (Claude Code). The transcript is populated with assistant turns by
        // Stop-hook time, so this resolves even for fresh `startup` sessions.
        model: p?.model ?? scanTranscriptModel(p?.transcript_path),
        // Phase 2: tool_call_count + text_length aren't cheaply available
        // from the Stop payload alone (they'd require a transcript scan that
        // races with the JSONL flush). Emit `-1` / `0` sentinels and let
        // Phase 5 (the verdict path) recompute these from the event stream
        // itself rather than re-scanning the transcript.
        tool_call_count: -1,
        text_length: 0,
        // Box present if the transcript scan finds it OR the final assistant
        // message carries the `┌─ agent-` prefix. The latter covers codex's
        // text-only stop (box in last_assistant_message, no transcript), which
        // the verdict now sees because agent-hook emits this turn.stop itself
        // (the previous path passed those via the no-history fail-open).
        status_box_present:
          scanStatusBoxPresent(p?.transcript_path) ||
          ((p?.raw.last_assistant_message as string | undefined) ?? "").includes("┌─ agent-"),
        stop_hook_active: p?.stop_hook_active,
      };
    }

    case "subagent.start": {
      const subagentCallId =
        (p?.raw.subagent_id as string | undefined) ?? (p?.raw.agent_id as string | undefined);
      // Subagents inherit parent's name via the resolve-name session_id path
      // (agent-coord/state/names.ts → kind=transient). Use the call ID as the
      // instance_id input; assignName falls through to transient.
      const assigned = assignNameViaAgentCoord(ctx.coordRoot, ctx.instanceId, "subagent");
      return {
        agent_type:
          (p?.raw.agent_type as string | undefined) ??
          (p?.raw.subagent_type as string | undefined) ??
          "unknown",
        prompt_summary: p?.raw.prompt_summary as string | undefined,
        name: assigned?.name,
        kind: "subagent",
        agent_id: ctx.instanceId,
        subagent_call_id: subagentCallId,
        parent_session_id: p?.parent_session_id,
      };
    }

    case "subagent.stop": {
      const status = p?.exit_status;
      const normalized: "ok" | "error" | "interrupted" =
        status === "error" || status === "interrupted" ? status : "ok";
      return { exit_status: normalized, reason: p?.reason };
    }

    case "tool.pre_use": {
      const toolName = p?.tool_name ?? "unknown";
      const command = extractBashCommand(toolName, p?.tool_input);
      const description = extractToolDescription(p?.tool_input);
      const { intent, source } = resolveIntent({
        coordRoot: ctx.coordRoot,
        instanceId: ctx.instanceId,
        commandIntentComment: extractIntentComment(command),
        description,
      });
      const toolInputStr = JSON.stringify(p?.tool_input ?? null);
      const clamped = clampString(toolInputStr, 8000);
      return {
        tool_name: toolName,
        tool_input: clamped.value,
        intent,
        intent_source: source,
        tool_use_id: p?.tool_use_id,
        ...(clamped.truncated ? { truncated: true } : {}),
      };
    }

    case "tool.post_use": {
      const toolName = p?.tool_name ?? "unknown";
      const summary = summarizeOutput(p?.tool_response);
      return {
        tool_name: toolName,
        output_summary: summary.summary,
        exit_status: "ok" as const,
        duration_ms: 0, // Phase 3 pairs pre/post via tool_use_id
        tool_use_id: p?.tool_use_id,
        ...(summary.truncated ? { truncated: true } : {}),
      };
    }

    case "tool.post_use_failure": {
      const toolName = p?.tool_name ?? "unknown";
      const summary = summarizeOutput(p?.tool_response);
      return {
        tool_name: toolName,
        error: summary.summary,
        duration_ms: 0,
        tool_use_id: p?.tool_use_id,
        ...(summary.truncated ? { truncated: true } : {}),
      };
    }
  }
}

async function main(): Promise<number> {
  const { eventName, extra } = parseArgv(process.argv.slice(2));
  const harness = detectHarness(process.argv.slice(2));
  const raw = await readStdin();

  // Kill-switch-INDEPENDENT effects: notification sounds fire BEFORE the
  // HARNERY_AGENT_COORD_OFF gate so audible feedback survives incident-triage
  // bypass: sound playback happens before the kill-switch bailout.
  // Claude-Code-only; stop-failure → error, sub-agent-start → subagent-start.
  if (harness === "claude-code" && eventName) {
    const s = soundForEvent(eventName);
    if (s) {
      const repoRoot = findCoordRoot(process.cwd());
      if (repoRoot) {
        let sid = "";
        try {
          const j = JSON.parse(raw) as { session_id?: string; conversation_id?: string };
          sid = j.session_id ?? j.conversation_id ?? "";
        } catch {
          // non-JSON payload: play unkeyed (rate-limit just won't dedup)
        }
        playSound(repoRoot, s.sound, sid, s.maxPlays);
      }
    }
  }

  // Kill switch. Disables every effect of
  // agent-hook + agent-coord: no event emit, no projection, no systemMessage,
  // no G-guard verdict. Used for the cross-client `HARNERY_AGENT_COORD_OFF=1`
  // bypass during incident triage.
  if (coordEnv("AGENT_COORD_OFF") === "1") return 0;

  const coordRoot = findCoordRoot(process.cwd());
  if (!coordRoot) return 0;

  // Always log a breadcrumb, useful when an event_type maps to null or owner
  // resolution fails. Stays cheap (one append) and self-prunes via repo log
  // rotation policy.
  const debugBase = {
    ts: new Date().toISOString(),
    event_name: eventName,
    harness,
    extra_argv: extra,
    payload_bytes: raw.length,
    cwd: process.cwd(),
    pid: process.pid,
    ppid: process.ppid,
  };

  if (!eventName || !harness) {
    appendDebug(coordRoot, { ...debugBase, skipped: "missing-event-or-harness" });
    return 0;
  }

  const norm = normalizeEventName(eventName);
  if (!norm) {
    appendDebug(coordRoot, { ...debugBase, skipped: "non-canonical-event" });
    return 0;
  }

  const payload = parsePayload(raw, harness);
  const owner = resolveOwner({ payload: payload?.raw ?? null, coordRoot });
  if (!owner) {
    appendDebug(coordRoot, {
      ...debugBase,
      skipped: "no-owner-resolved",
      event_type: norm.event_type,
    });
    return 0;
  }

  const sessionId = payload?.session_id ?? payload?.conversation_id ?? owner.instance_id;

  const data = buildEventData(norm.event_type, {
    coordRoot,
    payload,
    raw,
    harness,
    instanceId: owner.instance_id,
  });

  const envelope = emit(coordRoot, {
    event_type: norm.event_type,
    instance_id: owner.instance_id,
    session_id: sessionId,
    parent_session_id: payload?.parent_session_id,
    turn_id: payload?.turn_id,
    parent_turn_id: payload?.parent_turn_id,
    harness,
    data,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  } as Parameters<typeof emit>[1]);

  appendDebug(coordRoot, {
    ...debugBase,
    event_type: norm.event_type,
    owner_source: owner.source,
    event_id: envelope.event_id,
  });

  // Phase 8: SessionStart post-emit: project the event so the heartbeat
  // lands synchronously, run stale-sweep, and emit the harness-shaped
  // systemMessage JSON (peer table + wiring check + council invites).
  // Harness-agnostic since v0.5.0; replaces the previous bash UX layer
  // and the equivalent per-harness bash session_start handlers.
  if (norm.event_type === "session.start") {
    // Effect (claude-code): prune stale scratch archives + sweep orphans.
    // The recovery-cue is merged into the
    // session-start additionalContext inside emitSessionStartSystemMessage.
    if (harness === "claude-code") scratchJanitor(coordRoot);
    // Image-feed retention sweep (size + age cap on .harnery/images/). Harness-
    // agnostic, cheap (one readdir), fail-soft. Paired with scratchJanitor as a
    // session-start "tidy the coord layer" step.
    try {
      imageJanitor(coordRoot);
    } catch (err) {
      logError(coordRoot, err, { phase: "session-start-image-janitor" });
    }
    try {
      await emitSessionStartSystemMessage(coordRoot, owner.instance_id, sessionId, data, harness);
    } catch (err) {
      logError(coordRoot, err, { phase: "session-start-systemMessage" });
    }
  }

  // Phase 8: SessionEnd cleanup: delete heartbeat + pid-map rows. Harness-
  // agnostic since v0.5.0.
  if (norm.event_type === "session.end") {
    try {
      cleanupSessionEnd(coordRoot, owner.instance_id, (data.reason as string) ?? "unknown");
    } catch (err) {
      logError(coordRoot, err, { phase: "session-end-cleanup" });
    }
    // Effects (claude-code): archive the ending agent's scratchpad + force a
    // session-telemetry sync (via HARNERY_CLAUDE_SESSIONS_FORCE=1).
    if (harness === "claude-code") {
      scratchArchive(coordRoot, owner.instance_id);
      runSessionSyncExtension(coordRoot, true);
    }
  }

  // Phase 8: SubagentStart: sync-project to create the subagent heartbeat,
  // log the lifecycle event, and emit a context message announcing the
  // subagent (claude-code + cursor; codex doesn't fan out subagents today).
  if (norm.event_type === "subagent.start") {
    try {
      const agentCoordBin = join(coordRoot, "harnery", "bin", "agent-coord");
      if (existsSync(agentCoordBin)) {
        spawnSync(agentCoordBin, ["project"], { encoding: "utf8", timeout: 3000 });
        spawnSync(
          agentCoordBin,
          [
            "log",
            `SUBAGENT_START  agent_type=${(data.agent_type as string) ?? "unknown"} agent_id=${owner.instance_id.slice(0, 8)} platform=${harnessPlatform(harness)}`,
            "--instance",
            owner.instance_id,
          ],
          { encoding: "utf8", timeout: 2000 },
        );
      }
      emitSubagentStartContext(coordRoot, owner.instance_id, sessionId, data, harness);
    } catch (err) {
      logError(coordRoot, err, { phase: "subagent-start-project" });
    }
  }

  // Phase 8: SubagentStop: delete subagent heartbeat + log.
  if (norm.event_type === "subagent.stop") {
    try {
      cleanupSessionEnd(coordRoot, owner.instance_id, (data.reason as string) ?? "unknown");
      const agentCoordBin = join(coordRoot, "harnery", "bin", "agent-coord");
      if (existsSync(agentCoordBin)) {
        spawnSync(
          agentCoordBin,
          [
            "log",
            `SUBAGENT_STOP   agent_id=${owner.instance_id.slice(0, 8)} platform=${harnessPlatform(harness)}`,
            "--instance",
            owner.instance_id,
          ],
          { encoding: "utf8", timeout: 2000 },
        );
      }
    } catch (err) {
      logError(coordRoot, err, { phase: "subagent-stop-cleanup" });
    }
  }

  // Phase 8: UserPromptSubmit: render dedup'd peer table + council pending
  // and emit the harness-shaped systemMessage JSON. Harness-agnostic since v0.5.0.
  if (norm.event_type === "user_prompt.submit") {
    // Effects (claude-code): reset per-turn sound rate-limit counters + run
    // presence detection on the prompt.
    if (harness === "claude-code") {
      resetSoundCounters(sessionId);
      const prompt = (payload?.raw?.prompt as string | undefined) ?? "";
      if (prompt) detectPresence(prompt);
    }
    try {
      await emitUserPromptSubmitSystemMessage(coordRoot, owner.instance_id, sessionId, harness);
    } catch (err) {
      logError(coordRoot, err, { phase: "user-prompt-submit-systemMessage" });
    }
  }

  // turn.stop: telemetry + turn-summary effects, then the stop verdict. The
  // verdict + codex-replay previously lived in the per-harness shell adapters;
  // agent-hook owns them now. Runs on the normal "stop" event only;
  // "stop-failure" (API error) gets no gate, matching the previous
  // stop vs stop-failure split.
  if (norm.event_type === "turn.stop" && eventName === "stop") {
    // Codex: replay the JSONL transcript → canonical events so the verdict has
    // the status_checked / task_set / status_box_present evidence (codex
    // doesn't emit those live; this re-emits turn.stop after agent-hook's own,
    // so the verdict reads the replay's box signal as the latest).
    if (harness === "codex" && payload?.transcript_path && existsSync(payload.transcript_path)) {
      try {
        replayCodexJsonl({
          coordRoot,
          jsonlPath: payload.transcript_path,
          sessionId,
          instanceId: owner.instance_id,
          lastAssistantMessage: (payload.raw.last_assistant_message as string | undefined) ?? "",
        });
      } catch (err) {
        logError(coordRoot, err, { phase: "codex-replay" });
      }
    }

    // CC effects: rate-limited session-telemetry sync + turn-summary Haiku
    // auto-summary.
    if (harness === "claude-code") {
      runSessionSyncExtension(coordRoot, false);
      runTurnSummary(coordRoot, owner.instance_id, sessionId, payload?.transcript_path);
    }

    // Master-state heartbeat projection. Drains events.ndjson since the last
    // cursor → per-owner heartbeats. Was a SECOND binary (`agent-coord project`)
    // pinned to Claude Code Stop only; folded in here so it (a) is one
    // entry per event like everything else and (b) fires on EVERY harness's stop,
    // not just CC. Runs unconditionally before the verdict's possible exit-2 return
    // (the events are real regardless of whether the agent gets nagged), and after
    // codex-replay above so codex's replayed events are included in the drain.
    // Not an emitter (consumes + writes heartbeats), so no emitter/consumer conflict.
    try {
      const result = consumeSince(coordRoot);
      projectHeartbeats(coordRoot, result.events);
      if (result.lastEventId) writeCursor(coordRoot, result.lastEventId);
    } catch (err) {
      logError(coordRoot, err, { phase: "stop-projection" });
    }

    // Stop verdict (status-box + set-task gate). Direct in-process call: the
    // rule lives in harnery. agent-hook already emitted this turn.stop (with
    // status_box_present) above, so the evidence is in the stream.
    const verdict = evaluateStopHook(coordRoot, {
      rule: "stop-hook",
      instance_id: owner.instance_id,
      session_id: sessionId,
      harness,
      bypass: coordEnv("AGENT_COORD_BYPASS_STOP") === "1",
    });
    if (!verdict.allow) {
      // Harness-aware enforcement channel: Claude Code / Codex honor exit-2 +
      // stderr as a turn block; Cursor ignores exit codes (fail-open) and
      // re-prompts only via a `followup_message` it auto-submits. emitStopBlock
      // writes the right shape and returns the exit code to use.
      const { emitStopBlock } = await import("./harness/output.ts");
      return emitStopBlock(harness, verdict);
    }
  }

  // Phase 7: PreToolUse: heartbeat + pid-map self-heal on every tool call.
  // Harness-agnostic: both writes have the same shape regardless of who fired.
  // Cursor/Codex bash dispatchers still fire their own G-guard logic, but the
  // heals here keep the agent-coord layer's view of liveness fresh.
  //
  // The heartbeat + pid-map heals are paired by design; they were wired
  // side-by-side in the previous pre-tool-use adapter. The Phase 4-6 refactor
  // preserved the heartbeat half but dropped the pid-map half; the pid-map
  // call was restored here afterward.
  if (norm.event_type === "tool.pre_use") {
    try {
      healHeartbeatViaCli(coordRoot, owner.instance_id, sessionId, harness);
      refreshPidmap(coordRoot, owner.instance_id, harness, payload?.pid);
    } catch (err) {
      logError(coordRoot, err, { phase: "pre-tool-use-heal" });
    }

    // Image feed: a Read on an image file is the "agent viewed this" signal.
    // Capture the bytes (content-addressed, dedup'd) + emit image.captured.
    try {
      captureImages(coordRoot, {
        eventType: "tool.pre_use",
        data,
        payload,
        instanceId: owner.instance_id,
        sessionId,
        harness,
      });
    } catch (err) {
      logError(coordRoot, err, { phase: "pre-tool-use-image-capture" });
    }

    // G-guard for ALL harnesses. Claude Code previously ran this via a
    // pre-tool-use bash adapter (which called `agent-coord verdict --rule=claim`);
    // that adapter is now deleted, so agent-hook owns the deny for every harness.
    // emitDeny() inside emits the harness-shaped permission JSON (claude-code +
    // codex use hookSpecificOutput.permissionDecision; cursor uses .permission).
    // apply_patch (codex) parses paths from the patch body and runs verdict
    // per-path; Edit/Write/NotebookEdit resolve a single target. Non-write tools
    // (incl. Agent) yield no targets and pass through with no deny.
    try {
      await runPreToolUseGuard(coordRoot, owner.instance_id, sessionId, data, harness);
    } catch (err) {
      logError(coordRoot, err, { phase: "pre-tool-use-guard" });
    }

    // Shell-mutation warn (warn-only, never blocks). Was the cursor
    // beforeShellExecution + codex preToolUse-Bash shell-mutation-claim-log in
    // the per-harness shell adapters. Cursor sends the command at payload.command;
    // codex Bash at tool_input.command. Emits a decision.warn per candidate-mutated
    // path so a peer sees the write in events.ndjson. (CC never did this,
    // preserved; it emits with its own hooks-side emitter per the
    // independent-emitter rule.)
    const shellCmd =
      eventName === "before-shell-execution"
        ? ((payload?.raw.command as string | undefined) ?? "")
        : harness === "codex" && data.tool_name === "Bash"
          ? (((payload?.raw.tool_input as Record<string, unknown> | undefined)?.command as
              | string
              | undefined) ?? "")
          : "";
    if (shellCmd) {
      try {
        const paths = shellMutationPaths(shellCmd, coordRoot);
        const truncated = shellCmd.length > 80 ? shellCmd.slice(0, 80) : shellCmd;
        const platform = harnessPlatform(harness);
        for (const p of paths) {
          emit(coordRoot, {
            event_type: "decision.warn",
            instance_id: owner.instance_id,
            session_id: sessionId,
            harness,
            data: {
              rule: "shell_mutation_candidate",
              reason: `path=${p} cmd=${truncated} platform=${platform}`,
            },
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          } as Parameters<typeof emit>[1]);
        }
      } catch (err) {
        logError(coordRoot, err, { phase: "shell-mutation-warn" });
      }
    }
  }

  // Phase 7: PostToolUse: stamp last_tool + last_tool_target on heartbeat.
  // Harness-agnostic for the same reason as tool.pre_use above.
  if (norm.event_type === "tool.post_use") {
    try {
      stampToolActivity(coordRoot, owner.instance_id, data);
    } catch (err) {
      logError(coordRoot, err, { phase: "post-tool-use-stamp" });
    }

    // Image feed: a Bash command that wrote an image (harn browse, harn image,
    // --diff, …) is the "agent produced this" signal. Scan the command + its
    // output for freshly-written image paths and capture them.
    try {
      captureImages(coordRoot, {
        eventType: "tool.post_use",
        data,
        payload,
        instanceId: owner.instance_id,
        sessionId,
        harness,
      });
    } catch (err) {
      logError(coordRoot, err, { phase: "post-tool-use-image-capture" });
    }
  }

  // Phase 7: PostToolUseFailure: release claim on failed Edit (the file
  // never landed; the claim is stale). Harness-agnostic.
  if (norm.event_type === "tool.post_use_failure") {
    try {
      releaseClaimOnFailure(coordRoot, owner.instance_id, data, payload?.raw);
    } catch (err) {
      logError(coordRoot, err, { phase: "post-tool-use-failure-release" });
    }
  }

  return 0;
}

async function runPreToolUseGuard(
  coordRoot: string,
  instanceId: string,
  sessionId: string,
  data: Record<string, unknown>,
  harness: Harness,
): Promise<void> {
  const toolName = (data.tool_name as string | undefined) ?? "";
  const targets = collectGuardTargets(toolName, data)
    .map((p) => canonicalize(coordRoot, p))
    .filter((p): p is string => p !== null);
  if (targets.length === 0) return;

  const agentCoordBin = join(coordRoot, "harnery", "bin", "agent-coord");
  if (!existsSync(agentCoordBin)) return;

  // For apply_patch (multi-file), collect siblings so the deny reason names
  // them. For single-file tools the array has one entry.
  for (const target of targets) {
    const verdictReq = JSON.stringify({
      rule: "claim",
      instance_id: instanceId,
      session_id: sessionId,
      path: target,
    });
    const result = spawnSync(agentCoordBin, ["verdict"], {
      input: verdictReq,
      encoding: "utf8",
      timeout: 3000,
    });
    if (result.status !== 0 || !result.stdout) continue;
    let parsed: { allow?: boolean; reason?: string } = {};
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      continue;
    }
    if (parsed.allow === false) {
      let reason = parsed.reason ?? `Path ${target} is currently being edited by another agent.`;
      if (targets.length > 1) {
        const siblings = targets
          .filter((p) => p !== target)
          .slice(0, 3)
          .join(", ");
        if (siblings) {
          reason += ` The patch also touched: ${siblings}: pick a different file or wait.`;
        }
      }
      const { emitDeny } = await import("./harness/output.ts");
      emitDeny(harness, reason);
      return;
    }
  }
}

/** Canonicalize a path to monorepo-relative form. Absolute paths under
 * coordRoot get the prefix stripped; relative paths pass through (assumed
 * already canonical). */
/** Pull the candidate path(s) out of a write-tool payload. Empty array when
 * the tool isn't a write or no path could be derived. */
function collectGuardTargets(toolName: string, data: Record<string, unknown>): string[] {
  const writeTools = new Set(["Edit", "Write", "NotebookEdit", "StrReplace"]);
  if (writeTools.has(toolName)) {
    const target = extractFilePathFromData(data);
    return target ? [target] : [];
  }
  if (toolName === "apply_patch") {
    return parseApplyPatchPaths(data);
  }
  return [];
}

function extractFilePathFromData(data: Record<string, unknown>): string | undefined {
  const raw = data.tool_input;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return (
      (parsed.file_path as string | undefined) ??
      (parsed.path as string | undefined) ??
      (parsed.notebook_path as string | undefined) ??
      undefined
    );
  } catch {
    return undefined;
  }
}

/** Parse Codex's `apply_patch` body for `*** Add|Update|Delete File: <path>`
 * directives. Extracts apply_patch target paths for Codex. */
function parseApplyPatchPaths(data: Record<string, unknown>): string[] {
  const raw = data.tool_input;
  if (typeof raw !== "string") return [];
  let body = "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    body = (parsed.command as string | undefined) ?? "";
  } catch {
    return [];
  }
  if (!body) return [];
  const out: string[] = [];
  const re = /^\s*\*\*\* (Add|Update|Delete) File:\s*(.+)$/gm;
  let m: RegExpExecArray | null = re.exec(body);
  while (m !== null) {
    out.push(m[2]!.trim());
    m = re.exec(body);
  }
  return out;
}

function healHeartbeatViaCli(
  coordRoot: string,
  instanceId: string,
  sessionId: string,
  harness: string,
): void {
  const agentCoordBin = join(coordRoot, "harnery", "bin", "agent-coord");
  if (!existsSync(agentCoordBin)) return;
  // Pass the detected harness so a pruned Cursor/Codex heartbeat is recreated
  // with the correct platform; without it, healHeartbeat defaults to
  // claude_code and the dashboard mislabels the agent. See
  // heartbeat-writer.healHeartbeat.
  spawnSync(agentCoordBin, ["heal-heartbeat", instanceId, sessionId, `--harness=${harness}`], {
    encoding: "utf8",
    timeout: 2000,
  });
}

/**
 * Walk up the ppid chain on Linux/WSL looking for the harness anchor PID,
 * the PID of the claude / cursor / codex binary. Finds the agent PID. Used by
 * `tool.pre_use`'s pid-map self-heal so a re-parented harness binary (the
 * VS Code 2.1.x sibling-claude spawn case) gets its pid-map row rewritten on
 * the next tool call rather than going invisible until SessionStart fires
 * again, which it may never do.
 *
 * Returns undefined only when no anchor is found; callers fall back to
 * `process.ppid` (the bash wrapper's parent, which is usually the harness binary
 * itself). `HARNERY_AGENT_COORD_TEST_ANCHOR_PID` overrides everything so the
 * test sandbox can pin a deterministic PID.
 */
function findHarnessAnchorPid(harness?: Harness): number | undefined {
  const override = coordEnv("AGENT_COORD_TEST_ANCHOR_PID");
  if (override) {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Build the ppid chain (nearest → root, up to 20 hops), then hand it to the
  // pure selector. Linux/WSL reads /proc; macOS/BSD (no /proc) falls back to
  // `ps -o ppid=,comm=` parsed by the unit-tested `parsePsChainLine`. Splitting
  // the walk (untestable off a live box) from the comm-matching keeps the
  // cursor `node`-fallback logic verifiable.
  const chain: Array<{ pid: number; comm: string }> = [];
  let pid = process.pid;
  for (let hops = 0; hops < 20; hops++) {
    let hop: { comm: string; ppid: number } | null = null;
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const m = status.match(/^PPid:\s+(\d+)/m);
      hop = { comm, ppid: m ? Number(m[1]) : 0 };
    } catch {
      // no /proc (macOS/BSD) — fall through to ps
    }
    if (!hop) {
      const out = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
      if (out.status === 0) hop = parsePsChainLine(out.stdout);
    }
    if (!hop) break;
    chain.push({ pid, comm: hop.comm });
    if (!Number.isFinite(hop.ppid) || hop.ppid === 0 || hop.ppid === 1) break;
    pid = hop.ppid;
  }
  return selectAnchorPid(chain, harness);
}

/**
 * Pid-map self-heal for `tool.pre_use`. Symmetric counterpart to
 * `healHeartbeatViaCli`; the two were paired before the Phase 6 refactor split
 * them apart, then restored together afterward.
 *
 * The pid argument prefers the payload's `pid` (CC populates it on
 * SessionStart and may also send it on PreToolUse), then
 * `findHarnessAnchorPid`, then `process.ppid`. Writes go through the same
 * idempotent `writePidmapViaAgentCoord` helper that SessionStart uses: no
 * disk I/O on no-op heals (when the row already points at us).
 *
 * Follow-up: emit `PIDMAP_HEAL` telemetry on actual writes to keep
 * `harn agents heal-events` pidmap counts meaningful. The inline helper does
 * not yet.
 */
function refreshPidmap(
  coordRoot: string,
  instanceId: string,
  harness: Harness,
  payloadPid?: number,
): void {
  const pid = payloadPid ?? findHarnessAnchorPid(harness) ?? process.ppid;
  if (!Number.isFinite(pid) || pid <= 0) return;
  writePidmapViaAgentCoord(coordRoot, pid, instanceId, harnessPlatform(harness));
}

function stampToolActivity(
  coordRoot: string,
  instanceId: string,
  data: Record<string, unknown>,
): void {
  const agentCoordBin = join(coordRoot, "harnery", "bin", "agent-coord");
  if (!existsSync(agentCoordBin)) return;
  const toolName = (data.tool_name as string | undefined) ?? "";
  // Extract a 1-line target from the tool_input blob (file path / command head).
  const toolInputRaw = data.tool_input;
  let target = "";
  if (typeof toolInputRaw === "string") {
    try {
      const parsed = JSON.parse(toolInputRaw) as Record<string, unknown>;
      target =
        (parsed.file_path as string | undefined) ??
        (parsed.path as string | undefined) ??
        (parsed.notebook_path as string | undefined) ??
        (parsed.command as string | undefined) ??
        (parsed.url as string | undefined) ??
        (parsed.pattern as string | undefined) ??
        "";
    } catch {
      /* skip */
    }
  }
  if (target.length > 200) target = target.slice(0, 200);
  spawnSync(agentCoordBin, ["stamp-tool-activity", instanceId, toolName, target], {
    encoding: "utf8",
    timeout: 2000,
  });
}

function releaseClaimOnFailure(
  coordRoot: string,
  instanceId: string,
  data: Record<string, unknown>,
  rawPayload: Record<string, unknown> | undefined,
): void {
  const toolName = (data.tool_name as string | undefined) ?? "";
  if (toolName !== "Edit" && toolName !== "Write" && toolName !== "NotebookEdit") return;
  // Path is in tool_input parsed from payload; try data first, fall back to raw.
  const toolInputRaw = data.tool_input;
  let filePath = "";
  if (typeof toolInputRaw === "string") {
    try {
      const parsed = JSON.parse(toolInputRaw) as Record<string, unknown>;
      filePath =
        (parsed.file_path as string | undefined) ??
        (parsed.path as string | undefined) ??
        (parsed.notebook_path as string | undefined) ??
        "";
    } catch {
      /* skip */
    }
  }
  if (!filePath && rawPayload) {
    const ti = rawPayload.tool_input as Record<string, unknown> | undefined;
    if (ti) {
      filePath =
        (ti.file_path as string | undefined) ??
        (ti.path as string | undefined) ??
        (ti.notebook_path as string | undefined) ??
        "";
    }
  }
  if (!filePath) return;

  // Canonicalize path relative to coordRoot
  let canonical = filePath;
  if (filePath.startsWith("/")) {
    canonical = filePath.startsWith(`${coordRoot}/`)
      ? filePath.slice(coordRoot.length + 1)
      : filePath;
  }

  const agentCoordBin = join(coordRoot, "harnery", "bin", "agent-coord");
  if (!existsSync(agentCoordBin)) return;
  spawnSync(agentCoordBin, ["release-claim", instanceId, canonical], {
    encoding: "utf8",
    timeout: 2000,
  });
}

function cleanupSessionEnd(coordRoot: string, instanceId: string, reason: string): void {
  // Remove heartbeat from the canonical .harnery/active/ dir.
  const path = join(coordRoot, ".harnery", "active", `${instanceId}.json`);
  try {
    if (existsSync(path)) {
      require("node:fs").unlinkSync(path);
    }
  } catch {
    /* swallow */
  }
  // Sweep pid-map entries pointing to this instance
  const pidmapDir = join(coordRoot, ".harnery", "pid-map");
  if (existsSync(pidmapDir)) {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      for (const f of fs.readdirSync(pidmapDir)) {
        const rowPath = join(pidmapDir, f);
        try {
          const row = fs.readFileSync(rowPath, "utf8").trim();
          const ownerCol = row.split("\t")[0]?.trim() ?? "";
          if (ownerCol === instanceId) {
            fs.unlinkSync(rowPath);
          }
        } catch {
          /* swallow */
        }
      }
    } catch {
      /* swallow */
    }
  }
  // Activity log
  const agentCoordBin = join(coordRoot, "harnery", "bin", "agent-coord");
  if (existsSync(agentCoordBin)) {
    spawnSync(
      agentCoordBin,
      ["log", `SESSION_END     reason=${reason}`, "--instance", instanceId],
      { encoding: "utf8", timeout: 2000 },
    );
  }
}

async function emitUserPromptSubmitSystemMessage(
  coordRoot: string,
  instanceId: string,
  sessionId: string,
  harness: Harness,
): Promise<void> {
  const agentCoordBin = join(coordRoot, "harnery", "bin", "agent-coord");
  if (!existsSync(agentCoordBin)) return;

  // Look up the agent's name from its heartbeat (for council pending rendering).
  let agentName = "";
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const hbPath = join(coordRoot, ".harnery", "active", `${instanceId}.json`);
    if (fs.existsSync(hbPath)) {
      const hb = JSON.parse(fs.readFileSync(hbPath, "utf8")) as { name?: string };
      agentName = hb.name ?? "";
    }
  } catch {
    /* fall through with empty name; peer table still renders */
  }

  const args = ["prompt-context", "--instance", instanceId, "--session", sessionId];
  if (agentName) args.push("--name", agentName);
  // Cursor + Codex sessions get the set-task staleness nudge. CC enforces it
  // via the Stop-hook transcript scan; the nudge replaces that for harnesses
  // that don't reliably expose a transcript_path during stop.
  if (harness === "cursor" || harness === "codex") args.push("--task-nudge");
  const result = spawnSync(agentCoordBin, args, { encoding: "utf8", timeout: 3000 });
  if (result.status !== 0 || !result.stdout) return;
  const additionalContext = result.stdout.trim();
  if (!additionalContext) return;

  const { emitContext } = await import("./harness/output.ts");
  emitContext(harness, "UserPromptSubmit", additionalContext);
}

function emitSubagentStartContext(
  coordRoot: string,
  instanceId: string,
  sessionId: string,
  data: Record<string, unknown>,
  harness: Harness,
): void {
  // Look up the subagent's assigned name (just-written by agent-coord assignName
  // in session.start data) + the parent's short id for the "you are a subagent
  // of X" framing.
  const subagentName = (data.name as string | undefined) ?? "";
  if (!subagentName) return;
  const platformLabel = harnessPlatform(harness);
  const parentShort =
    sessionId && sessionId !== instanceId ? `agent-${sessionId.slice(0, 8)}` : "the parent session";
  const message = `You are agent-${subagentName} (${platformLabel} subagent). You're a subagent of ${parentShort}.`;

  // Render peer table inline since the subagent might want to know who else
  // is around. Reuse prompt-context (which dedups against the per-owner hash);
  // first call will always emit.
  const agentCoordBin = join(coordRoot, "harnery", "bin", "agent-coord");
  let combined = message;
  if (existsSync(agentCoordBin)) {
    const result = spawnSync(
      agentCoordBin,
      ["prompt-context", "--instance", instanceId, "--session", sessionId, "--name", subagentName],
      { encoding: "utf8", timeout: 3000 },
    );
    const ctx = (result.stdout ?? "").trim();
    if (ctx) combined = `${message}\n\n${ctx}`;
  }

  // Use SubagentStart event-name in CC's hookSpecificOutput shape; cursor's
  // flat `additional_context` works the same way.
  void import("./harness/output.ts").then(({ emitContext }) => {
    emitContext(harness, "SubagentStart", combined);
  });
}

function harnessPlatform(harness: Harness): string {
  if (harness === "claude-code") return "claude_code";
  return harness;
}

async function emitSessionStartSystemMessage(
  coordRoot: string,
  instanceId: string,
  sessionId: string,
  emittedData: Record<string, unknown>,
  harness: Harness,
): Promise<void> {
  const agentCoordBin = join(coordRoot, "harnery", "bin", "agent-coord");
  if (!existsSync(agentCoordBin)) return;

  // Sync-project so the heartbeat exists for downstream readers (peer table,
  // wiring check, council invites).
  spawnSync(agentCoordBin, ["project"], { encoding: "utf8", timeout: 3000 });
  // Stale-sweep dead peers before rendering peer table.
  spawnSync(agentCoordBin, ["stale-sweep"], { encoding: "utf8", timeout: 3000 });

  // SESSION_START activity log line, fired across all harnesses.
  const model = (emittedData.model as string | undefined) ?? "unknown";
  const source = (emittedData.source as string | undefined) ?? "startup";
  const platform = harnessPlatform(harness);
  spawnSync(
    agentCoordBin,
    [
      "log",
      `SESSION_START   model=${model} source=${source} platform=${platform}`,
      "--instance",
      instanceId,
    ],
    { encoding: "utf8", timeout: 2000 },
  );

  // Render the systemMessage via agent-coord.
  const agentName = (emittedData.name as string | undefined) ?? "";
  const args = ["session-context", "--instance", instanceId, "--session", sessionId];
  if (agentName) args.push("--name", agentName);
  // The "You are agent-X." prefix in session-context renders unqualified by
  // default (claude-code-style). For cursor/codex the bash dispatchers add
  // a "(Cursor)" / "(Codex)" suffix; pass it through as --platform-label.
  if (harness !== "claude-code") {
    args.push("--platform-label", platform === "cursor" ? "Cursor" : "Codex");
  }
  const result = spawnSync(agentCoordBin, args, { encoding: "utf8", timeout: 3000 });
  if (result.status !== 0 || !result.stdout) return;
  let additionalContext = result.stdout.trim();
  if (!additionalContext) return;

  // Effect (claude-code): merge the scratch recovery cue into the session-start
  // context. Was a standalone additionalContext emission from the previous
  // scratch-on-start adapter; now that agent-hook is the single SessionStart
  // entry, it folds in here.
  if (harness === "claude-code") {
    const cue = scratchRecoveryCue(coordRoot);
    if (cue) additionalContext = `${additionalContext}\n\n${cue}`;
  }

  const { emitContext } = await import("./harness/output.ts");
  emitContext(harness, "SessionStart", additionalContext);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logError(findCoordRoot(process.cwd()), err, {
      argv: process.argv.slice(2),
      pid: process.pid,
    });
    process.exit(0);
  });
