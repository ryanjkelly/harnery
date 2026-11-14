import { sessionNameDisplayBlock } from "../../session-name-display.ts";
import { DONE_TITLE_PREFIX } from "../policy.ts";
import {
  type CompletedToolCall,
  type SessionTitleSurface,
  T3_CODE_SURFACE_ID,
  type TitleSurfaceContext,
  type ToolCall,
} from "../types.ts";

/**
 * T3 Code hosts Claude Code and Codex sessions as threads and gives the agent
 * a `t3_thread_update` tool that renames its own thread (ADR 0247). Harnery
 * cannot call T3 itself, so this surface instructs the agent to make the call
 * and confirms it from the PostToolUse payload.
 *
 * At done, the operator may have typed their own title into the thread during
 * the session. Harnery's hooks cannot read the client's title, but the agent
 * can, so the done request asks the agent to read the current title with
 * `t3_thread_read` and prefix that, rather than overwrite it with the title
 * Harnery applied at start. The rename that results is confirmed as written
 * even when its text is not the owed title.
 */

/**
 * Delegated child threads carry this id prefix. T3 already titles a child
 * from its brief, so the child keeps that title and uses the name block.
 */
export const T3_DELEGATED_THREAD_PREFIX = "thread:delegated-task:";

/** The environment variable T3 sets in the agent's shell. */
export const T3_THREAD_ID_ENV = "T3CODE_THREAD_ID";

/** Claude Code reports `mcp__t3-code__…`, Codex `mcp__t3_code__…`. */
const T3_THREAD_UPDATE_TOOL = /^mcp__t3[-_]code__t3_thread_update$/;
const T3_THREAD_READ_TOOL = /^mcp__t3[-_]code__t3_thread_read$/;

const CLAUDE_CODE_TOOL_NAME = "mcp__t3-code__t3_thread_update";
const CODEX_TOOL_NAME = "mcp__t3_code__t3_thread_update";
const CLAUDE_CODE_READ_TOOL_NAME = "mcp__t3-code__t3_thread_read";
const CODEX_READ_TOOL_NAME = "mcp__t3_code__t3_thread_read";
const TOOL_SEARCH_QUERY = `select:${CLAUDE_CODE_TOOL_NAME}`;
const DONE_TOOL_SEARCH_QUERY = `select:${CLAUDE_CODE_READ_TOOL_NAME},${CLAUDE_CODE_TOOL_NAME}`;

/** Bounds the response walk; real payloads nest two or three levels deep. */
const MAX_RESPONSE_DEPTH = 8;

export function isT3ThreadUpdateTool(name: string | undefined): boolean {
  return typeof name === "string" && T3_THREAD_UPDATE_TOOL.test(name);
}

