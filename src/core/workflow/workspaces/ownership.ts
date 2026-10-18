import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readJsonRecord, stableDigest } from "../durable-record.ts";
import { acquireNoClobberLease, type NoClobberLease } from "./leases.ts";
import { containsPath } from "./paths.ts";
import type { WorkspaceClaim } from "./state.ts";
import { isWorkspaceAllocationRequest } from "./validate.ts";

const STALE_MS = 5 * 60 * 1_000;
const RESERVATION_SCOPE = "workspace-reclaim";

function leaseRoot(coordRoot: string, providerId: string): string {
  return join(resolve(coordRoot), ".harnery", "workspaces", providerId, ".leases");
}

/** Serialize only publication and reservation registration, never Git work. */
function withPublicationGate<T>(coordRoot: string, providerId: string, operation: () => T): T {
  const authority = stableDigest({ provider_id: providerId, scope: "workspace-publication" });
  const gate = acquireNoClobberLease({
    path: join(leaseRoot(coordRoot, providerId), "publication.lock"),
    scope: "workspace-publication",
    authoritySha256: authority,
    staleAfterMs: STALE_MS,
    validateStaleOwner: (owner) => owner.authority_sha256 === authority,
  });
  try {
    return operation();
  } finally {
    gate.release();
  }
}

function reservationPath(coordRoot: string, claim: WorkspaceClaim): string {
  return join(leaseRoot(coordRoot, claim.provider_id), `reclaim-${claim.binding_id}.lock`);
}

function acquireReservation(coordRoot: string, claim: WorkspaceClaim): NoClobberLease {
  const authority = stableDigest(claim);
  return acquireNoClobberLease({
    path: reservationPath(coordRoot, claim),
    scope: RESERVATION_SCOPE,
    authoritySha256: authority,
    staleAfterMs: STALE_MS,
    metadata: { binding_id: claim.binding_id, request_sha256: claim.request_sha256 },
    validateStaleOwner: (owner) =>
      owner.authority_sha256 === authority &&
      owner.metadata?.binding_id === claim.binding_id &&
      owner.metadata?.request_sha256 === claim.request_sha256,
  });
}

export interface WorkspaceReclaimReservation {
  assertCurrent(): void;
  release(): void;
}

/** The immutable claim is the authority; the lease reserves its destructive path. */
export function reserveWorkspaceReclaim(
  coordRoot: string,
  claim: WorkspaceClaim,
): WorkspaceReclaimReservation {
  assertClaimAuthority(claim, claim.provider_id, claim.binding_id);
  const lease = withPublicationGate(coordRoot, claim.provider_id, () =>
    acquireReservation(coordRoot, claim),
  );
  return {
    assertCurrent() {
      const path = reservationPath(coordRoot, claim);
      const current = join(path, "current");
      const pin = join(path, lease.owner.owner_file);
      const a = lstatSync(current, { bigint: true });
      const b = lstatSync(pin, { bigint: true });
      if (
        !a.isFile() ||
        !b.isFile() ||
        a.dev !== b.dev ||
        a.ino !== b.ino ||
        readFileSync(current, "utf8") !== readFileSync(pin, "utf8") ||
        stableDigest(readJsonRecord(current, "reclaim reservation")) !== stableDigest(lease.owner)
      ) {
        throw new Error("workspace reclaim reservation owner changed");
      }
      const persisted = readJsonRecord<WorkspaceClaim>(
        join(dirname(dirname(path)), claim.binding_id, "claim.json"),
        "reserved workspace claim",
      );
      if (stableDigest(persisted) !== stableDigest(claim)) {
        throw new Error("workspace reclaim reservation claim changed");
      }
    },
    release: () => lease.release(),
  };
}

export function publishWorkspaceClaim<T>(
  coordRoot: string,
  claim: WorkspaceClaim,
  publish: () => T,
): T {
  assertClaimAuthority(claim, claim.provider_id, claim.binding_id);
  return withPublicationGate(coordRoot, claim.provider_id, () => {
    for (const entry of readdirSync(leaseRoot(coordRoot, claim.provider_id), {
      withFileTypes: true,
    })) {
      if (!entry.name.startsWith("reclaim-") || !entry.name.endsWith(".lock")) continue;
      if (!entry.isDirectory()) throw new Error("workspace reclaim reservation is not a directory");
      const path = join(leaseRoot(coordRoot, claim.provider_id), entry.name);
      const current = join(path, "current");
      try {
        lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const id = entry.name.slice("reclaim-".length, -".lock".length);
      const reserved = readJsonRecord<WorkspaceClaim>(
        join(dirname(leaseRoot(coordRoot, claim.provider_id)), id, "claim.json"),
        "reserved workspace claim",
      );
      assertClaimAuthority(reserved, claim.provider_id, id);
      // Unknown reservation authority is never interpreted as an unrelated owner.
      const owner = readJsonRecord<NoClobberLease["owner"]>(current, "reclaim reservation");
      if (
        owner.schema_version !== 1 ||
        typeof owner.owner_id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(owner.owner_id) ||
        owner.owner_file !== `owner-${owner.owner_id}.json` ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        typeof owner.host !== "string" ||
        owner.host.length === 0 ||
        !Number.isFinite(Date.parse(owner.created_at)) ||
        !Number.isFinite(Date.parse(owner.expires_at)) ||
        Date.parse(owner.expires_at) < Date.parse(owner.created_at) ||
        owner.scope !== RESERVATION_SCOPE ||
        owner.authority_sha256 !== stableDigest(reserved) ||
        owner.metadata?.binding_id !== id ||
        owner.metadata?.request_sha256 !== reserved.request_sha256
      ) {
        throw new Error("workspace reclaim reservation authority is unproven");
      }
      const a = lstatSync(current, { bigint: true });
      const pin = join(path, owner.owner_file);
      const b = lstatSync(pin, { bigint: true });
      if (
        !a.isFile() ||
        !b.isFile() ||
        a.dev !== b.dev ||
        a.ino !== b.ino ||
        readFileSync(current, "utf8") !== readFileSync(pin, "utf8")
      )
        throw new Error("workspace reclaim reservation owner is unproven");
      if (!claimOverlapsWorkspace(claim, reserved.workspace_root)) continue;
      // This succeeds only for an expired, provably dead, exact prior owner.
      // It retires the reservation, never the immutable claim or resource.
      const recovered = acquireReservation(coordRoot, reserved);
      recovered.release();
    }
    return publish();
  });
}

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
