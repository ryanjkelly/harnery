import type { Adapter } from "../../adapter.ts";
import { t3CodeDelegationSurface } from "./surfaces/t3-code.ts";
import type { DelegationKeyObservation, DelegationSurface } from "./types.ts";

/** Registered delegation surfaces (ADR 0268). Order does not matter: keys are surface-tagged. */
export const DELEGATION_SURFACES: readonly DelegationSurface[] = [t3CodeDelegationSurface];

/** The surface whose delegate tool this is, or undefined. Never throws. */
export function delegationSurfaceForTool(
  toolName: string | undefined,
): DelegationSurface | undefined {
  try {
    return DELEGATION_SURFACES.find((surface) => surface.isDelegateTool(toolName));
  } catch {
    return undefined;
  }
}

/** The parent-side key from a finished delegate tool call, or undefined. Never throws. */
export function delegationKeyFromToolResult(
  toolName: string | undefined,
  toolResponse: unknown,
): DelegationKeyObservation | undefined {
  const surface = delegationSurfaceForTool(toolName);
  if (!surface) return undefined;
  try {
    const key = surface.childKeyFromResult(toolResponse);
    return key ? { surface: surface.id, key } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The child-side key from this session's environment. Exactly one surface
 * may claim the session; two would be ambiguous, so neither counts.
 */
export function delegationKeyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  adapter: Adapter | null,
): DelegationKeyObservation | undefined {
  const found: DelegationKeyObservation[] = [];
  for (const surface of DELEGATION_SURFACES) {
    try {
      const key = surface.childKeyFromEnv(env, adapter);
      if (key) found.push({ surface: surface.id, key });
    } catch {
      /* a broken surface links nothing */
    }
  }
  return found.length === 1 ? found[0] : undefined;
}
