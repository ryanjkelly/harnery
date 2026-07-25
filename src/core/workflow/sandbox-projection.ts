/**
 * Project the host's filesystem policy into a harness's own vendor sandbox
 * (ADR 0039).
 *
 * Harnery decides where a workflow child may write. Until this existed it never
 * told the child, so a child working in a provider-owned Git worktree could
 * edit files and could not commit: the vendor excludes a repository's
 * administrative directory from its writable set by policy, and Harnery had no
 * way to name it as an exception.
 *
 * The one rule that matters here is that a projection an adapter cannot
 * represent is refused before launch. Passing a policy that gets silently
 * dropped would leave an operator believing a child was constrained when it was
 * not, which is worse than refusing and worse than never offering the feature.
 */

import type { HarnessSandboxProjection } from "../harnesses/types.ts";
import type { SpawnFilesystemPolicy } from "./types.ts";

export class SandboxProjectionError extends Error {
  readonly harness: string;
  readonly reason: "mode_unrepresentable" | "writable_roots_unrepresentable" | "no_projection";

  constructor(harness: string, reason: SandboxProjectionError["reason"], message: string) {
    super(message);
    this.name = "SandboxProjectionError";
    this.harness = harness;
    this.reason = reason;
  }
}

export interface ResolvedSandboxProjection {
  /** Vendor-native name for the requested mode. */
  nativeMode: string;
  writableRoots: readonly string[];
}

/**
 * Resolve a requested policy against what the adapter declares it can carry.
 * Throws rather than degrading; see the module note.
 */
export function resolveSandboxProjection(
  harness: string,
  declaration: HarnessSandboxProjection | undefined,
  policy: SpawnFilesystemPolicy,
): ResolvedSandboxProjection {
  if (!declaration) {
    throw new SandboxProjectionError(
      harness,
      "no_projection",
      `${harness} cannot project a filesystem policy into its sandbox; remove the policy or use a harness that can`,
    );
  }
  const nativeMode = declaration.modes[policy.mode];
  if (!nativeMode) {
    throw new SandboxProjectionError(
      harness,
      "mode_unrepresentable",
      `${harness} does not distinguish the "${policy.mode}" filesystem mode, so it cannot be enforced`,
    );
  }
  const writableRoots = policy.writableRoots ?? [];
  if (writableRoots.length > 0 && !declaration.writableRoots) {
    throw new SandboxProjectionError(
      harness,
      "writable_roots_unrepresentable",
      `${harness} does not accept an explicit writable-root set, so ${writableRoots.length} declared path(s) could not be enforced`,
    );
  }
  for (const root of writableRoots) {
    // Relative paths cannot be validated against the provider's roots and are
    // resolved differently by every vendor, so they are refused outright.
    if (typeof root !== "string" || !root.startsWith("/")) {
      throw new SandboxProjectionError(
        harness,
        "writable_roots_unrepresentable",
        `writable root ${JSON.stringify(root)} must be an absolute path`,
      );
    }
  }
  return { nativeMode, writableRoots };
}
