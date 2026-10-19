import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { stableDigest } from "../durable-record.ts";
import { containsPath } from "./paths.ts";
import type { WorkspaceClaim } from "./state.ts";
import { isWorkspaceAllocationRequest } from "./validate.ts";

export function assertClaimAuthority(claim: WorkspaceClaim, providerId: string, id: string): void {
  if (
    claim?.schema_version !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(providerId) ||
    claim.provider_id !== providerId ||
    claim.provider_version !== "1" ||
    claim.binding_id !== id ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) ||
    !isWorkspaceAllocationRequest(claim.request) ||
    claim.request.provider_id !== providerId ||
    stableDigest(claim.request) !== claim.request_sha256 ||
    !/^[a-f0-9]{64}$/.test(claim.recovery_token) ||
    stableDigest(claim.writable_root) !== stableDigest(claim.request.selected_writable_root)
  ) {
    throw new Error("retained workspace claim authority is unproven");
  }
  for (const path of claimPaths(claim)) {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
      throw new Error("retained workspace claim path is unproven");
    }
  }
  if (!containsPath(claim.workspace_root, claim.active_root)) {
    throw new Error("retained workspace active root escapes its claim");
  }
}

function claimPaths(claim: WorkspaceClaim): string[] {
  return [
    claim.workspace_root,
    claim.active_root,
    claim.repository?.source_root?.realpath,
    claim.repository?.common_dir?.realpath,
  ];
}

/** Include absent descendants without losing aliases in an existing ancestor. */
function physicalPath(path: string): string {
  const tail: string[] = [];
  let cursor = path;
  for (;;) {
    try {
      lstatSync(cursor);
      return resolve(realpathSync(cursor), ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(cursor) === cursor) {
        throw error;
      }
      // A dangling symlink must fail, rather than be treated as an absent directory.
      try {
        if (lstatSync(cursor).isSymbolicLink()) throw new Error("unresolved workspace alias");
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
      }
      tail.unshift(basename(cursor));
      cursor = dirname(cursor);
    }
  }
}

export function claimOverlapsWorkspace(claim: WorkspaceClaim, workspaceRoot: string): boolean {
  const targets = [workspaceRoot, physicalPath(workspaceRoot)];
  return claimPaths(claim).some((path, index) =>
    [path, physicalPath(path)].some((candidate) =>
      targets.some(
        (target) =>
          containsPath(target, candidate) || (index < 2 && containsPath(candidate, target)),
      ),
    ),
  );
}
