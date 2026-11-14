/**
 * Hook-side decisions for delivering a pending session title through the
 * session's title surface (ADR 0247).
 *
 * The functions here are pure: they read the coordination row and the tool
 * call and say what the hook should do. `cli.ts` performs the stamps, debug
 * lines, and output, inside its own fail-open try/catch blocks. Keeping the
 * decisions separate lets them be tested without spawning hook processes.
 *
 * The name block (ADR 0085) is the fallback for every surface, so a session
 * with no other surface takes exactly the paths it took before surfaces
 * existed.
 */

import type { Adapter } from "../adapter.ts";
import {
  type SessionNameDisplayState,
  sessionNameDisplayAcceptedNames,
  sessionNameDisplayInstruction,
  sessionNameDisplayPending,
  sessionNameDisplayRecoveryInstruction,
} from "../agents/session-name-display.ts";
import { titleChangeAllowed } from "../agents/session-title/policy.ts";
import { titleSurfaceContext, titleSurfaceForRequest } from "../agents/session-title/registry.ts";
import {
  type CompletedToolCall,
  NAME_BLOCK_SURFACE_ID,
  type SessionTitleState,
  type SessionTitleSurface,
  type TitleSurfaceContext,
  type ToolCall,
} from "../agents/session-title/types.ts";

export type TitleRow = SessionNameDisplayState & SessionTitleState;

/** Everything a hook needs to act on the title owed for this session. */
export interface PendingTitleRequest {
  owed: string;
  accepted: string[];
  ctx: TitleSurfaceContext;
  surface: SessionTitleSurface;
}

export function pendingTitleRequest(
  adapter: Adapter | null,
  env: Readonly<Record<string, string | undefined>>,
  row: TitleRow | null | undefined,
): PendingTitleRequest | null {
  const owed = sessionNameDisplayPending(row);
  if (!owed) return null;
  const ctx = titleSurfaceContext(adapter, env, row);
  return {
    owed,
    accepted: sessionNameDisplayAcceptedNames(row),
    ctx,
    surface: titleSurfaceForRequest(ctx, row, owed),
  };
}

/**
 * True when a title was already written to the client and the policy forbids
 * replacing it with the owed one. The owed name is then recorded as shown
 * without asking the agent for anything: a client title changes only at
 * session start and at done.
 */
export function titleChangeSuppressed(row: TitleRow | null | undefined, owed: string): boolean {
  const applied = row?.session_title_applied_for;
  return Boolean(applied) && !titleChangeAllowed(applied, owed);
}

export type PostToolTitleDecision =
  | { kind: "suppressed"; applied: string }
  | { kind: "instruct"; text: string }
  | { kind: "applied"; title: string; drift: boolean }
  | { kind: "fallback"; text: string; reason: string; first: boolean }
  | { kind: "remind"; allowedWhilePending: boolean };

/**
 * What PostToolUse should do for one completed call while a title is owed.
 * `minted` is whether the call's result minted or retried the owed name.
 */
export function postToolTitleDecision(
  request: PendingTitleRequest,
  row: TitleRow | null | undefined,
  done: CompletedToolCall,
  minted: boolean,
): PostToolTitleDecision {
  const { owed, accepted, ctx, surface } = request;
  if (titleChangeSuppressed(row, owed)) {
    return { kind: "suppressed", applied: row?.session_title_applied_for ?? "" };
  }
  if (minted) return { kind: "instruct", text: surface.instruction(owed, ctx) };
  const confirmed = surface.confirmFromTool?.(done, accepted, ctx) ?? null;
  if (confirmed) return { kind: "applied", title: confirmed, drift: confirmed !== owed };
  const failed = failedTitleAttempt(request, row, done);
  if (failed) return failed;
  const call: ToolCall = { toolName: done.toolName, toolInput: done.toolInput };
  return {
    kind: "remind",
    allowedWhilePending: surface.allowsWhilePending?.(call, accepted, ctx) ?? false,
  };
}

/**
 * A rename attempt on the session's own surface that did not succeed. The
 * name block is owed instead; `first` is false when the fallback was already
 * recorded for this title, so the instruction is sent once.
 */
export function failedTitleAttempt(
  request: PendingTitleRequest,
  row: TitleRow | null | undefined,
  done: CompletedToolCall,
): Extract<PostToolTitleDecision, { kind: "fallback" }> | null {
  const { owed, ctx, surface } = request;
  if (surface.id === NAME_BLOCK_SURFACE_ID) return null;
  if (!surface.failedAttempt?.(done, ctx)) return null;
  return {
    kind: "fallback",
    text: sessionNameDisplayInstruction(owed),
    reason: `${surface.id}-rename-failed`,
    first: row?.session_title_fallback_for !== owed,
  };
}

export type PreToolTitleDecision =
  | { kind: "suppressed"; applied: string }
  | { kind: "allow" }
  | { kind: "inspect" };

/**
 * PreToolUse gate for a call made while a title is owed, after the workflow
 * and remediation exemptions. `inspect` means the caller should look for a
 * correctly placed name block, which closes the latch on every surface.
 */
export function preToolTitleDecision(
  request: PendingTitleRequest,
  row: TitleRow | null | undefined,
  call: ToolCall,
): PreToolTitleDecision {
  const { owed, accepted, ctx, surface } = request;
  if (titleChangeSuppressed(row, owed)) {
    return { kind: "suppressed", applied: row?.session_title_applied_for ?? "" };
  }
  if (surface.allowsWhilePending?.(call, accepted, ctx)) return { kind: "allow" };
  return { kind: "inspect" };
}

/** The denial text for a call the gate refuses, worded by the owed surface. */
export function titleGateDenial(request: PendingTitleRequest, binName: string): string {
  const { owed, ctx, surface } = request;
  if (surface.id === NAME_BLOCK_SURFACE_ID) {
    return sessionNameDisplayRecoveryInstruction(owed, binName);
  }
  return [
    surface.instruction(owed, ctx),
    "",
    `If the rename already succeeded but the gate still rejects tools, run \`${binName} agents suggest-name --json\` as the only tool call.`,
  ].join("\n");
}
