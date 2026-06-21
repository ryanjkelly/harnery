/**
 * Codex JSONL → canonical event replay.
 *
 * Production codex sessions emit canonical events from each `harn` invocation
 * via the in-process session-tee middleware (which calls `agent-coord
 * emit-event` for state.task_set / state.status_checked). But the codex
 * harness itself doesn't wire agent-hook on preToolUse, so user_prompt.submit
 * + tool.pre_use + turn.stop aren't emitted live.
 *
 * This module parses the Codex JSONL transcript at stop time and emits the
 * missing canonical events so the verdict has a complete turn-window view.
 *
 * Scope: just the events the stop-hook verdict reads: user_prompt.submit,
 * tool.pre_use (for exec_command function calls), state.status_checked
 * (when the cmd contains `<bin> agents status`), state.task_set (when the cmd
 * contains `<bin> agents set-task`), turn.stop (with status_box_present derived
 * from the last_assistant_message).
 */

import { existsSync, readFileSync } from "node:fs";
import { emit } from "./events/emit.ts";

interface CodexEntry {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    message?: string;
    name?: string;
    arguments?: string;
  };
}

const STATUS_BOX_PREFIX = "┌─ agent-";

export interface CodexReplayOpts {
  coordRoot: string;
  sessionId: string;
  instanceId: string;
  jsonlPath: string;
  lastAssistantMessage?: string;
}

export function replayCodexJsonl(opts: CodexReplayOpts): { emitted: number } {
  const { coordRoot, sessionId, instanceId, jsonlPath, lastAssistantMessage } = opts;
  if (!existsSync(jsonlPath)) return { emitted: 0 };

  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf8");
  } catch {
    return { emitted: 0 };
  }

  let emitted = 0;
  const lines = raw.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: CodexEntry;
    try {
      entry = JSON.parse(line) as CodexEntry;
    } catch {
      continue;
    }
    const ts = entry.timestamp;
    const t = entry.type;

    if (t === "event_msg" && entry.payload?.type === "user_message") {
      emit(coordRoot, {
        event_type: "user_prompt.submit",
        instance_id: instanceId,
        session_id: sessionId,
        harness: "codex",
        ts,
        data: {
          prompt_text: clamp(entry.payload.message ?? "", 4000),
        },
      });
      emitted += 1;
      continue;
    }

    if (t === "response_item" && entry.payload?.type === "function_call") {
      const name = entry.payload.name ?? "";
      let cmd = "";
      if (entry.payload.arguments) {
        try {
          const parsed = JSON.parse(entry.payload.arguments) as { cmd?: string };
          cmd = parsed.cmd ?? "";
        } catch {
          /* skip */
        }
      }
      // Emit tool.pre_use for every function call.
      emit(coordRoot, {
        event_type: "tool.pre_use",
        instance_id: instanceId,
        session_id: sessionId,
        harness: "codex",
        ts,
        data: {
          tool_name: name === "exec_command" ? "Bash" : name,
          tool_input: JSON.stringify({ command: cmd }),
          intent: "",
          intent_source: "codex-replay",
        },
      });
      emitted += 1;

      // Match `<bin> agents status` / `<bin> agents set-task`, bin-agnostic, so
      // it works for harn or any host CLI that composes harnery (a consumer's own
      // binary). Wrapped invocations (cd && <bin> ...; PATH=... <bin> ...) pass
      // because we scan the whole cmd string and anchor on the token before `agents`.
      if (/(^|\s|;|&&)[\w./-]+\s+agents\s+status(\b|$)/.test(cmd)) {
        emit(coordRoot, {
          event_type: "state.status_checked",
          instance_id: instanceId,
          session_id: sessionId,
          harness: "codex",
          ts,
          data: { source: "codex-replay" },
        });
        emitted += 1;
      }
      if (/(^|\s|;|&&)[\w./-]+\s+agents\s+set-task(\b|$)/.test(cmd)) {
        emit(coordRoot, {
          event_type: "state.task_set",
          instance_id: instanceId,
          session_id: sessionId,
          harness: "codex",
          ts,
          data: { source: "codex-replay" },
        });
        emitted += 1;
      }
    }
  }

  // Finally, emit turn.stop with status_box_present derived from the last
  // assistant message (codex's stop payload carries the assistant text
  // directly, unlike CC which only has transcript_path).
  const boxPresent = !!lastAssistantMessage && lastAssistantMessage.includes(STATUS_BOX_PREFIX);
  emit(coordRoot, {
    event_type: "turn.stop",
    instance_id: instanceId,
    session_id: sessionId,
    harness: "codex",
    data: {
      status_box_present: boxPresent,
      tool_call_count: -1,
      text_length: lastAssistantMessage?.length ?? 0,
    },
  });
  emitted += 1;

  return { emitted };
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}
