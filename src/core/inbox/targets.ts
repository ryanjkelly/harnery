import { resolveMachineLabel } from "../../lib/machine.ts";
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
import { sanitizeRefComponent } from "../presence/git.ts";
import { readRemoteMachines } from "../presence/index.ts";
import { knownRemoteSenders } from "../presence/mail.ts";

export interface MessageTargetInput {
  name?: string;
  instanceId?: string;
  /** Refuse a later generation of the same immutable instance. */
  generationId?: string;
  requireLive?: boolean;
  now?: Date;
}

export type MessageTargetResult =
  | {
      ok: true;
      target: {
        instance_id: string;
        name: string;
        delivery: "written-live" | "queued" | "remote";
        /** Set when the recipient lives on another machine (ADR 0222). */
        machine?: string;
        /** Local destination label; machine remains reserved for remote transport. */
        local_machine?: string;
        remote_namesakes?: RemoteNamesake[];
        routing_note?: string;
      };
    }
  | {
      ok: false;
      code: "no_peer" | "ambiguous_peer" | "not_live" | "authority_unsafe" | "generation_mismatch";
      message: string;
      candidates?: string[];
    };

interface RemoteNamesake {
  name: string;
  machine: string;
  instance_id: string;
  address: string;
}

/** Resolve one immutable recipient without extending presence or claiming attention. */
export function resolveMessageTarget(
  coordRoot: string,
  input: MessageTargetInput,
  options: { view?: CoordinationViewV3 } = {},
): MessageTargetResult {
  const address = parseAddress(input.name);
  if (!address) return { ok: false, code: "no_peer", message: "Use name or name@machine." };
  const requestedName = address.name;
  const requestedInstance = input.instanceId?.trim();
  const localMachine = sanitizeRefComponent(resolveMachineLabel());
  const explicitLocal = address.machine === localMachine;
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
    view = requireAuthoritySafeCoordinationViewV3(
      options.view ?? readCoordinationViewV3(coordRoot),
    );
    if (!view.source_complete) return unsafe("The event ledger read is incomplete.");
  } catch {
    return unsafe("The event ledger cannot establish message recipient authority.");
  }

  if (address.machine && !explicitLocal) {
    return (
      resolveRemoteMessageTarget(coordRoot, input) ?? {
        ok: false,
        code: "no_peer",
        message: `No known agent matches that address on ${address.machine}.`,
      }
    );
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
        generationId: generation.generation_id,
        safe: !diagnostics.some((diagnostic) => diagnostic.authority_blocking),
        fresh:
          generation.phase === "live" && Number.isFinite(age) && age >= 0 && age <= freshnessMs,
      },
    ];
  });

  if (candidates.length === 0) {
    return (
      (!explicitLocal && resolveRemoteMessageTarget(coordRoot, input)) || {
        ok: false,
        code: "no_peer",
        message: "No known agent matches that exact name and instance.",
      }
    );
  }
  if (candidates.some((candidate) => !candidate.safe)) {
    return unsafe("A matching agent generation does not have safe coordination authority.");
  }
  const fresh = candidates.filter((candidate) => candidate.fresh);
  // An old local binding must not hide a live namesake on another machine.
  // Exact instance/generation and machine addresses always retain their scope.
  if (!fresh.length && !requestedInstance && !input.generationId && !explicitLocal) {
    const remote = resolveRemoteMessageTarget(coordRoot, { ...input, requireLive: true });
    if (remote?.ok || (remote && remote.code === "ambiguous_peer")) return remote;
  }
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
  if (input.generationId && input.generationId !== target.generationId) {
    return {
      ok: false,
      code: "generation_mismatch",
      message: "The recipient generation differs from the exact requested generation.",
    };
  }
  if (input.requireLive && !target.fresh) {
    return {
      ok: false,
      code: "not_live",
      message:
        "That agent is known but outside live presence; omit --require-live to queue its message.",
    };
  }
  const remoteNamesakes =
    requestedName && !address.machine ? liveRemoteNamesakes(coordRoot, requestedName) : [];
  return {
    ok: true,
    target: {
      instance_id: target.instanceId,
      name: target.name,
      delivery: target.fresh ? "written-live" : "queued",
      local_machine: localMachine,
      ...(remoteNamesakes.length
        ? {
            remote_namesakes: remoteNamesakes,
            routing_note: `Selected the local agent on ${localMachine}. Live remote namesakes: ${remoteNamesakes.map(({ address, instance_id }) => `${address} (--instance-id ${instance_id})`).join(", ")}. Use a machine address to select one.`,
          }
        : {}),
    },
  };
}

