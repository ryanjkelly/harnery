import type { Adapter } from "../../adapter.ts";

/**
 * A delegation surface is a client that starts worker sessions through a
 * delegate tool of its own (ADR 0268). Harnery cannot see inside that client,
 * so a surface names the one opaque identifier both sides can observe: the
 * parent reads it from the delegate tool's result, the child reads it from
 * its own environment. Equal keys link the two sessions; nothing else does.
 *
 * Surfaces return only the opaque key. Task text, prompts and summaries in
 * the same tool result are never read past the key field and never recorded.
 */
export interface DelegationSurface {
  /** Stable id recorded with each key so keys from different clients never meet. */
  id: string;
  /** Whether `toolName` is this client's delegate tool. */
  isDelegateTool(toolName: string | undefined): boolean;
  /** The child key in the delegate tool's result, or undefined when absent or malformed. */
  childKeyFromResult(toolResponse: unknown): string | undefined;
  /** The key a child session reads from its own environment, when it is a delegated child. */
  childKeyFromEnv(
    env: Readonly<Record<string, string | undefined>>,
    adapter: Adapter | null,
  ): string | undefined;
}

/** A key observed on one side, tagged with the surface that produced it. */
export interface DelegationKeyObservation {
  surface: string;
  key: string;
}
