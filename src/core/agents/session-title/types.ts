import type { Adapter } from "../../adapter.ts";

/**
 * A title surface is the place a session's title lives and the way Harnery
 * gets a title onto it. ADR 0247 owns the reasoning; this file is the frozen
 * contract every surface, hook handler, and command builds against.
 *
 * Three deliveries cover every client we know of or expect:
 *
 * - `display`: the agent prints the copyable name block and a person copies it.
 *   This is the portable default (ADR 0085) and the fallback for every other
 *   delivery.
 * - `agent-tool`: the client gave the agent a rename tool. Harnery instructs
 *   the agent to call it and confirms the call from the PostToolUse payload.
 * - `direct`: Harnery's own hook process calls a client command or API. No
 *   client offers one yet; the slot exists so adding one changes no caller.
 */
export type TitleDelivery = "display" | "agent-tool" | "direct";

export const NAME_BLOCK_SURFACE_ID = "name-block";
export const T3_CODE_SURFACE_ID = "t3-code";

/** What a surface may look at to decide whether it applies and how to word itself. */
export interface TitleSurfaceContext {
  adapter: Adapter | null;
  env: Readonly<Record<string, string | undefined>>;
  /**
   * The client's own id for this session's thread, when the surface was
   * resolved at mint time and stored on the coordination row. Hook processes
   * do not always inherit the client's environment, so a surface must prefer
   * this over `env` when both are present.
   */
  clientThreadId?: string;
}

/** A tool call as PreToolUse sees it. */
export interface ToolCall {
  toolName: string | undefined;
  toolInput: unknown;
}

/** A finished tool call as PostToolUse sees it. */
export interface CompletedToolCall extends ToolCall {
  toolResponse: unknown;
}

export type ApplyResult = { ok: true } | { ok: false; reason: string };

export interface SessionTitleSurface {
  id: string;
  delivery: TitleDelivery;
  /** Whether this surface owns the title for the session described by `ctx`. */
  detect(ctx: TitleSurfaceContext): boolean;
  /**
   * The client's id for this session's thread, read at mint time so it can be
   * stored on the coordination row. Absent for surfaces with no such id.
   */
  clientThreadId?(ctx: TitleSurfaceContext): string | undefined;
  /** The full instruction sent when a title is owed. */
  instruction(title: string, ctx: TitleSurfaceContext): string;
  /** The bounded follow-up nudge for a title still owed after an ordinary tool. */
  reminder(title: string, ctx: TitleSurfaceContext): string;
  /** The one-line version carried in command JSON (`note`). */
  note: string;
  /**
   * agent-tool: whether this call is part of delivering the owed title and so
   * must pass the pending-title gate. `accepted` lists every title whose exact
   * delivery satisfies the current request.
   */
  allowsWhilePending?(
    call: ToolCall,
    accepted: readonly string[],
    ctx: TitleSurfaceContext,
  ): boolean;
  /**
   * agent-tool: the accepted title this completed call wrote to the client, or
   * null when the call is unrelated, failed, or wrote something else.
   */
  confirmFromTool?(
    done: CompletedToolCall,
    accepted: readonly string[],
    ctx: TitleSurfaceContext,
  ): string | null;
  /**
   * agent-tool: whether this completed call was an attempt at this surface's
   * rename that did not succeed, so the caller falls back to the name block.
   */
  failedAttempt?(done: CompletedToolCall, ctx: TitleSurfaceContext): boolean;
  /** direct: write the title from Harnery's own process. */
  apply?(title: string, ctx: TitleSurfaceContext): Promise<ApplyResult>;
}

/**
 * Title fields on the coordination row. They sit beside the name-display
 * fields (`suggested_session_name`, `session_name_seen_for`, ...) and follow
 * the same projection path.
 */
export interface SessionTitleState {
  /** Surface id resolved when the name was minted. */
  session_title_surface?: string;
  /** The client's thread id captured at mint time (see TitleSurfaceContext). */
  session_title_client_thread?: string;
  /** The title a writing surface confirmed on the client. */
  session_title_applied_for?: string;
  /** The owed title for which the surface's own delivery failed; the name block is owed instead. */
  session_title_fallback_for?: string;
}
