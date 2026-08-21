import {
  type CoordinationViewV3,
  projectCoordinationViewV3,
  readCoordinationViewV3,
} from "./coordination-view.ts";
import type { ReadLedgerV3Result } from "./reader.ts";

export const EVENT_V3_FINALIZATION_VIEW_VERSION = 1 as const;

export type FinalizationScopeV3ErrorCode = "authority_unsafe" | "instance_not_live";

export class FinalizationScopeV3Error extends Error {
  constructor(public readonly code: FinalizationScopeV3ErrorCode) {
    super(`event_v3_finalization_scope:${code}`);
    this.name = "FinalizationScopeV3Error";
  }
}

export interface FinalizationScopeV3 {
  projection_version: typeof EVENT_V3_FINALIZATION_VIEW_VERSION;
  contract_major: 2;
  instance_id: string;
  session_id: string;
  generation_id: string;
  lifecycle_state?: string;
  files_touched: string[];
  source_event_id: string;
  source_position: { segment_ordinal: number; byte_offset: number };
}

/** Read and validate the current V3 finalization boundary for one live instance. */
export function readFinalizationScopeV3(
  coordRoot: string,
  instanceId: string,
): FinalizationScopeV3 {
  return finalizationScopeFromCoordinationViewV3(readCoordinationViewV3(coordRoot), instanceId);
}

/** Pure adapter used by replay tests and safety consumers. */
export function projectFinalizationScopeV3(
  read: ReadLedgerV3Result,
  instanceId: string,
): FinalizationScopeV3 {
  return finalizationScopeFromCoordinationViewV3(projectCoordinationViewV3(read), instanceId);
}

function finalizationScopeFromCoordinationViewV3(
  view: CoordinationViewV3,
  instanceId: string,
): FinalizationScopeV3 {
  if (!view.authority_safe) throw new FinalizationScopeV3Error("authority_unsafe");
  const instance = view.instances[instanceId];
  if (!instance?.authority_eligible) {
    throw new FinalizationScopeV3Error("instance_not_live");
  }
  return {
    projection_version: EVENT_V3_FINALIZATION_VIEW_VERSION,
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
