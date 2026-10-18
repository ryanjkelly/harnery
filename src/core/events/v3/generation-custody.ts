import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { acquireNoClobberLease } from "../../workflow/workspaces/leases.ts";
import { readHookProducerStateByInstanceV3 } from "./producers/recorder.ts";

const held = new Set<string>();

/** Serialize synchronous authority work with generation changes for these instances only. */
export function withGenerationCustodyV3<T>(
  coordRoot: string,
  instanceIds: readonly string[],
  operation: () => T,
): T {
  const ids = [...new Set(instanceIds)].sort();
  for (const id of ids) {
    if (!/^inst_[a-zA-Z0-9._-]{1,128}$/.test(id)) {
      throw new Error("generation custody instance is invalid");
    }
  }
  const enter = (index: number): T => {
    const id = ids[index];
    if (id === undefined) return operation();
    const key = `${resolve(coordRoot)}\0${id}`;
    if (held.has(key)) return enter(index + 1);
    const authority = createHash("sha256").update(key).digest("hex");
    const lease = acquireNoClobberLease({
      // Custody spans epoch rotation; the ledger directory itself is archived.
      path: join(coordRoot, ".harnery", "private", "event-v3-generation-custody", authority),
      scope: "event-v3-generation-custody",
      authoritySha256: authority,
      // Expiry never permits stealing a live/unknown owner. A dead local process
      // can be recovered immediately, including after a cache-handoff crash.
      staleAfterMs: 1,
      validateStaleOwner: (owner) =>
        owner.host === hostname() && owner.authority_sha256 === authority,
    });
    held.add(key);
    try {
      return enter(index + 1);
    } finally {
      held.delete(key);
      lease.release();
    }
  };
  return enter(0);
}

/** The event already durably binds the generation; replay must not rebind its actor. */
export function assertCurrentGenerationV3(
  coordRoot: string,
  instanceId: string,
  generationId: string | undefined,
): void {
  const current = readHookProducerStateByInstanceV3(coordRoot, instanceId as `inst_${string}`);
  if (!generationId || !current || current.generation_id !== generationId) {
    throw new Error("authority_generation_changed");
  }
}
