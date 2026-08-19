/**
 * `agent-hook` CLI entry point for canonical event emission.
 *
 * Flow:
 *   1. Parse argv → event-name + adapter.
 *   2. Read stdin → adapter payload (JSON or empty).
 *   3. Find coord root (walk up for .harnery/).
 *   4. Resolve instance_id (env → payload → pid-map walk).
 *   5. Map event-name → canonical event_type.
 *   6. Build event data from payload + resolvers (intent, transcript scan).
 *   7. Record the normalized observation in the canonical V3 ledger.
 *   8. (Still also writes a debug breadcrumb to .harnery/debug/ for visibility.)
 *
 * Phase 2 ship criterion: confirms parser correctness across thousands of
 * real events without affecting behavior. Always exits 0. Failures land in
 * `.harnery/debug/agent-hook.errors.ndjson` for audit but never break the
 * adapter flow.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { coordEnv } from "../../lib/env.ts";
import { buildInstructionBundle } from "../../lib/instructions/bundle.ts";
import type { Adapter } from "../adapter.ts";
import { coordBinPath } from "../agents/coord-bin.ts";
import {
  type ClaimFinalizationDecision,
  type ClaimFinalizationDescriptor,
  classifyWriteClaimFinalization,
  formatWriteClaimFinalizationDenial,
} from "../agents/finalization.ts";
import { evaluateStopHook } from "../agents/rules/stop-hook.ts";
import { readLiveCoordinationRow } from "../agents/state/live-coordination-view.ts";
import { writePidmapRow } from "../agents/state/pidmap.ts";
import { agentsRequireGitFinalization, resolveBinName } from "../config.ts";
import {
  checkpointContext,
  completeContextRecovery,
  extractContextSample,
  markContextCompactionCompleted,
  type PreparedContextRecovery,
  prepareContextRecovery,
  readContextState,
  recordContextSample,
} from "../context/index.ts";
import { tryWriteLiveDisplayV3 } from "../events/v3/live-feed.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import { captureSpanClockV3 } from "../events/v3/span-state.ts";
import { fetchPresence } from "../presence/index.ts";
import { stableScopeId } from "../workflow/scope-id.ts";
import { detectAdapter, shouldSkipHookAdapter } from "./adapter/detect.ts";
import {
  extractBashCommand,
  extractToolDescription,
  type NormalizedEventType,
  normalizeEventName,
  type ParsedPayload,
  parsePayload,
} from "./adapter/parse.ts";
import {
  codexWslFileLinkTelemetry,
  inspectCodexWslBridge,
  isWslUncPath,
  renderCodexWslFileLinkContext,
} from "./codex-wsl-bridge.ts";
import {
  captureImages,
  detectPresence,
  imageJanitor,
  journalArchive,
  journalJanitor,
  journalRecoveryCue,
  playSound,
  recordImageArtifactsV3,
  resetSoundCounters,
  runSessionSyncExtension,
  soundForEvent,
} from "./effects/index.ts";
import { toolInputHash, toolTargetHash } from "./events/input-hash.ts";
import { canonicalize } from "./guard-path.ts";
import { adapterPidFromEnv, parsePsChainLine, selectAnchorPid } from "./resolve/anchor.ts";
import { findCoordRoot } from "./resolve/coord-root.ts";
import { extractIntentComment, resolveIntent } from "./resolve/intent.ts";
import { resolveOwner } from "./resolve/owner.ts";
import {
  scanAssistantTextIncludes,
  scanStatusBoxPresent,
  scanTranscriptModel,
} from "./resolve/transcript.ts";
import { sessionNamePresence } from "./session-name-presence.ts";
import { unsafeCrossShellReason } from "./unsafe-cross-shell.ts";

interface Argv {
  eventName: string | null;
  extra: string[];
}

function parseArgv(argv: string[]): Argv {
  const out: Argv = { eventName: null, extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--adapter") {
      i++; // detectAdapter will re-parse; just consume the value here.
      continue;
    }
    if (arg.startsWith("--adapter=")) continue;
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

/**
 * Env for child agent-coord spawns, with the coord root pinned. The hook
 * process may be running with the session shell's cwd (inside a submodule or
 * journal dir), and agent-coord resolves its root from cwd unless overridden —
 * without the pin a child could write state to a different .harnery than the
 * one this hook resolved.
 */
