import type { Adapter } from "../adapter.ts";
import { projectCoordinationViewV3 } from "../events/v3/coordination-view.ts";
import { liveInstanceIdV3 } from "../events/v3/live-route-observer.ts";
import { reduceSafetyProjectionV3 } from "../events/v3/projection.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";
import { generationHasWaitingRowsV3 } from "../events/v3/writer.ts";
import { canonicalClaimPath } from "./claim-path.ts";
import {
  type LiveCoordinationAuthorityV3Result,
  recordLiveClaimChangeV3,
} from "./live-authority-v3.ts";
import { GENERATION_ROWS_WAITING_V3 } from "./live-lifecycle-v3.ts";

export interface ReleaseClaimOnBehalfV3Input {
  coordRoot: string;
  /** The session doing the release; the event lands in its scope. */
  owner: string;
  /** The session whose claim is released. */
  subject: string;
  /** The owner's native session id. */
  nativeSessionId: string;
  adapter: Adapter;
  path: string;
}

export type ReleaseClaimOnBehalfV3Result =
  | {
      state: "released";
      acquired_event_id: `evt_${string}`;
      result: LiveCoordinationAuthorityV3Result;
    }
  | { state: "skipped"; reason: typeof GENERATION_ROWS_WAITING_V3 | "claim_not_held" };

/**
 * Release a write claim another session holds, under the rule for producers
 * that act on another generation.
 *
 * The release lands in the owner's scope and its own chain does not order it
 * after the subject's rows. So it releases only a claim the canonical
 * coordination view shows the subject holding, cites that claim's
 * acquisition in `links.caused_by`, and is skipped while the ledger door
 * holds rows of the subject's generation. A skipped release changes nothing;
 * the caller retries on its next pass.
 */
export function releaseClaimOnBehalfV3(
  input: ReleaseClaimOnBehalfV3Input,
): ReleaseClaimOnBehalfV3Result {
  const subjectId = liveInstanceIdV3(input.subject);
  const canonical = canonicalClaimPath(input.coordRoot, input.path);
  // The predicate drains the queue first, which can admit a new generation
  // for the subject; judge each generation the view names until it is stable.
  const judged = new Set<string>();
  for (;;) {
    const read = readLedgerV3(input.coordRoot);
    const view = projectCoordinationViewV3(read);
    const generation = view.instances[subjectId];
    if (generation?.phase !== "live") {
      return { state: "skipped", reason: "claim_not_held" };
    }
    if (!judged.has(generation.generation_id)) {
      judged.add(generation.generation_id);
      if (generationHasWaitingRowsV3(input.coordRoot, generation.generation_id)) {
        return { state: "skipped", reason: GENERATION_ROWS_WAITING_V3 };
      }
      continue;
    }
    if (!view.source_complete || !generation.files_touched.includes(canonical)) {
      return { state: "skipped", reason: "claim_not_held" };
    }
    const claim = Object.values(reduceSafetyProjectionV3(read).claims).find(
      (candidate) =>
        candidate.subject_instance_id === subjectId &&
        candidate.access === "write" &&
        candidate.target_kind === "workspace_path" &&
        candidate.target_display === canonical,
    );
    if (!claim) return { state: "skipped", reason: "claim_not_held" };
    const acquired = claim.acquired_event_id as `evt_${string}`;
    const result = recordLiveClaimChangeV3({
      coordRoot: input.coordRoot,
      owner: input.owner,
      subject: input.subject,
      nativeSessionId: input.nativeSessionId,
      adapter: input.adapter,
      operation: "released",
      path: canonical,
      access: "write",
      causedBy: [acquired],
    });
    return { state: "released", acquired_event_id: acquired, result };
  }
}
