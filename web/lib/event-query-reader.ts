import { readCoordinationViewV3 } from "../../src/core/events/v3/coordination-view";
import { stableScopeId } from "../../src/core/workflow/scope-id";
import { coordRoot, type EventsResponse, readEvents } from "./coord-reader";
import { readWorkflowChildSessions, resolveRunCoordRoot } from "./workflow-reader";

export interface EventQueryOptions {
  limit?: number;
  instanceId?: string;
  type?: string;
  run?: string;
}

/** Resolve run children on every read, including children in another checkout. */
export function readEventQuery(options: EventQueryOptions = {}): EventsResponse {
  const localRoot = coordRoot();
  const runRoot = options.run ? resolveRunCoordRoot(localRoot, options.run) : undefined;
  const sessions = options.run
    ? new Set(
        readWorkflowChildSessions(localRoot, options.run, {
          coordinationRoot: runRoot?.root,
        }).map((child) => child.sessionId),
      )
    : undefined;
  if (options.run && sessions) {
    // Transcripts retain native session ids; ledger rows use canonical V3 ids.
    const view = readCoordinationViewV3(runRoot?.root ?? localRoot);
    const runId = stableScopeId("run", options.run);
    for (const child of [
      ...Object.values(view.instances),
      ...Object.values(view.terminal_generations),
    ]) {
      if (child.run_id === runId) sessions.add(child.session_id);
    }
  }
  return readEvents({
    limit: options.limit,
    instanceId: options.instanceId,
    type: options.type,
    sessions,
    root: runRoot?.foreign ? runRoot.root : undefined,
  });
}
