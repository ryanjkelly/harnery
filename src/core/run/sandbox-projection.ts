/**
 * Project the host's filesystem policy into a adapter's own vendor sandbox
 * (ADR 0039).
 *
 * Harnery decides where a workflow child may write and tells the child's own
 * vendor sandbox, instead of trusting each adapter's defaults.
 *
 * The one rule that matters here is that a projection an adapter cannot
 * represent is refused before launch. Passing a policy that gets silently
 * dropped would leave an operator believing a child was constrained when it was
 * not, which is worse than refusing and worse than never offering the feature.
 */

import { builtinAdapterProfile } from "../adapters/profiles.ts";
import type { AdapterSandboxProjection } from "../adapters/types.ts";
import type { SpawnFilesystemPolicy, SpawnRequest } from "./types.ts";

export class SandboxProjectionError extends Error {
  readonly adapter: string;
  readonly reason:
    | "mode_unrepresentable"
    | "writable_roots_unrepresentable"
    | "no_projection"
    | "full_access_unrepresentable"
    | "full_access_conflicts_with_policy";

  constructor(adapter: string, reason: SandboxProjectionError["reason"], message: string) {
    super(message);
    this.name = "SandboxProjectionError";
    this.adapter = adapter;
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
  adapter: string,
  declaration: AdapterSandboxProjection | undefined,
  policy: SpawnFilesystemPolicy,
): ResolvedSandboxProjection {
  if (!declaration) {
    throw new SandboxProjectionError(
      adapter,
      "no_projection",
      `${adapter} cannot project a filesystem policy into its sandbox; remove the policy or use a adapter that can`,
    );
  }
  const nativeMode = declaration.modes[policy.mode];
  if (!nativeMode) {
    throw new SandboxProjectionError(
      adapter,
      "mode_unrepresentable",
      `${adapter} does not distinguish the "${policy.mode}" filesystem mode, so it cannot be enforced`,
    );
  }
  const writableRoots = policy.writableRoots ?? [];
  if (writableRoots.length > 0 && !declaration.writableRoots) {
    throw new SandboxProjectionError(
      adapter,
      "writable_roots_unrepresentable",
      `${adapter} does not accept an explicit writable-root set, so ${writableRoots.length} declared path(s) could not be enforced`,
    );
  }
  for (const root of writableRoots) {
    // Relative paths cannot be validated against the provider's roots and are
    // resolved differently by every vendor, so they are refused outright.
    if (typeof root !== "string" || !root.startsWith("/")) {
      throw new SandboxProjectionError(
        adapter,
        "writable_roots_unrepresentable",
        `writable root ${JSON.stringify(root)} must be an absolute path`,
      );
    }
  }
  return { nativeMode, writableRoots };
}

/**
 * The vendor arguments for an unsandboxed launch, or undefined for an ordinary
 * sandboxed one (ADR 0192).
 *
 * The engine decides whether a worker qualifies; this only renders the result,
 * and refuses rather than degrades. An adapter with no declared full-access
 * rendering cannot honor the request, and a request that also carries a
 * filesystem policy asks for two contradictory things, so both fail before
 * launch instead of silently picking one.
 */
export function resolveFullAccessArgv(
  adapter: string,
  req: Pick<SpawnRequest, "access" | "filesystemPolicy">,
): readonly string[] | undefined {
  if (req.access !== "full-access") return undefined;
  if (req.filesystemPolicy) {
    throw new SandboxProjectionError(
      adapter,
      "full_access_conflicts_with_policy",
      `${adapter} was asked for full access and a "${req.filesystemPolicy.mode}" filesystem policy at once; a launch gets one or the other`,
    );
  }
  const rendering = builtinAdapterProfile(adapter)?.fullAccess;
  if (!rendering) {
    throw new SandboxProjectionError(
      adapter,
      "full_access_unrepresentable",
      `${adapter} declares no full-access mode, so a worker on it cannot run without its sandbox`,
    );
  }
  return rendering.argv;
}
