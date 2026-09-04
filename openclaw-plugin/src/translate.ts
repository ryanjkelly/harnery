import type {
  OpenClawHookContext,
  OpenClawHookEvent,
  OpenClawHookName,
  TranslationResult,
} from "./types.ts";

export function translateOpenClawHook(
  hook: OpenClawHookName,
  event: OpenClawHookEvent,
  context: OpenClawHookContext,
): TranslationResult {
  const sessionId = string(context.sessionKey);
  if (!sessionId) return missing(hook, "sessionKey");
  const agentId = string(context.agentId) ?? "main";
  const cwd = string(context.workspaceDir) ?? string(context.cwd) ?? process.cwd();
  const turnId = string(context.runId);
  const common = { session_id: sessionId, agent_id: agentId, cwd, raw: {} };

  switch (hook) {
    case "session_start":
      return translated("session-start", common);
    case "before_prompt_build":
      if (!turnId) return missing(hook, "runId");
      return translated("user-prompt-submit", {
        ...common,
        turn_id: turnId,
        ...(typeof event.prompt === "string" ? { prompt: event.prompt } : {}),
      });
    case "before_tool_call": {
      if (!turnId) return missing(hook, "runId");
      const toolUseId = string(event.toolCallId);
      if (!toolUseId) return missing(hook, "toolCallId");
      return translated("pre-tool-use", {
        ...common,
        turn_id: turnId,
        tool_use_id: toolUseId,
        tool_name: string(event.toolName) ?? "unknown-tool",
        tool_input: event.params,
      });
    }
    case "after_tool_call": {
      if (!turnId) return missing(hook, "runId");
      const toolUseId = string(event.toolCallId);
      if (!toolUseId) return missing(hook, "toolCallId");
      return translated(event.error == null ? "post-tool-use" : "post-tool-use-failure", {
        ...common,
        turn_id: turnId,
        tool_use_id: toolUseId,
        tool_name: string(event.toolName) ?? "unknown-tool",
        tool_input: event.params,
        tool_response: event.error ?? event.result ?? event.output,
        ...(event.error == null ? {} : { reason: errorReason(event.error) }),
      });
    }
    case "agent_end":
      if (!turnId) return missing(hook, "runId");
      return translated("stop", { ...common, turn_id: turnId });
    case "session_end":
      return translated("session-end", common);
  }
}

function translated(
  signal: NonNullable<TranslationResult["value"]>["signal"],
  payload: NonNullable<TranslationResult["value"]>["payload"],
): TranslationResult {
  return { value: { signal, payload } };
}

function missing(hook: OpenClawHookName, field: string): TranslationResult {
  return { value: null, reason: `${hook}:missing_${field}` };
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorReason(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "tool_call_failed";
}
