import { resolveName } from "../agents/state/names.ts";
import { coordFreshnessSeconds } from "../config.ts";
import {
  type CoordinationGenerationViewV3,
  type CoordinationViewV3,
  readCoordinationViewV3,
  requireAuthoritySafeCoordinationViewV3,
} from "../events/v3/coordination-view.ts";
import {
  liveInstanceIdV3,
  nativeInstanceIdV3,
  observeLiveEventLedgerRouteV3,
} from "../events/v3/live-route-observer.ts";

export interface MessageTargetInput {
  name?: string;
  instanceId?: string;
  requireLive?: boolean;
  now?: Date;
}

export type MessageTargetResult =
  | {
      ok: true;
      target: { instance_id: string; name: string; delivery: "written-live" | "queued" };
    }
  | {
      ok: false;
      code: "no_peer" | "ambiguous_peer" | "not_live" | "authority_unsafe";
      message: string;
      candidates?: string[];
    };

/** Resolve one immutable recipient without extending presence or claiming attention. */
export function resolveMessageTarget(
  coordRoot: string,
  input: MessageTargetInput,
): MessageTargetResult {
  const requestedName = normalizeName(input.name);
  const requestedInstance = input.instanceId?.trim();
  if (!requestedName && !requestedInstance) {
    return { ok: false, code: "no_peer", message: "Supply an exact agent name or instance id." };
  }
  const now = input.now?.getTime() ?? Date.now();
  if (!Number.isFinite(now)) return unsafe("The message addressing clock is invalid.");

  let view: CoordinationViewV3;
  try {
    if (observeLiveEventLedgerRouteV3(coordRoot).state === "blocked") {
      return unsafe("The event ledger cannot establish message recipient authority.");
    }
    view = requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(coordRoot));
    if (!view.source_complete) return unsafe("The event ledger read is incomplete.");
  } catch {
    return unsafe("The event ledger cannot establish message recipient authority.");
  }

  // Address historical instances without reopening them. A current generation
  // wins over its own terminal history; otherwise use its last ledger position.
  const byInstance = new Map<string, CoordinationGenerationViewV3>();
  for (const generation of Object.values(view.terminal_generations)) {
    const prior = byInstance.get(generation.instance_id);
    if (!prior || laterPosition(generation, prior))
      byInstance.set(generation.instance_id, generation);
  }
  for (const generation of Object.values(view.instances))
    byInstance.set(generation.instance_id, generation);
  const freshnessMs = coordFreshnessSeconds(coordRoot) * 1_000;
  const candidates = [...byInstance.values()].flatMap((generation) => {
    const instanceId = nativeInstanceIdV3(generation.instance_id);
    const name = resolveName(coordRoot, instanceId)?.name;
    if (!name) return [];
    if (requestedInstance && liveInstanceIdV3(requestedInstance) !== generation.instance_id)
      return [];
    if (requestedName && normalizeName(name) !== requestedName) return [];
    const age = now - Date.parse(generation.last_observed_at);
    const diagnostics = view.diagnostics_by_generation[generation.generation_id] ?? [];
    return [
      {
        instanceId,
        name,
        safe: !diagnostics.some((diagnostic) => diagnostic.authority_blocking),
        fresh:
          generation.phase === "live" && Number.isFinite(age) && age >= 0 && age <= freshnessMs,
      },
    ];
  });

  if (candidates.length === 0) {
    return {
      ok: false,
      code: "no_peer",
      message: "No known agent matches that exact name and instance.",
    };
  }
  if (candidates.some((candidate) => !candidate.safe)) {
    return unsafe("A matching agent generation does not have safe coordination authority.");
  }
  const fresh = candidates.filter((candidate) => candidate.fresh);
  const selected = requestedInstance ? candidates : fresh.length > 0 ? fresh : candidates;
  if (selected.length !== 1) {
    return {
      ok: false,
      code: "ambiguous_peer",
      message: "Several agent instances hold that exact name; specify --instance-id.",
      candidates: selected.map(({ instanceId }) => instanceId).sort(),
    };
  }
  const target = selected[0]!;
  if (input.requireLive && !target.fresh) {
    return {
      ok: false,
      code: "not_live",
      message:
        "That agent is known but outside live presence; omit --require-live to queue its message.",
    };
  }
  return {
    ok: true,
    target: {
      instance_id: target.instanceId,
      name: target.name,
      delivery: target.fresh ? "written-live" : "queued",
    },
  };
}

function laterPosition(
  left: CoordinationGenerationViewV3,
  right: CoordinationGenerationViewV3,
): boolean {
  return (
    left.source_position.segment_ordinal > right.source_position.segment_ordinal ||
    (left.source_position.segment_ordinal === right.source_position.segment_ordinal &&
      left.source_position.byte_offset > right.source_position.byte_offset)
  );
}

function normalizeName(name: string | undefined): string {
  return (name ?? "")
    .trim()
    .replace(/^agent-/i, "")
    .toLowerCase();
}

function unsafe(message: string): MessageTargetResult {
  return { ok: false, code: "authority_unsafe", message };
}
