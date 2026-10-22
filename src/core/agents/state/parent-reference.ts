import type {
  CoordinationGenerationViewV3,
  CoordinationViewV3,
} from "../../events/v3/coordination-view.ts";
import { readCoordinationViewV3 } from "../../events/v3/coordination-view.ts";
import { liveInstanceIdV3, nativeInstanceIdV3 } from "../../events/v3/live-route-observer.ts";
import {
  type NativeParentObservation,
  type NativeParentRequest,
  readNativeParentReference,
} from "../../hooks/adapter/native-parent.ts";
import { resolveName } from "./names.ts";

export type AgentParentReference =
  | {
      state: "verified";
      relationship: "delegated-child" | "native-child";
      parent_instance_id: string;
      parent_v3_instance_id: string;
      parent_generation_id: string | null;
      parent_session_id: string | null;
      parent_name: string | null;
      source: "v3-session-link" | "native-session-metadata";
      source_witness?: string;
      addressable: boolean;
    }
  | { state: "none" | "unknown" | "conflict"; reason: string };

export interface AgentParentSubject {
  instance_id: string;
  generation_id?: string;
  v3_generation_id?: string;
  platform?: string;
  native_session_id?: string;
}

export interface AgentParentReferenceOptions {
  view?: CoordinationViewV3;
  readNativeParent?: (request: NativeParentRequest) => NativeParentObservation;
}

/** Display/recipient evidence only. Never use native evidence as a claim or lifecycle waiver. */
export function resolveAgentParentReference(
  coordRoot: string,
  child: AgentParentSubject,
  options: AgentParentReferenceOptions = {},
): AgentParentReference {
  try {
    const view = options.view ?? readCoordinationViewV3(coordRoot);
    if (!view.source_complete || !view.authority_safe) return unknown("parent_authority_unsafe");
    if (
      child.generation_id &&
      child.v3_generation_id &&
      child.generation_id !== child.v3_generation_id
    ) {
      return unknown("child_generation_mismatch");
    }
    const instance = liveInstanceIdV3(child.instance_id);
    const generationId = child.generation_id ?? child.v3_generation_id;
    const generations = [
      ...Object.values(view.instances),
      ...Object.values(view.terminal_generations),
    ];
    const generation = generationId
      ? generations.find(
          (row) => row.generation_id === generationId && row.instance_id === instance,
        )
      : view.instances[instance];
    if (!generation) return unknown("child_generation_unavailable");
    if (!safe(view, generation)) return unknown("child_authority_unsafe");
    const canonical = generation.parent_generation_id
      ? generations.find((row) => row.generation_id === generation.parent_generation_id)
      : undefined;
    if (generation.parent_generation_id && !canonical)
      return unknown("parent_generation_unavailable");
    if (canonical && cyclic(generations, generation)) {
      return { state: "conflict", reason: "parent_lineage_cycle" };
    }
    const adapter = generation.runtime_attestation.adapter;
    const platform = adapter.state === "observed" ? adapter.value.id : child.platform;
    const nativeId = child.native_session_id ?? nativeInstanceIdV3(instance);
    const native =
      platform === "codex" && liveInstanceIdV3(nativeId) === instance
        ? (options.readNativeParent ?? readNativeParentReference)({
            adapter: platform,
            native_session_id: nativeId,
          })
        : ({ state: "unknown", reason: "native_child_identity_unavailable" } as const);
    if (canonical) {
      if (
        native.state === "none" ||
        (native.state === "observed" &&
          liveInstanceIdV3(native.parent_session_id) !== canonical.instance_id)
      ) {
        return { state: "conflict", reason: "parent_sources_disagree" };
      }
      return reference(coordRoot, view, canonical.instance_id, canonical, "v3-session-link");
    }
    if (native.state === "observed") {
      const parentInstance = liveInstanceIdV3(native.parent_session_id);
      if (parentInstance === instance)
        return { state: "conflict", reason: "parent_self_reference" };
      const parent = recipientGeneration(view, parentInstance);
      if (parent && cyclic(generations, generation, parent)) {
        return { state: "conflict", reason: "parent_lineage_cycle" };
      }
      return reference(
        coordRoot,
        view,
        parentInstance,
        parent,
        "native-session-metadata",
        native.source_witness,
      );
    }
    return { state: native.state, reason: native.reason };
  } catch {
    return unknown("parent_reference_unavailable");
  }
}

function reference(
  root: string,
  view: CoordinationViewV3,
  instance: string,
  parent: CoordinationGenerationViewV3 | undefined,
  source: "v3-session-link" | "native-session-metadata",
  witness?: string,
): AgentParentReference {
  const native = nativeInstanceIdV3(instance);
  const name = resolveName(root, native)?.name ?? null;
  const recipient = recipientGeneration(view, instance);
  return {
    state: "verified",
    relationship: source === "v3-session-link" ? "delegated-child" : "native-child",
    parent_instance_id: native,
    parent_v3_instance_id: instance,
    parent_generation_id: parent?.generation_id ?? null,
    parent_session_id: parent?.session_id ?? null,
    parent_name: name,
    source,
    ...(witness ? { source_witness: witness } : {}),
    addressable: Boolean(
      parent && recipient?.generation_id === parent.generation_id && safe(view, parent) && name,
    ),
  };
}

function recipientGeneration(view: CoordinationViewV3, instance: string) {
  return (
    view.instances[instance] ??
    Object.values(view.terminal_generations)
      .filter((row) => row.instance_id === instance)
      .sort(
        (a, b) =>
          b.source_position.segment_ordinal - a.source_position.segment_ordinal ||
          b.source_position.byte_offset - a.source_position.byte_offset,
      )[0]
  );
}

function safe(view: CoordinationViewV3, generation: CoordinationGenerationViewV3): boolean {
  return !(view.diagnostics_by_generation[generation.generation_id] ?? []).some(
    (d) => d.authority_blocking,
  );
}

function cyclic(
  generations: CoordinationGenerationViewV3[],
  child: CoordinationGenerationViewV3,
  first?: CoordinationGenerationViewV3,
): boolean {
  const seen = new Set([child.generation_id]);
  let cursor = first ?? child;
  for (let depth = 0; depth <= generations.length; depth++) {
    if (cursor !== child) {
      if (seen.has(cursor.generation_id) || cursor.instance_id === child.instance_id) return true;
      seen.add(cursor.generation_id);
    }
    if (!cursor.parent_generation_id) return false;
    const next = generations.find((g) => g.generation_id === cursor.parent_generation_id);
    if (!next) return false;
    if (seen.has(next.generation_id)) return true;
    cursor = next;
  }
  return true;
}

function unknown(reason: string): AgentParentReference {
  return { state: "unknown", reason };
}
