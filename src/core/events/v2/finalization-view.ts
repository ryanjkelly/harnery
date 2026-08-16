import {
  type CoordinationViewV2,
  projectCoordinationViewV2,
  readCoordinationViewV2,
} from "./coordination-view.ts";
import type { ReadLedgerV2Result } from "./reader.ts";

export const EVENT_V2_FINALIZATION_VIEW_VERSION = 1 as const;

export type FinalizationScopeV2ErrorCode = "authority_unsafe" | "instance_not_live";

export class FinalizationScopeV2Error extends Error {
  constructor(public readonly code: FinalizationScopeV2ErrorCode) {
    super(`event_v2_finalization_scope:${code}`);
    this.name = "FinalizationScopeV2Error";
  }
}

export interface FinalizationScopeV2 {
  projection_version: typeof EVENT_V2_FINALIZATION_VIEW_VERSION;
  contract_major: 2;
  instance_id: string;
  session_id: string;
  generation_id: string;
  lifecycle_state?: string;
  files_touched: string[];
  source_event_id: string;
  source_position: { segment_ordinal: number; byte_offset: number };
}

/** Read and validate the current V2 finalization boundary for one live instance. */
export function readFinalizationScopeV2(
  coordRoot: string,
  instanceId: string,
): FinalizationScopeV2 {
  return finalizationScopeFromCoordinationViewV2(readCoordinationViewV2(coordRoot), instanceId);
}

/** Pure adapter used by replay tests and safety consumers. */
export function projectFinalizationScopeV2(
  read: ReadLedgerV2Result,
  instanceId: string,
): FinalizationScopeV2 {
  return finalizationScopeFromCoordinationViewV2(projectCoordinationViewV2(read), instanceId);
}

function finalizationScopeFromCoordinationViewV2(
  view: CoordinationViewV2,
  instanceId: string,
): FinalizationScopeV2 {
  if (!view.authority_safe) throw new FinalizationScopeV2Error("authority_unsafe");
  const instance = view.instances[instanceId];
  if (!instance?.authority_eligible) {
    throw new FinalizationScopeV2Error("instance_not_live");
  }
  return {
    projection_version: EVENT_V2_FINALIZATION_VIEW_VERSION,
    contract_major: 2,
    instance_id: instance.instance_id,
    session_id: instance.session_id,
    generation_id: instance.generation_id,
    lifecycle_state: instance.lifecycle_state,
    files_touched: [...instance.files_touched],
    source_event_id: instance.last_event_id,
    source_position: { ...instance.source_position },
  };
}
