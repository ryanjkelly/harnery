import { createHash } from "node:crypto";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import { ADAPTER_CAPABILITY_PROFILES_V3 } from "./capabilities.ts";
import {
  type EventV3ControlState,
  type EventV3WriteMode,
  readEventV3ControlState,
} from "./control.ts";
import { liveEventV3BuildId } from "./runtime-identity.ts";

export type LiveEventLedgerRouteV3 =
  | {
      state: "v3";
      mode: EventV3WriteMode;
      build_id: `build_${string}`;
      /** Genesis id of the epoch this route was resolved against: the epoch fence for derived writes. */
      genesis_id: `gex_${string}`;
    }
  | { state: "blocked"; reason: string };

/**
 * Observe the V3-only ledger route without repairing control pairs, replacing
 * epochs, launching processes, or writing files. Read-only consumers fail
 * closed until a command or producer repairs the route.
 */
export function observeLiveEventLedgerRouteV3(coordRoot: string): LiveEventLedgerRouteV3 {
  return liveEventLedgerRouteFromControlV3(readEventV3ControlState(coordRoot));
}

/** Project one already-read control state into the passive route contract. */
export function liveEventLedgerRouteFromControlV3(
  control: EventV3ControlState,
): LiveEventLedgerRouteV3 {
  if (control.state === "closed") return { state: "blocked", reason: "v3_not_initialized" };
  if (control.state !== "candidate" && control.state !== "active") {
    return { state: "blocked", reason: `${control.state}:${control.reason}` };
  }
  if (!runtimeCapabilityProfileCurrentV3(control)) {
    return { state: "blocked", reason: "runtime_capability_profile_incompatible" };
  }
  const buildId = liveEventV3BuildId(control.genesis.profile.harnery_commit);
  if (!control.genesis.profile.producer_build_ids.includes(buildId)) {
    return { state: "blocked", reason: "live_producer_build_not_approved" };
  }
  return {
    state: "v3",
    mode: control.state,
    build_id: buildId,
    genesis_id: control.genesis.event.payload.genesis_id as `gex_${string}`,
  };
}

export function runtimeCapabilityProfileCurrentV3(
  control: Extract<EventV3ControlState, { state: "candidate" | "active" }>,
): boolean {
  const expected = Object.values(ADAPTER_CAPABILITY_PROFILES_V3).map((profile) =>
    sha256V3(canonicalJsonV3(profile)),
  );
  const approved = control.genesis.profile.adapter_capability_profile_digests;
  const expectedDigests = new Set<string>(expected);
  return control.state === "candidate"
    ? approved.some((digest) => expectedDigests.has(digest))
    : expected.every((digest) => approved.includes(digest));
}

export function liveInstanceIdV3(instanceId: string): `inst_${string}` {
  if (/^inst_[a-zA-Z0-9._-]{1,128}$/.test(instanceId)) return instanceId as `inst_${string}`;
  if (/^[a-zA-Z0-9._-]{1,128}$/.test(instanceId)) return `inst_${instanceId}`;
  return `inst_${createHash("sha256").update(instanceId.normalize("NFC")).digest("hex")}`;
}

/**
 * The adapter-native id a canonical `inst_*` id carries, for display and for
 * joins against native-keyed records. Only the direct prefix form round-trips:
 * a hashed id has no recoverable native form and is returned unchanged, so
 * never treat this as a guaranteed inverse of `liveInstanceIdV3`.
 */
export function nativeInstanceIdV3(instanceId: string): string {
  return instanceId.startsWith("inst_") ? instanceId.slice("inst_".length) : instanceId;
}