function threadIdFor(ctx: TitleSurfaceContext): string | undefined {
  const id = ctx.clientThreadId ?? ctx.env[T3_THREAD_ID_ENV];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function detect(ctx: TitleSurfaceContext): boolean {
  if (ctx.adapter !== "claude-code" && ctx.adapter !== "codex") return false;
  const id = threadIdFor(ctx);
  return id !== undefined && !id.startsWith(T3_DELEGATED_THREAD_PREFIX);
}

function toolNameFor(ctx: TitleSurfaceContext): string {
  return ctx.adapter === "codex" ? CODEX_TOOL_NAME : CLAUDE_CODE_TOOL_NAME;
}

function readToolNameFor(ctx: TitleSurfaceContext): string {
  return ctx.adapter === "codex" ? CODEX_READ_TOOL_NAME : CLAUDE_CODE_READ_TOOL_NAME;
}

function isDoneTitle(title: string): boolean {
  return title.startsWith(DONE_TITLE_PREFIX);
}

/** The current request is the terminal one: some accepted title is a done title. */
function isDoneRequest(accepted: readonly string[]): boolean {
  return accepted.some(isDoneTitle);
}

/**
 * A title the agent may write at done: the prefix followed by whatever the
 * thread was called, which Harnery cannot know in advance.
 */
function isWritableDoneTitle(title: string): boolean {
  return isDoneTitle(title) && title.slice(DONE_TITLE_PREFIX.length).trim().length > 0;
}

/** A `t3_thread_read` call aimed at this session's own thread. */
function readsOwnThread(call: ToolCall, ctx: TitleSurfaceContext): boolean {
  if (typeof call.toolName !== "string" || !T3_THREAD_READ_TOOL.test(call.toolName)) return false;
  const target = asRecord(call.toolInput)?.threadId;
  const own = threadIdFor(ctx);
  return own !== undefined && target === own;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The title of a rename call aimed at this session's thread, or null.
 * A missing or empty `threadId` means "the caller's own thread" to T3.
 */
function renameTitleFor(call: ToolCall, ctx: TitleSurfaceContext): string | null {
  if (!isT3ThreadUpdateTool(call.toolName)) return null;
  const input = asRecord(call.toolInput) ?? {};
  if (input.action !== "rename") return null;
  if (typeof input.title !== "string" || input.title.length === 0) return null;
  const target = input.threadId;
  if (target !== undefined && target !== null && target !== "") {
    if (typeof target !== "string" || target !== threadIdFor(ctx)) return null;
  }
  return input.title;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** An `isError: true` on the outer envelope, after unwrapping a JSON string. */
function responseIsError(response: unknown): boolean {
  const top = typeof response === "string" ? parseJsonText(response) : response;
  return asRecord(top)?.isError === true;
}

function responseCarriesRename(
  value: unknown,
  title: string,
  seen: Set<object>,
  depth: number,
): boolean {
  if (depth > MAX_RESPONSE_DEPTH || value === null || value === undefined) return false;
  if (typeof value === "string") {
    const parsed = parseJsonText(value);
    return parsed !== undefined && responseCarriesRename(parsed, title, seen, depth + 1);
  }
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => responseCarriesRename(item, title, seen, depth + 1));
  }
  const row = value as Record<string, unknown>;
  if (row.action === "rename" && row.title === title) return true;
  return Object.values(row).some((item) => responseCarriesRename(item, title, seen, depth + 1));
}

function renameSucceeded(response: unknown, title: string): boolean {
  if (responseIsError(response)) return false;
  return responseCarriesRename(response, title, new Set<object>(), 0);
}

function startInstruction(title: string, ctx: TitleSurfaceContext): string {
  const toolName = toolNameFor(ctx);
  const lines = [
    "Session title required.",
    "Rename this thread now, before any prose and before any other tool call.",
    `Call the T3 Code tool \`t3_thread_update\` with \`action: "rename"\` and \`title\` set to exactly this title, and do not pass a \`threadId\`:`,
    "",
    title,
    "",
  ];
  if (ctx.adapter === "claude-code") {
    lines.push(
      `In Claude Code the tool is listed as \`${toolName}\`. If its schema is not loaded yet, load it first with ToolSearch using the query \`${TOOL_SEARCH_QUERY}\`, then make the rename call.`,
    );
  } else {
    lines.push(`The tool is listed as \`${toolName}\`.`);
  }
  lines.push(
    "When the rename succeeds, do not print a name block.",
    "If the tool is unavailable or the call fails, send this exact fenced block as your next assistant text instead:",
    "",
    sessionNameDisplayBlock(title),
    "",
    'Never use `action: "regenerate_title"`. Harnery will reject other tool calls until the title is delivered.',
    "After this rename, leave the thread title alone for the rest of the session. Do not rename or regenerate it yourself unless the operator asks for it, or Harnery asks again when the session is marked done.",
  );
  return lines.join("\n");
}

function threadIdPhrase(ctx: TitleSurfaceContext): string {
  const id = threadIdFor(ctx);
  return id === undefined
    ? `\`threadId\` set to this thread's id (the \`${T3_THREAD_ID_ENV}\` environment variable)`
    : `\`threadId: ${JSON.stringify(id)}\``;
}

function doneInstruction(title: string, ctx: TitleSurfaceContext): string {
  const readTool = readToolNameFor(ctx);
  const updateTool = toolNameFor(ctx);
  const startTitle = title.slice(DONE_TITLE_PREFIX.length);
  const lines = [
    "Session title required.",
    "This session is marked done. Rename this thread now, before any prose and before any other tool call, in two steps.",
    `1. Read this thread's current title. Call the T3 Code tool \`t3_thread_read\` with ${threadIdPhrase(ctx)}, \`limit: 1\` and \`maxCharsPerItem: 1\`, and take \`thread.title\` from the result.`,
    `2. Call the T3 Code tool \`t3_thread_update\` with \`action: "rename"\` and \`title\` set to \`${DONE_TITLE_PREFIX}\` followed by that current title, and do not pass a \`threadId\`. If the current title already starts with \`${DONE_TITLE_PREFIX}\`, pass it unchanged.`,
    `If nobody edited the title during the session, the current title is \`${startTitle}\`, so the new title is exactly:`,
    "",
    title,
    "",
  ];
  if (ctx.adapter === "claude-code") {
    lines.push(
      `In Claude Code the tools are listed as \`${readTool}\` and \`${updateTool}\`. If their schemas are not loaded yet, load them first with ToolSearch using the query \`${DONE_TOOL_SEARCH_QUERY}\`, then make the two calls.`,
    );
  } else {
    lines.push(`The tools are listed as \`${readTool}\` and \`${updateTool}\`.`);
  }
  lines.push(
    "When the rename succeeds, do not print a name block.",
    "If either tool is unavailable or the rename fails, send this exact fenced block as your next assistant text instead:",
    "",
    sessionNameDisplayBlock(title),
    "",
    'Never use `action: "regenerate_title"`. Harnery will reject other tool calls until the title is delivered.',
  );
  return lines.join("\n");
}

function instruction(title: string, ctx: TitleSurfaceContext): string {
  return isDoneTitle(title) ? doneInstruction(title, ctx) : startInstruction(title, ctx);
}

function doneReminder(title: string, ctx: TitleSurfaceContext): string {
  return [
    "Session title still pending.",
    `This session is marked done. Before any prose or another tool call, read this thread's current title with \`${readToolNameFor(ctx)}\` (${threadIdPhrase(ctx)}, \`limit: 1\`, \`maxCharsPerItem: 1\`), then call \`${toolNameFor(ctx)}\` with \`action: "rename"\` and \`${DONE_TITLE_PREFIX}\` followed by that title. If nobody edited the title, the new title is exactly:`,
    "",
    title,
    "",
    "If you already renamed the thread this way, do nothing.",
  ].join("\n");
}

function reminder(title: string, ctx: TitleSurfaceContext): string {
  if (isDoneTitle(title)) return doneReminder(title, ctx);
  return [
    "Session title still pending.",
    `If this thread's title is not already exactly the title below, call \`${toolNameFor(ctx)}\` with \`action: "rename"\` and that title now, before any prose or another tool call:`,
    "",
    title,
    "",
    "If you already renamed the thread to that title, do nothing.",
  ].join("\n");
}

export const t3CodeSurface: SessionTitleSurface = {
  id: T3_CODE_SURFACE_ID,
  delivery: "agent-tool",
  detect,
  clientThreadId: (ctx) => (detect(ctx) ? threadIdFor(ctx) : undefined),
  instruction,
  reminder,
  note: "Next, before any prose or another tool call, rename this thread to suggested_session_name with the T3 Code tool t3_thread_update (action: rename). If that tool is unavailable, send suggested_session_name verbatim by itself in a fenced code block.",
  allowsWhilePending(call: ToolCall, accepted: readonly string[], ctx: TitleSurfaceContext) {
    const done = isDoneRequest(accepted);
    if (call.toolName === "ToolSearch") {
      const query = asRecord(call.toolInput)?.query;
      if (typeof query !== "string") return false;
      return query.includes("t3_thread_update") || (done && query.includes("t3_thread_read"));
    }
    if (done && readsOwnThread(call, ctx)) return true;
    const title = renameTitleFor(call, ctx);
    if (title === null) return false;
    return accepted.includes(title) || (done && isWritableDoneTitle(title));
  },
  confirmFromTool(done: CompletedToolCall, accepted: readonly string[], ctx: TitleSurfaceContext) {
    const title = renameTitleFor(done, ctx);
    if (title === null) return null;
    const expected =
      accepted.includes(title) || (isDoneRequest(accepted) && isWritableDoneTitle(title));
    if (!expected) return null;
    return renameSucceeded(done.toolResponse, title) ? title : null;
  },
  failedAttempt(done: CompletedToolCall) {
    if (!isT3ThreadUpdateTool(done.toolName)) return false;
    const input = asRecord(done.toolInput) ?? {};
    if (input.action !== "rename") return false;
    const title = typeof input.title === "string" ? input.title : "";
    return !title || !renameSucceeded(done.toolResponse, title);
  },
};
