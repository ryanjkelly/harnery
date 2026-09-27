/**
 * Project the host's filesystem policy into a adapter's own vendor sandbox
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

import { builtinAdapterProfile } from "../adapters/profiles.ts";
import type { AdapterSandboxProjection } from "../adapters/types.ts";
import type { GitAdministrativeGrant, SpawnFilesystemPolicy, SpawnRequest } from "./types.ts";
import type { WorkspaceBinding } from "./workspaces/types.ts";

export class SandboxProjectionError extends Error {
  readonly adapter: string;
  readonly reason:
    | "mode_unrepresentable"
    | "writable_roots_unrepresentable"
    | "no_projection"
    | "writable_root_escapes_workspace"
    | "git_grant_unavailable"
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

/** True when `candidate` is `root` or lies beneath it, comparing whole path
 * segments so `/a/bc` is not treated as inside `/a/b`. */
function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

/**
 * Refuse a projection that would grant write access outside the root the
 * workspace provider already validated (ADR 0039).
 *
 * The renderer alone cannot do this: it never sees the binding. Granting a path
 * the provider never sanctioned would let a projection quietly widen the blast
 * radius of a run that the workspace lifecycle believes it has contained.
 */
export function assertProjectionWithinWorkspace(
  adapter: string,
  allowedRootRealpath: string,
  writableRoots: readonly string[],
): void {
  for (const root of writableRoots) {
    if (!isWithin(allowedRootRealpath, root)) {
      throw new SandboxProjectionError(
        adapter,
        "writable_root_escapes_workspace",
        `writable root ${JSON.stringify(root)} is outside the workspace root ${JSON.stringify(allowedRootRealpath)} the provider validated`,
      );
    }
  }
}

/**
 * Resolve a named Git administrative grant into concrete writable roots
 * (ADR 0040).
 *
 * These are the only paths a run may write outside its workspace, and the
 * caller never names them: they come from the binding the provider verified.
 * A caller-supplied path is checked by `assertProjectionWithinWorkspace` and can
 * never reach here, so asking for the grant is the whole of the widening.
 *
 * In a linked worktree both halves of the administrative directory live under
 * the source repository, and a commit needs the shared half regardless, so the
 * grant returns both rather than pretending the private half is useful alone.
 */
export function resolveGitGrantRoots(
  grant: GitAdministrativeGrant,
  binding: WorkspaceBinding | undefined,
): readonly string[] {
  if (grant === "none") return [];
  const repository = binding?.repository;
  if (!repository) {
    throw new SandboxProjectionError(
      "workflow",
      "git_grant_unavailable",
      `gitWrite "${grant}" needs a Git repository binding; this run has ${binding ? "a workspace with no repository" : "no isolated workspace"}`,
    );
  }
  // Deduplicated: a full-clone topology reports the same path for both, and a
  // repeated writable root is noise in the rendered argv and in proof.
  return [...new Set([repository.gitdir.realpath, repository.common_dir.realpath])];
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
