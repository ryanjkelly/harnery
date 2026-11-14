import type { Adapter } from "../../adapter.ts";
import { nameBlockSurface } from "./surfaces/name-block.ts";
import { t3CodeSurface } from "./surfaces/t3-code.ts";
import type { SessionTitleState, SessionTitleSurface, TitleSurfaceContext } from "./types.ts";

/**
 * Registered title surfaces in priority order: the first whose `detect`
 * passes owns the session's title. The last entry must always match, so the
 * name block stays last and every session resolves to some surface.
 */
export const TITLE_SURFACES: readonly SessionTitleSurface[] = [t3CodeSurface, nameBlockSurface];

export function titleSurfaceById(id: string | undefined): SessionTitleSurface | undefined {
  if (!id) return undefined;
  return TITLE_SURFACES.find((surface) => surface.id === id);
}

/**
 * The surface that owns this session's title. A surface stored on the row
 * wins: it was resolved at mint time in the agent's shell, while a hook
 * process may lack the client's environment.
 */
export function resolveTitleSurface(
  ctx: TitleSurfaceContext,
  row?: SessionTitleState | null,
): SessionTitleSurface {
  const stored = titleSurfaceById(row?.session_title_surface);
  if (stored) return stored;
  return TITLE_SURFACES.find((surface) => surface.detect(ctx)) ?? nameBlockSurface;
}

export function titleSurfaceContext(
  adapter: Adapter | null,
  env: Readonly<Record<string, string | undefined>>,
  row?: SessionTitleState | null,
): TitleSurfaceContext {
  const ctx: TitleSurfaceContext = { adapter, env };
  const thread = row?.session_title_client_thread;
  if (thread) ctx.clientThreadId = thread;
  return ctx;
}

/**
 * The surface to ask for `owedTitle`. When the session's own surface already
 * failed to deliver that exact title, the name block is owed instead.
 */
export function titleSurfaceForRequest(
  ctx: TitleSurfaceContext,
  row: (SessionTitleState & { suggested_session_name?: string }) | null | undefined,
  owedTitle: string,
): SessionTitleSurface {
  if (row?.session_title_fallback_for === owedTitle) return nameBlockSurface;
  return resolveTitleSurface(ctx, row);
}