/**
 * Resolve a recipient on another machine. Candidates come from peer presence (live
 * or stale) and from senders this machine has received mail from. Returns
 * null when nothing matches, so the caller can report the local miss.
 */
export function resolveRemoteMessageTarget(
  coordRoot: string,
  input: MessageTargetInput,
): MessageTargetResult | null {
  const address = parseAddress(input.name);
  if (!address) return null;
  const requestedName = address.name;
  const requestedInstance = input.instanceId?.trim();
  if (!requestedName && !requestedInstance) return null;
  // Presence/mail names do not prove an exact V3 generation.
  if (input.generationId) return null;
  const live = new Set(
    readRemoteMachines(coordRoot).flatMap(({ machine, agents }) =>
      agents.map((a) => remoteKey(machine, a.instance_id)),
    ),
  );
  const known = new Map<string, { instanceId: string; name: string; machine: string }>();
  for (const { machine, agents } of readRemoteMachines(coordRoot, { includeStale: true })) {
    for (const agent of agents) {
      if (agent.name)
        known.set(remoteKey(machine, agent.instance_id), {
          instanceId: agent.instance_id,
          name: agent.name,
          machine,
        });
    }
  }
  for (const sender of knownRemoteSenders(coordRoot)) {
    const key = remoteKey(sender.machine, sender.instance_id);
    if (!known.has(key)) {
      known.set(key, {
        instanceId: sender.instance_id,
        name: sender.name,
        machine: sender.machine,
      });
    }
  }
  const candidates = [...known.values()]
    .filter(({ machine }) => !address.machine || machine === address.machine)
    .filter(({ instanceId }) => !requestedInstance || instanceId === requestedInstance)
    .filter(({ name }) => !requestedName || normalizeName(name) === requestedName)
    .map((candidate) => ({
      ...candidate,
      fresh: live.has(remoteKey(candidate.machine, candidate.instanceId)),
    }));
  if (candidates.length === 0) return null;
  const fresh = candidates.filter(({ fresh }) => fresh);
  if (input.requireLive && fresh.length === 0) {
    return {
      ok: false,
      code: "not_live",
      message:
        "That agent is on another machine and outside live presence; omit --require-live to queue its message.",
    };
  }
  const selected = requestedInstance ? candidates : fresh.length > 0 ? fresh : candidates;
  if (selected.length !== 1) {
    return {
      ok: false,
      code: "ambiguous_peer",
      message: "Several remote agents match; use name@machine and --instance-id to select one.",
      candidates: selected.map(({ instanceId, machine }) => `${instanceId} (${machine})`).sort(),
    };
  }
  const target = selected[0]!;
  return {
    ok: true,
    target: {
      instance_id: target.instanceId,
      name: target.name,
      delivery: "remote",
      machine: target.machine,
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

function parseAddress(value: string | undefined): { name: string; machine?: string } | null {
  const parts = (value ?? "").trim().split("@");
  if (parts.length > 2 || (parts.length === 2 && (!parts[0]?.trim() || !parts[1]?.trim())))
    return null;
  return {
    name: normalizeName(parts[0]),
    ...(parts[1] ? { machine: sanitizeRefComponent(parts[1].trim()) } : {}),
  };
}

function remoteKey(machine: string, instanceId: string): string {
  return `${machine}\0${instanceId}`;
}

function liveRemoteNamesakes(coordRoot: string, name: string): RemoteNamesake[] {
  return readRemoteMachines(coordRoot).flatMap(({ machine, agents }) =>
    agents
      .filter((agent) => normalizeName(agent.name) === name)
      .map((agent) => ({
        name: agent.name!,
        machine,
        instance_id: agent.instance_id,
        address: `${agent.name}@${machine}`,
      })),
  );
}

function unsafe(message: string): MessageTargetResult {
  return { ok: false, code: "authority_unsafe", message };
}