function childEnv(coordRoot: string): NodeJS.ProcessEnv {
  return { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: coordRoot };
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
 * session.started emission never breaks the adapter flow.
 *
 * Lives at agent-hooks side (not agent-coord) to keep emitter/consumer
 * separation: we spawn rather than import.
 */
function assignNameViaAgentCoord(
  coordRoot: string,
  instanceId: string,
  kind: "session" | "subagent" | "transient",
  forkedFrom?: string,
): { name: string; kind: string } | null {
  const binary = coordBinPath("agent-coord", coordRoot) ?? "";
  if (!existsSync(binary)) return null;
  try {
    const args = ["assign-name", instanceId, kind];
    if (forkedFrom) args.push("--forked-from", forkedFrom);
    const result = spawnSync(binary, args, {
      encoding: "utf8",
      timeout: 2000,
      env: childEnv(coordRoot),
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
 * Direct (in-process) pidmap write, avoiding the spawn overhead of going via
 * the agent-coord CLI for every session.started signal. Pid-map rows
 * are essential for `harn agents whoami` ppid resolution.
 *
 * This used to inline its own copy of the write to keep this module's
 * dependencies narrow, which quietly mattered: the shared writer is where row
 * hygiene lives, so the duplicate meant the only hot write path in the system
 * never swept dead rows, and the map grew unbounded. It calls the shared writer
 * now, and this module already imports from that directory anyway.
 */
function writePidmapViaAgentCoord(
  coordRoot: string,
  pid: number,
  instanceId: string,
  platform: string,
): void {
  try {
    writePidmapRow(coordRoot, pid, instanceId, platform);
  } catch {
    /* never break the adapter flow */
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
  adapter: Adapter;
  instanceId: string;
  eventName: string;
}

function buildEventData(
  eventType: NormalizedEventType,
  ctx: BuildContext,
): Record<string, unknown> {
  const p = ctx.payload;
  switch (eventType) {
    case "session.started": {
      const adapterPlatform =
        ctx.adapter === "claude-code"
          ? "claude-code"
          : ctx.adapter === "cursor"
            ? "cursor"
            : "codex";
      // Recorded fork lineage is NOT detected here. On claude-code a fork
      // never fires its own session.started — SessionStart fires under the
      // PARENT's session id (source=resume) before the fork id is minted
      // (verified 2026-08-05) — so detection at this point can only mislabel
      // the resumed parent. The fork's new instance is caught by the
      // tool.requested heal path instead. The forkedFrom plumbing below stays
      // for adapters that DO report a parent at session start.
      const forkedFrom: string | undefined = undefined;
      // Assign (or recover) name + kind via agent-coord. Idempotent: resume
      // returns the original name; new owner consumes a counter slot.
      const assigned = assignNameViaAgentCoord(
        ctx.coordRoot,
        ctx.instanceId,
        "session",
        forkedFrom,
      );
      // Write the adapter pid-map row so `harn agents whoami` ppid-walks find
      // this owner. Prefer the payload pid (the actual claude binary), then the
      // anchor walk (the `node` ancestor for Cursor, which has no payload pid),
      // then our own process.ppid. Without the anchor, Cursor anchored on the
      // ephemeral hook bash parent, a PID that dies before the agent's next
      // shell tool call, so the ppid walk found nothing (no_pidmap_entry).
      const adapterPid = p?.pid ?? findAdapterAnchorPid(ctx.adapter) ?? process.ppid;
      if (adapterPid) {
        writePidmapViaAgentCoord(ctx.coordRoot, adapterPid, ctx.instanceId, adapterPlatform);
      }
      const bundle = safeInstructionBundle(ctx.coordRoot, p?.cwd ?? process.cwd(), ctx.adapter);
      return {
        started_at: new Date().toISOString(),
        cwd: p?.cwd ?? process.cwd(),
        // Claude Code's SessionStart payload omits `model` (Codex + Cursor
        // supply it). Fall back to the transcript, populated on `resume`, and
        // backfilled later by `turn.completed` for a fresh startup session.
        model: p?.model ?? scanTranscriptModel(p?.transcript_path),
        pid: adapterPid,
        source: p?.source,
        platform: adapterPlatform,
        name: assigned?.name,
        kind: "session",
        agent_id: ctx.instanceId,
        ...(bundle
          ? {
              instruction_bundle_id: bundle.instruction_bundle_id,
              instruction_source_id: bundle.canonical_source_id,
              instruction_profile_root: bundle.profile_root,
              instruction_component_count: bundle.components.length,
            }
          : {}),
        // Recorded fork lineage rides the canonical event too, so full replay
        // and derived readers converge on the same parent linkage that
        // .name-history carries (the ADR 0017 dual-write pattern).
        ...(forkedFrom ? { forked_from: forkedFrom } : {}),
        // Workflow-child linkage: `workflow run` children carry the run id in
        // env (spawn adapters set it via buildChildEnv), so their sessions and
        // heartbeats join back to the run transcript + /workflows web view.
        ...(coordEnv("WORKFLOW_CHILD") === "1" && coordEnv("WORKFLOW_RUN_ID")
          ? {
              workflow_run_id: coordEnv("WORKFLOW_RUN_ID"),
              // Which agent row of that run this session is. The orchestrator
              // stamps it on the way in, because the adapter does not report a
              // session id until the agent has already finished.
              ...(coordEnv("WORKFLOW_AGENT_ID")
                ? { workflow_agent_id: coordEnv("WORKFLOW_AGENT_ID") }
                : {}),
            }
          : {}),
      };
    }

    case "session.ended":
      return {
        ended_at: new Date().toISOString(),
        clean_exit: p?.clean_exit ?? true,
      };

    case "turn.started": {
      // Cursor can deliver beforeSubmitPrompt before sessionStart. Ensure that
      // high-confidence prompt bootstrap also mints durable display identity;
      // a later SessionStart remains idempotent.
      if (
        ctx.adapter === "cursor" &&
        !readLiveCoordinationRow(ctx.coordRoot, ctx.instanceId)?.name
      ) {
        assignNameViaAgentCoord(ctx.coordRoot, ctx.instanceId, "session");
      }
      const prompt = p?.prompt ?? "";
      const { value, truncated } = clampString(prompt, 4000);
      return { prompt_text: value, ...(truncated ? { truncated: true } : {}) };
    }

    case "turn.completed": {
      const lastAssistantMessage = (p?.raw.last_assistant_message as string | undefined) ?? "";
      const fileLinkTelemetry =
        ctx.adapter === "codex"
          ? codexWslFileLinkTelemetry(ctx.coordRoot, p?.cwd, lastAssistantMessage)
          : null;
      return {
        // Backfill the model for adapters that omit it at session.started
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
        // the verdict now sees because agent-hook emits this turn.completed itself
        // (the previous path passed those via the no-history fail-open).
        status_box_present:
          scanStatusBoxPresent(p?.transcript_path) || lastAssistantMessage.includes("┌─ agent-"),
        // Shadow measurement for the rule-2/3 detector: the loose scan above
        // matches the box prefix ANYWHERE in the transcript tail, including
        // the tool_result row the status command itself writes, so it can
        // report a paste that never happened. The strict variant counts
        // assistant text only (same window, same scanner as the session-name
        // detection). Telemetry-only: the Stop verdict still reads
        // status_box_present. Once the divergence rate between the two fields
        // is known, the gate either flips to strict or the rule gets
        // reconsidered; either way this field decides it with data.
        status_box_present_strict:
          scanAssistantTextIncludes(p?.transcript_path, "┌─ agent-") ||
          lastAssistantMessage.includes("┌─ agent-"),
        // Whether the session's suggested name is satisfied as of this turn,
        // and which name that refers to. Reported on every stop while a name
        // exists (the stop-hook.session_name verdict reads it per turn); the
        // transcript scan itself stops once the name has been sighted.
        ...sessionNamePresence(ctx.coordRoot, ctx.instanceId, lastAssistantMessage, (name) =>
          scanAssistantTextIncludes(p?.transcript_path, name),
        ),
        ...(fileLinkTelemetry ?? {}),
        stop_hook_active: p?.stop_hook_active,
      };
    }

    case "agent.started": {
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

    case "agent.completed": {
      const status = p?.exit_status;
      const normalized: "ok" | "error" | "interrupted" =
        status === "error" || status === "interrupted" ? status : "ok";
      return { exit_status: normalized, reason: p?.reason };
    }

    case "tool.requested": {
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
        input_hash: toolInputHash(toolName, p?.tool_input ?? null),
        target_hash: toolTargetHash(toolName, p?.tool_input ?? null),
        intent,
        intent_source: source,
        tool_use_id: p?.tool_use_id,
        ...(clamped.truncated ? { truncated: true } : {}),
      };
    }

    case "wait.started": {
      const description = extractToolDescription(p?.tool_input);
      const reason = description ? clampString(description, 500).value : undefined;
      return {
        request_kind: "permission",
        tool_name: p?.tool_name,
        ...(reason ? { reason } : {}),
      };
    }

    case "tool.completed": {
      const toolName = p?.tool_name ?? "unknown";
      const summary = summarizeOutput(p?.tool_response);
      return ctx.eventName === "post-tool-use-failure"
        ? {
            tool_name: toolName,
            error: summary.summary,
            duration_ms: 0,
            tool_use_id: p?.tool_use_id,
            ...(summary.truncated ? { truncated: true } : {}),
          }
        : {
            tool_name: toolName,
            output_summary: summary.summary,
            exit_status: "ok" as const,
            duration_ms: 0,
            tool_use_id: p?.tool_use_id,
            ...(summary.truncated ? { truncated: true } : {}),
          };
    }

    case "context.compaction_started": {
      const metadata = objectRecord(p?.raw.compact_metadata);
      return {
        trigger: stringField(p?.raw.trigger) ?? stringField(metadata?.trigger),
        pre_tokens:
          numberField(p?.raw.pre_tokens) ??
          numberField(metadata?.pre_tokens) ??
          numberField(metadata?.pre_compact_tokens),
      };
    }

    case "context.compaction_completed": {
      const metadata = objectRecord(p?.raw.compact_metadata);
      return {
        trigger: stringField(p?.raw.trigger) ?? stringField(metadata?.trigger),
        pre_tokens:
          numberField(p?.raw.pre_tokens) ??
          numberField(metadata?.pre_tokens) ??
          numberField(metadata?.pre_compact_tokens),
        post_tokens:
          numberField(p?.raw.post_tokens) ??
          numberField(metadata?.post_tokens) ??
          numberField(metadata?.post_compact_tokens),
      };
    }
  }
}

function safeInstructionBundle(coordRoot: string, cwd: string, adapter: Adapter) {
  try {
    return buildInstructionBundle({ coordRoot, cwd, adapter });
  } catch (err) {
    logError(coordRoot, err, { phase: "instruction-bundle-identity" });
    return null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function main(): Promise<number> {
  const hookStartedAt = performance.now();
  const hookClock = captureSpanClockV3();
  const { eventName, extra } = parseArgv(process.argv.slice(2));
  const adapter = detectAdapter(process.argv.slice(2));
  const raw = await readStdin();

  // Cursor executes the Claude Code project hooks too on hosts wired for both
  // adapters, piping them its own payload (identifiable by the top-level
  // cursor_version envelope field). That stray `--adapter claude-code`
  // dispatch must not record (twin generation) or play Claude-Code-only
  // sounds, so it bails here, before every effect. Cursor's own
  // `--adapter cursor` dispatch of the same payload carries the session.
  if (shouldSkipHookAdapter(adapter, raw)) {
    if (coordEnv("AGENT_COORD_OFF") !== "1") {
      const coordRoot = findCoordRoot(process.cwd());
      if (coordRoot) {
        appendDebug(coordRoot, {
          ts: new Date().toISOString(),
          event_name: eventName,
          adapter,
          extra_argv: extra,
          payload_bytes: raw.length,
          cwd: process.cwd(),
          pid: process.pid,
          ppid: process.ppid,
          skipped: "cursor-payload-claude-adapter",
        });
      }
    }
    return 0;
  }

  // Kill-switch-INDEPENDENT effects: notification sounds fire BEFORE the
  // HARNERY_AGENT_COORD_OFF gate so audible feedback survives incident-triage
  // bypass: sound playback happens before the kill-switch bailout.
  // Claude-Code-only; stop-failure → error, sub-agent-start → subagent-start.
  if (adapter === "claude-code" && eventName) {
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
  const ledgerRoute = resolveLiveEventLedgerRouteV3(coordRoot);

  // Always log a breadcrumb, useful when an event_type maps to null or owner
  // resolution fails. Stays cheap (one append) and self-prunes via repo log
  // rotation policy.
  const debugBase = {
    ts: new Date().toISOString(),
    event_name: eventName,
    adapter,
    extra_argv: extra,
    payload_bytes: raw.length,
    cwd: process.cwd(),
    pid: process.pid,
    ppid: process.ppid,
  };

  if (!eventName || !adapter) {
    appendDebug(coordRoot, { ...debugBase, skipped: "missing-event-or-adapter" });
    return 0;
  }

  const norm = normalizeEventName(eventName);
  if (!norm) {
    appendDebug(coordRoot, { ...debugBase, skipped: "non-canonical-event" });
    return 0;
  }

  const payload = parsePayload(raw, adapter);
  const owner = resolveOwner({
    payload: payload?.raw ?? null,
    coordRoot,
  });
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
    adapter,
    instanceId: owner.instance_id,
    eventName,
  });

  if (ledgerRoute.state === "blocked") {
    appendDebug(coordRoot, {
      ...debugBase,
      skipped: "v3-control-blocked",
      reason: ledgerRoute.reason,
      event_type: norm.event_type,
      owner_source: owner.source,
    });
    return 0;
  }

  let capturedImages: ReturnType<typeof captureImages> = [];
  if (
    norm.event_type === "tool.requested" ||
    (norm.event_type === "tool.completed" && eventName === "post-tool-use")
  ) {
    try {
      capturedImages = captureImages(coordRoot, norm.event_type, payload);
    } catch (err) {
      logError(coordRoot, err, { phase: "image-capture" });
    }
  }

  const v3Result = recordLiveHookSignalV3({
    coordRoot,
    route: ledgerRoute,
    eventName,
    payload,
    adapter,
    instanceId: owner.instance_id,
    ...(coordEnv("WORKFLOW_CHILD") === "1" && coordEnv("WORKFLOW_RUN_ID")
      ? {
          run_id: stableScopeId("run", coordEnv("WORKFLOW_RUN_ID")!),
          workflow_id: stableScopeId("wf", coordEnv("WORKFLOW_RUN_ID")!),
          ...(coordEnv("WORKFLOW_AGENT_ID")
            ? { workflow_agent_id: coordEnv("WORKFLOW_AGENT_ID") }
            : {}),
        }
      : {}),
    ...(adapter === "codex" && isWslUncPath(payload?.cwd) ? { bridge: "codex-wsl" as const } : {}),
    hook_name: eventName,
    hook_duration_ms: Math.max(0, Math.floor(performance.now() - hookStartedAt)),
    monotonic_ns: hookClock.monotonic_ns,
  });
  const v3EventId =
    v3Result && "event" in v3Result
      ? v3Result.event.event_id
      : v3Result && "event_id" in v3Result
        ? v3Result.event_id
        : undefined;

  if (v3Result?.state === "recorded" && capturedImages.length > 0) {
    try {
      recordImageArtifactsV3(coordRoot, v3Result.event, capturedImages);
    } catch (err) {
      logError(coordRoot, err, { phase: "image-artifact-observation" });
    }
  }

  if (
    norm.event_type === "tool.requested" &&
    v3Result &&
    v3Result.state === "recorded" &&
    "generation_id" in v3Result.event.scope
  ) {
    const intent = typeof data.intent === "string" ? data.intent : undefined;
    if (intent && intent !== "(no intent)") {
      tryWriteLiveDisplayV3(coordRoot, {
        generation_id: v3Result.event.scope.generation_id,
        event_id: v3Result.event.event_id,
        ...(typeof data.tool_name === "string" ? { executable: data.tool_name } : {}),
        intent_display: intent,
      });
    }
  }

  appendDebug(coordRoot, {
    ...debugBase,
    event_type: norm.event_type,
    owner_source: owner.source,
    ...(v3EventId ? { event_v3_id: v3EventId } : {}),
    ...(v3Result ? { event_v3_state: v3Result.state } : {}),
    ...(v3Result && "reason" in v3Result ? { event_v3_reason: v3Result.reason } : {}),
  });

  // Context telemetry is opportunistic and truthful: only persist a sample
  // when the adapter payload actually exposes usage/window data. Identical
  // measurements are de-duplicated before they reach the canonical stream.
  if (payload?.raw) {
    try {
      const sample = extractContextSample(payload.raw, {
        sessionId,
        adapter,
        model: payload.model,
        source: "hook",
        confidence: "reported",
      });
      if (sample) {
        const recorded = recordContextSample(coordRoot, owner.instance_id, sample);
        void recorded;
      }
    } catch (err) {
      logError(coordRoot, err, { phase: "context-sample" });
    }
  }

  // A native pre-compaction signal is the safest available point to capture
  // external work state. The operation is idempotent until recovery, so a
  // adapter retry cannot create a storm of near-identical capsules.
  if (norm.event_type === "context.compaction_started") {
    try {
      const checkpoint = checkpointContext(coordRoot, {
        sessionId,
        instanceId: owner.instance_id,
        adapter,
        cwd: payload?.cwd ?? process.cwd(),
        reason: "pre_compact",
        model: payload?.model,
      });
      void checkpoint;
    } catch (err) {
      logError(coordRoot, err, { phase: "context-checkpoint" });
    }
  }

  if (norm.event_type === "context.compaction_completed") {
    try {
      markContextCompactionCompleted(coordRoot, {
        sessionId,
        instanceId: owner.instance_id,
      });
    } catch (err) {
      logError(coordRoot, err, { phase: "context-compaction-completed" });
    }
  }

  // Phase 8: SessionStart post-emit: project the event so the heartbeat
  // lands synchronously, run stale-sweep, and emit the adapter-shaped
  // systemMessage JSON (peer table + wiring check + council invites).
  // Adapter-agnostic since v0.5.0; replaces the previous bash UX layer
  // and the equivalent per-adapter bash session_start handlers.
  if (norm.event_type === "session.started") {
    // Effect (claude-code): prune stale journal archives + sweep orphans.
    // The recovery-cue is merged into the
    // session-start additionalContext inside emitSessionStartSystemMessage.
    if (adapter === "claude-code") journalJanitor(coordRoot);
    imageJanitor(coordRoot);
    let recovery: PreparedContextRecovery | null = null;
    if (payload?.source === "compact") {
      try {
        markContextCompactionCompleted(coordRoot, {
          sessionId,
          instanceId: owner.instance_id,
        });
        recovery = prepareContextRecovery(coordRoot, {
          instanceId: owner.instance_id,
          sessionId,
          cwd: payload?.cwd ?? process.cwd(),
        });
      } catch (err) {
        logError(coordRoot, err, { phase: "context-recovery-session-start" });
      }
    }
    try {
      const injected = await emitSessionStartSystemMessage(
        coordRoot,
        owner.instance_id,
        sessionId,
        data,
        adapter,
        recovery?.briefing ?? "",
      );
      if (injected && recovery) {
        completeRecoveryInjection(coordRoot, owner.instance_id, sessionId, recovery);
      }
    } catch (err) {
      logError(coordRoot, err, { phase: "session-start-systemMessage" });
    }
    // Pull advisory cross-machine presence. V3 never publishes from the
    // disposable heartbeat cache.
    try {
      fetchPresence(coordRoot);
    } catch (err) {
      logError(coordRoot, err, { phase: "session-start-presence" });
    }
  }

  // Phase 8: SessionEnd cleanup: delete heartbeat + pid-map rows. Adapter-
  // agnostic since v0.5.0.
  if (norm.event_type === "session.ended") {
    try {
      cleanupSessionEnd(coordRoot, owner.instance_id, (data.reason as string) ?? "unknown");
    } catch (err) {
      logError(coordRoot, err, { phase: "session-end-cleanup" });
    }
    // Effects (claude-code): archive the ending agent's journal + force a
    // session-telemetry sync (via HARNERY_CLAUDE_SESSIONS_FORCE=1).
    if (adapter === "claude-code") {
      journalArchive(coordRoot, owner.instance_id);
      runSessionSyncExtension(coordRoot, true);
    }
  }

  // Phase 8: SubagentStart: sync-project to create the subagent heartbeat,
  // log the lifecycle event, and emit a context message announcing the
  // subagent (claude-code + cursor; codex doesn't fan out subagents today).
  if (norm.event_type === "agent.started") {
    try {
      const agentCoordBin = coordBinPath("agent-coord", coordRoot) ?? "";
      if (existsSync(agentCoordBin)) {
        spawnSync(agentCoordBin, ["project"], {
          encoding: "utf8",
          timeout: 3000,
          env: childEnv(coordRoot),
        });
        spawnSync(
          agentCoordBin,
          [
            "log",
            `SUBAGENT_START  agent_type=${(data.agent_type as string) ?? "unknown"} agent_id=${owner.instance_id.slice(0, 8)} platform=${adapterPlatform(adapter)}`,
            "--instance",
            owner.instance_id,
          ],
          { encoding: "utf8", timeout: 2000, env: childEnv(coordRoot) },
        );
      }
      emitSubagentStartContext(coordRoot, owner.instance_id, sessionId, data, adapter);
    } catch (err) {
      logError(coordRoot, err, { phase: "subagent-start-project" });
    }
  }

  // Phase 8: SubagentStop: delete subagent heartbeat + log.
  if (norm.event_type === "agent.completed") {
    try {
      cleanupSessionEnd(coordRoot, owner.instance_id, (data.reason as string) ?? "unknown");
      const agentCoordBin = coordBinPath("agent-coord", coordRoot) ?? "";
      if (existsSync(agentCoordBin)) {
        spawnSync(
          agentCoordBin,
          [
            "log",
            `SUBAGENT_STOP   agent_id=${owner.instance_id.slice(0, 8)} platform=${adapterPlatform(adapter)}`,
            "--instance",
            owner.instance_id,
          ],
          { encoding: "utf8", timeout: 2000, env: childEnv(coordRoot) },
        );
      }
    } catch (err) {
      logError(coordRoot, err, { phase: "subagent-stop-cleanup" });
    }
  }

  // Phase 8: UserPromptSubmit: render dedup'd peer table + council pending
  // and emit the adapter-shaped systemMessage JSON. Adapter-agnostic since v0.5.0.
  if (norm.event_type === "turn.started") {
    // Effects (claude-code): reset per-turn sound rate-limit counters + run
    // presence detection on the prompt.
    if (adapter === "claude-code") {
      resetSoundCounters(sessionId);
      const prompt = (payload?.raw?.prompt as string | undefined) ?? "";
      if (prompt) detectPresence(prompt);
    }
    // Presence: throttled pull of peer machines' presence refs (default 60s
    // interval; the systemMessage below reads whatever is locally known).
    try {
      fetchPresence(coordRoot);
    } catch (err) {
      logError(coordRoot, err, { phase: "user-prompt-submit-presence" });
    }
    let recovery: PreparedContextRecovery | null = null;
    const continuityState = readContextState(coordRoot, sessionId);
    if (
      continuityState?.phase === "checkpointed" &&
      continuityState.compaction_completed_at !== undefined
    ) {
      try {
        recovery = prepareContextRecovery(coordRoot, {
          instanceId: owner.instance_id,
          sessionId,
          cwd: payload?.cwd ?? process.cwd(),
        });
      } catch (err) {
        logError(coordRoot, err, { phase: "context-recovery-user-prompt" });
      }
    }
    try {
      const injected = await emitUserPromptSubmitSystemMessage(
        coordRoot,
        owner.instance_id,
        sessionId,
        adapter,
        payload?.cwd,
        recovery?.briefing ?? "",
      );
      if (injected && recovery) {
        completeRecoveryInjection(coordRoot, owner.instance_id, sessionId, recovery);
      }
    } catch (err) {
      logError(coordRoot, err, { phase: "user-prompt-submit-systemMessage" });
    }
  }

  // turn.completed: telemetry, then the stop verdict. The
  // verdict + codex-replay previously lived in the per-adapter shell adapters;
  // agent-hook owns them now. Runs on the normal "stop" event only;
  // "stop-failure" (API error) gets no gate, matching the previous
  // stop vs stop-failure split.
  if (norm.event_type === "turn.completed" && eventName === "stop") {
    // Claude Code session telemetry sync remains an independent side effect.
    if (adapter === "claude-code") {
      runSessionSyncExtension(coordRoot, false);
    }

    // Stop verdict (status-box + set-task gate). Direct in-process call: the
    // rule lives in harnery. agent-hook already emitted this turn.completed (with
    // status_box_present) above, so the evidence is in the stream.
    const verdict = evaluateStopHook(coordRoot, {
      rule: "stop-hook",
      instance_id: owner.instance_id,
      session_id: sessionId,
      adapter,
      bypass: coordEnv("AGENT_COORD_BYPASS_STOP") === "1",
      workflow_child: coordEnv("WORKFLOW_CHILD") === "1",
    });
    if (!verdict.allow) {
      // Adapter-aware enforcement channel: Claude Code / Codex honor exit-2 +
      // stderr as a turn block; Cursor ignores exit codes (fail-open) and
      // re-prompts only via a `followup_message` it auto-submits. emitStopBlock
      // writes the right shape and returns the exit code to use.
      const { emitStopBlock } = await import("./adapter/output.ts");
      return emitStopBlock(adapter, verdict, coordRoot);
    }

    // An explicit end requested from inside this turn cannot be authoritative
    // until the adapter has committed turn.completed above. Reconcile only
    // when such a request exists; any later real work cancels it in the
    // finalizer instead of being terminated underneath the agent.
    try {
      const { hasPendingExplicitSessionEndV3, reconcileSessionFinalizationV3 } = await import(
        "../agents/session-finalizer-v3.ts"
      );
      if (hasPendingExplicitSessionEndV3(coordRoot)) {
        reconcileSessionFinalizationV3(coordRoot);
      }
    } catch (err) {
      logError(coordRoot, err, { phase: "stop-explicit-session-finalization" });
    }
  }

  // Phase 7: PreToolUse: heartbeat + pid-map self-heal on every tool call.
  // Adapter-agnostic: both writes have the same shape regardless of who fired.
  // Cursor/Codex bash dispatchers still fire their own G-guard logic, but the
  // heals here keep the agent-coord layer's view of liveness fresh.
  //
  // The heartbeat + pid-map heals are paired by design; they were wired
  // side-by-side in the previous pre-tool-use adapter. The Phase 4-6 refactor
  // preserved the heartbeat half but dropped the pid-map half; the pid-map
  // call was restored here afterward.
  if (norm.event_type === "tool.requested") {
    try {
      // Recorded fork lineage, heal-path flavor. A forked CC conversation
      // never fires its own session.started (SessionStart fires under the
      // PARENT's session id with source=resume, before the fork id is
      // minted; verified 2026-08-05), so the fork's new instance first
      // materializes right here. Gate detection on "no heartbeat yet" so the
      // transcript scan runs once per instance lifetime, not per tool call.
      refreshPidmap(coordRoot, owner.instance_id, adapter, payload?.pid);
    } catch (err) {
      logError(coordRoot, err, { phase: "pre-tool-use-heal" });
    }

    // Windows-native Codex + WSL UNC only: block the one cross-shell shape
    // proven to corrupt argument boundaries. Normal WSL argv calls, literal
    // bash -s scripts, native Linux/macOS sessions, and every other adapter
    // pass through. The host instructions name its concrete safe bridge.
    const unsafeShellReason = unsafeCrossShellReason({
      adapter,
      cwd: payload?.cwd,
      toolName: payload?.tool_name,
      toolInput: payload?.tool_input,
    });
    if (unsafeShellReason) {
      const { emitDeny } = await import("./adapter/output.ts");
      emitDeny(adapter, unsafeShellReason);
      return 0;
    }

    // G-guard for ALL adapters. Claude Code previously ran this via a
    // pre-tool-use bash adapter (which called `agent-coord verdict --rule=claim`);
    // that adapter is now deleted, so agent-hook owns the deny for every adapter.
    // emitDeny() inside emits the adapter-shaped permission JSON (claude-code +
    // codex use hookSpecificOutput.permissionDecision; cursor uses .permission).
    // apply_patch (codex) parses paths from the patch body and runs verdict
    // per-path; Edit/Write/NotebookEdit resolve a single target. Non-write tools
    // (incl. Agent) yield no targets and pass through with no deny.
    let guardAllowed = true;
    try {
      guardAllowed = await runPreToolUseGuard(
        coordRoot,
        owner.instance_id,
        sessionId,
        data,
        adapter,
      );
    } catch (err) {
      logError(coordRoot, err, { phase: "pre-tool-use-guard" });
    }
    if (!guardAllowed) return 0;
  }

  if (norm.event_type === "tool.completed" && eventName === "post-tool-use") {
    // V3 tool observations update the generation projection directly.
  }

  // Phase 7: PostToolUseFailure: release claim on failed Edit (the file
  // never landed; the claim is stale). Adapter-agnostic.
  if (norm.event_type === "tool.completed" && eventName === "post-tool-use-failure") {
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
  adapter: Adapter,
): Promise<boolean> {
  const toolName = (data.tool_name as string | undefined) ?? "";
  const rawTargets = collectGuardTargets(toolName, data);
  if (rawTargets.length === 0) return true;

  let targets: Array<{ path: string; finalization?: ClaimFinalizationDescriptor }>;
  if (agentsRequireGitFinalization(coordRoot)) {
    const decisions = rawTargets.map((path) => classifyWriteClaimFinalization(coordRoot, path));
    const denied = decisions.find((decision) => !decision.allow);
    if (denied && !denied.allow) {
      const { emitDeny } = await import("./adapter/output.ts");
      emitDeny(adapter, formatWriteClaimFinalizationDenial(denied, resolveBinName(coordRoot)));
      return false;
    }
    const allowed = decisions.filter(
      (decision): decision is Extract<ClaimFinalizationDecision, { allow: true }> => decision.allow,
    );
    targets = allowed.map((decision) => ({
      path: decision.path,
      finalization: decision.descriptor,
    }));
  } else {
    targets = rawTargets
      .map((path) => canonicalize(coordRoot, path))
      .filter((path): path is string => path !== null)
      .map((path) => ({ path }));
  }
  if (targets.length === 0) return true;

  const agentCoordBin = coordBinPath("agent-coord", coordRoot) ?? "";
  if (!existsSync(agentCoordBin)) {
    if (agentsRequireGitFinalization(coordRoot)) {
      const { emitDeny } = await import("./adapter/output.ts");
      emitDeny(
        adapter,
        "Harnery denied the write before mutation because the claim coordinator is unavailable; repair the project's Harnery installation and retry.",
      );
      return false;
    }
    return true;
  }

  // For apply_patch (multi-file), collect siblings so the deny reason names
  // them. For single-file tools the array has one entry.
  for (const target of targets) {
    const verdictReq = JSON.stringify({
      rule: "claim",
      instance_id: instanceId,
      session_id: sessionId,
      path: target.path,
    });
    const result = spawnSync(agentCoordBin, ["verdict"], {
      input: verdictReq,
      encoding: "utf8",
      timeout: 3000,
      env: childEnv(coordRoot),
    });
    if (result.status !== 0 || !result.stdout) continue;
    let parsed: { allow?: boolean; reason?: string } = {};
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      continue;
    }
    if (parsed.allow === false) {
      let reason =
        parsed.reason ?? `Path ${target.path} is currently being edited by another agent.`;
      if (targets.length > 1) {
        const siblings = targets
          .filter((candidate) => candidate !== target)
          .map((candidate) => candidate.path)
          .slice(0, 3)
          .join(", ");
        if (siblings) {
          reason += ` The patch also touched: ${siblings}: pick a different file or wait.`;
        }
      }
      const { emitDeny } = await import("./adapter/output.ts");
      emitDeny(adapter, reason);
      return false;
    }
  }
  return true;
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

/**
 * Walk up the ppid chain on Linux/WSL looking for the adapter anchor PID,
 * the PID of the claude / cursor / codex binary. Finds the agent PID. Used by
 * `tool.requested` pid-map self-heal so a re-parented adapter binary (the
 * VS Code 2.1.x sibling-claude spawn case) gets its pid-map row rewritten on
 * the next tool call rather than going invisible until SessionStart fires
 * again, which it may never do.
 *
 * Returns undefined only when no anchor is found; callers fall back to
 * `process.ppid` (the bash wrapper's parent, which is usually the adapter binary
 * itself). `HARNERY_AGENT_COORD_TEST_ANCHOR_PID` overrides everything so the
 * test sandbox can pin a deterministic PID.
 */
function findAdapterAnchorPid(adapter?: Adapter): number | undefined {
  const override = coordEnv("AGENT_COORD_TEST_ANCHOR_PID");
  if (override) {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // A adapter that states its own pid ends the search. Nothing inferred from the
  // process tree beats the adapter naming itself, and the inference is the part
  // that has been failing: comm matching wants a binary called after its
  // adapter, and one Claude Code build ships its CLI under a version-numbered
  // filename, so the walk found nothing and the caller fell back to the hook's
  // own shell. That row was dead within seconds, leaving every session in this
  // environment unattributed.
  const fromEnv = adapterPidFromEnv();
  if (fromEnv) return fromEnv;
  // Build the ppid chain (nearest → root, up to 20 hops), then hand it to the
  // pure selector. Linux/WSL reads /proc; macOS/BSD (no /proc) falls back to
  // `ps -o ppid=,comm=` parsed by the unit-tested `parsePsChainLine`. Splitting
  // the walk (untestable off a live box) from the matching keeps the selector
  // logic verifiable.
  //
  // Only the /proc branch carries an executable path for the selector's
  // path-based pass. Asking `ps` for one means either a second spawn per hop or
  // splitting `comm` from `args` on a line where comm may itself contain spaces,
  // and the adapter that needs the path pass states its pid in the env anyway.
  const chain: Array<{ pid: number; comm: string; exe?: string }> = [];
  let pid = process.pid;
  for (let hops = 0; hops < 20; hops++) {
    let hop: { comm: string; ppid: number; exe?: string } | null = null;
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const m = status.match(/^PPid:\s+(\d+)/m);
      // argv[0], for the path-based second pass. cmdline is NUL-separated.
      let exe: string | undefined;
      try {
        exe = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] || undefined;
      } catch {
        /* exe is optional */
      }
      hop = { comm, ppid: m ? Number(m[1]) : 0, exe };
    } catch {
      // no /proc (macOS/BSD) — fall through to ps
    }
    if (!hop) {
      const out = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
      if (out.status === 0) hop = parsePsChainLine(out.stdout);
    }
    if (!hop) break;
    chain.push({ pid, comm: hop.comm, exe: hop.exe });
    if (!Number.isFinite(hop.ppid) || hop.ppid === 0 || hop.ppid === 1) break;
    pid = hop.ppid;
  }
  return selectAnchorPid(chain, adapter);
}

/**
 * Pid-map self-heal for `tool.requested`.
 *
 * The pid argument prefers the payload's `pid` (CC populates it on
 * SessionStart and may also send it on PreToolUse), then
 * `findAdapterAnchorPid`, then `process.ppid`. Writes go through the same
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
  adapter: Adapter,
  payloadPid?: number,
): void {
  const pid = payloadPid ?? findAdapterAnchorPid(adapter) ?? process.ppid;
  if (!Number.isFinite(pid) || pid <= 0) return;
  writePidmapViaAgentCoord(coordRoot, pid, instanceId, adapterPlatform(adapter));
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

  // In V3 the release is an authority event, not a heartbeat mutation. Avoid
  // creating a disposable cache for a failure that never acquired a claim,
  // but release the exact path when the validated projection says it is held.
  const row = readLiveCoordinationRow(coordRoot, instanceId);
  if (!row?.files_touched?.includes(canonical)) return;

  const agentCoordBin = coordBinPath("agent-coord", coordRoot) ?? "";
  if (!existsSync(agentCoordBin)) return;
  spawnSync(agentCoordBin, ["release-claim", instanceId, canonical], {
    encoding: "utf8",
    timeout: 2000,
    env: childEnv(coordRoot),
  });
}

function cleanupSessionEnd(coordRoot: string, instanceId: string, reason: string): void {
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
  const agentCoordBin = coordBinPath("agent-coord", coordRoot) ?? "";
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
  adapter: Adapter,
  workspaceCwd?: string,
  recoveryBriefing = "",
): Promise<boolean> {
  const agentCoordBin = coordBinPath("agent-coord", coordRoot) ?? "";
  let additionalContext = "";

  if (existsSync(agentCoordBin)) {
    const args = ["prompt-context", "--instance", instanceId, "--session", sessionId];
    // Every human-facing adapter gets the first-session naming reminder from
    // the shared hook path. Cursor + Codex additionally get ongoing set-task
    // staleness nudges; Claude Code enforces those via its Stop transcript.
    // Codex gets a fresh status-footer reminder on every prompt. Its Stop hook
    // stays observe-only, so missing the footer never replaces the answer.
    // Claude Code + Cursor (the Stop-ENFORCING adapters) get a fresh per-turn
    // ritual reminder: satisfying the contract up front is far cheaper than
    // the bounce-and-retry the Stop hook otherwise forces.
    args.push("--session-name-nudge");
    if (adapter === "cursor" || adapter === "codex") args.push("--task-nudge");
    if (adapter === "codex") args.push("--status-footer-nudge");
    if (adapter === "claude-code" || adapter === "cursor")
      args.push("--turn-ritual-nudge", adapter);
    const result = spawnSync(agentCoordBin, args, { encoding: "utf8", timeout: 3000 });
    if (result.status === 0 && result.stdout) additionalContext = result.stdout.trim();
  }
  if (adapter === "codex") {
    const fileLinkContext = renderCodexWslFileLinkContext(coordRoot, workspaceCwd);
    if (fileLinkContext) {
      additionalContext = [additionalContext, fileLinkContext].filter(Boolean).join("\n\n");
    }
  }
  if (recoveryBriefing) {
    additionalContext = [additionalContext, recoveryBriefing].filter(Boolean).join("\n\n");
  }
  if (!additionalContext) return false;

  const { emitContext } = await import("./adapter/output.ts");
  emitContext(adapter, "UserPromptSubmit", additionalContext);
  return true;
}

function emitSubagentStartContext(
  coordRoot: string,
  instanceId: string,
  sessionId: string,
  data: Record<string, unknown>,
  adapter: Adapter,
): void {
  // Look up the subagent's assigned name (just-written by agent-coord assignName
  // in session.started data) + the parent's short id for the "you are a subagent
  // of X" framing.
  const subagentName = (data.name as string | undefined) ?? "";
  if (!subagentName) return;
  const platformLabel = adapterPlatform(adapter);
  const parentShort =
    sessionId && sessionId !== instanceId ? `agent-${sessionId.slice(0, 8)}` : "the parent session";
  const message = `You are agent-${subagentName} (${platformLabel} subagent). You're a subagent of ${parentShort}.`;

  // Render peer table inline since the subagent might want to know who else
  // is around. Reuse prompt-context (which dedups against the per-owner hash);
  // first call will always emit.
  const agentCoordBin = coordBinPath("agent-coord", coordRoot) ?? "";
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
  void import("./adapter/output.ts").then(({ emitContext }) => {
    emitContext(adapter, "SubagentStart", combined);
  });
}

function adapterPlatform(adapter: Adapter): string {
  if (adapter === "claude-code") return "claude-code";
  return adapter;
}

async function emitSessionStartSystemMessage(
  coordRoot: string,
  instanceId: string,
  sessionId: string,
  emittedData: Record<string, unknown>,
  adapter: Adapter,
  recoveryBriefing = "",
): Promise<boolean> {
  const agentCoordBin = coordBinPath("agent-coord", coordRoot) ?? "";
  const workflowChild = coordEnv("WORKFLOW_CHILD") === "1";
  let additionalContext = "";
  if (existsSync(agentCoordBin)) {
    // Sync-project so the heartbeat exists for downstream readers (peer table,
    // wiring check, council invites).
    spawnSync(agentCoordBin, ["project"], { encoding: "utf8", timeout: 3000 });
    // Opportunistic reconciliation makes normal session starts a failsafe for
    // archive, idle, cascade, and host lifecycle observations.
    spawnSync(agentCoordBin, ["reconcile-finalization"], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: coordRoot },
    });

    // SESSION_START activity log line, fired across all adapters.
    const model = (emittedData.model as string | undefined) ?? "unknown";
    const source = (emittedData.source as string | undefined) ?? "startup";
    const platform = adapterPlatform(adapter);
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

    // Workflow children retain lifecycle/event capture but do not receive
    // operator-facing peer, council, or init-remediation context. Injecting
    // that context can make a bounded child follow housekeeping instructions
    // instead of its assigned prompt.
    if (!workflowChild) {
      const agentName = (emittedData.name as string | undefined) ?? "";
      const args = ["session-context", "--instance", instanceId, "--session", sessionId];
      if (agentName) args.push("--name", agentName);
      // The "You are agent-X." prefix in session-context renders unqualified by
      // default (claude-code-style). For cursor/codex the bash dispatchers add
      // a "(Cursor)" / "(Codex)" suffix; pass it through as --platform-label.
      if (adapter !== "claude-code") {
        args.push("--platform-label", platform === "cursor" ? "Cursor" : "Codex");
      }
      const result = spawnSync(agentCoordBin, args, { encoding: "utf8", timeout: 3000 });
      if (result.status === 0 && result.stdout) additionalContext = result.stdout.trim();
    }
  }

  // Effect (claude-code): merge the journal recovery cue into the session-start
  // context. Was a standalone additionalContext emission from the previous
  // journal-on-start adapter; now that agent-hook is the single SessionStart
  // entry, it folds in here.
  if (adapter === "claude-code" && !workflowChild) {
    const cue = journalRecoveryCue(coordRoot);
    if (cue) additionalContext = [additionalContext, cue].filter(Boolean).join("\n\n");
  }
  if (recoveryBriefing && !workflowChild) {
    additionalContext = [additionalContext, recoveryBriefing].filter(Boolean).join("\n\n");
  }
  if (adapter === "codex" && !workflowChild && isWslUncPath(emittedData.cwd)) {
    const fileLinkContext = renderCodexWslFileLinkContext(coordRoot, emittedData.cwd);
    if (fileLinkContext) {
      additionalContext = [additionalContext, fileLinkContext].filter(Boolean).join("\n\n");
    }
    const bridge = inspectCodexWslBridge(process.env, { expected: true });
    if (bridge && !bridge.ok) {
      additionalContext = [
        additionalContext,
        `Harnery hybrid warning: ${bridge.detail}. Run \`${resolveBinName(coordRoot)} doctor\` for the repair hint.`,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  }
  if (!additionalContext) return false;

  const { emitContext } = await import("./adapter/output.ts");
  emitContext(adapter, "SessionStart", additionalContext);
  return true;
}

function completeRecoveryInjection(
  coordRoot: string,
  instanceId: string,
  sessionId: string,
  recovery: PreparedContextRecovery,
): void {
  completeContextRecovery(coordRoot, { sessionId, instanceId });
  void recovery;
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
