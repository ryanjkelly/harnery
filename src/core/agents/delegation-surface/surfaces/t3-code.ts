import type { Adapter } from "../../../adapter.ts";
import {
  T3_DELEGATED_THREAD_PREFIX,
  T3_THREAD_ID_ENV,
} from "../../session-title/surfaces/t3-code.ts";
import type { DelegationSurface } from "../types.ts";

export const T3_CODE_DELEGATION_SURFACE_ID = "t3-code";

/** Claude Code reports `mcp__t3-code__…`, Codex `mcp__t3_code__…`. */
const T3_DELEGATE_TOOL = /^mcp__t3[-_]code__delegate_task$/;

/** Field of the delegate tool's JSON result that equals the child's thread id. */
const CHILD_THREAD_FIELD = "childThreadId";

/** Thread ids are short opaque tokens; anything longer or with spaces is not one. */
const THREAD_ID = /^thread:delegated-task:[A-Za-z0-9%:._-]{1,400}$/;

/** Real results are a JSON object, a JSON string, or MCP text content blocks. */
const MAX_DEPTH = 4;

function validKey(value: unknown): string | undefined {
  return typeof value === "string" && THREAD_ID.test(value) ? value : undefined;
}

function fromJsonText(text: string, depth: number): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return fromValue(JSON.parse(trimmed), depth + 1);
  } catch {
    return undefined;
  }
}

function fromValue(value: unknown, depth: number): string | undefined {
  if (depth > MAX_DEPTH || value === null || value === undefined) return undefined;
  if (typeof value === "string") return fromJsonText(value, depth);
  if (Array.isArray(value)) {
    // MCP content blocks: [{ type: "text", text: "{...}" }]. Exactly one key
    // across the blocks counts; two different keys is not a delegation result.
    const keys = new Set<string>();
    for (const item of value.slice(0, 16)) {
      const key = fromValue(item, depth + 1);
      if (key) keys.add(key);
    }
    return keys.size === 1 ? [...keys][0] : undefined;
  }
  if (typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  if (CHILD_THREAD_FIELD in object) return validKey(object[CHILD_THREAD_FIELD]);
  if (object.type === "text" && typeof object.text === "string") {
    return fromJsonText(object.text, depth);
  }
  if ("content" in object) return fromValue(object.content, depth + 1);
  return undefined;
}

/**
 * T3 Code's `delegate_task` starts a worker thread and returns, among other
 * fields, `childThreadId`. T3 starts that worker with the same value in
 * `T3CODE_THREAD_ID`, for Claude Code and Codex workers alike, and every
 * delegated thread id carries the `thread:delegated-task:` prefix.
 */
export const t3CodeDelegationSurface: DelegationSurface = {
  id: T3_CODE_DELEGATION_SURFACE_ID,
  isDelegateTool(toolName) {
    return typeof toolName === "string" && T3_DELEGATE_TOOL.test(toolName);
  },
  childKeyFromResult(toolResponse) {
    try {
      return fromValue(toolResponse, 0);
    } catch {
      return undefined;
    }
  },
  childKeyFromEnv(env, adapter: Adapter | null) {
    if (adapter !== "claude-code" && adapter !== "codex") return undefined;
    const id = env[T3_THREAD_ID_ENV];
    if (typeof id !== "string" || !id.startsWith(T3_DELEGATED_THREAD_PREFIX)) return undefined;
    return validKey(id);
  },
};
