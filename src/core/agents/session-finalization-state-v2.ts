import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ApprovedSessionEndReasonV2 } from "../events/v2/producers/recorder.ts";
import { EVENT_V2_LEDGER_RELATIVE_ROOT } from "../events/v2/writer.ts";

export const SESSION_FINALIZATION_REQUEST_FORMAT_V2 =
  "harnery-v2-session-finalization-request" as const;
export const SESSION_FINALIZATION_REQUEST_VERSION_V2 = 1 as const;

export type SessionFinalizationTriggerV2 =
  | "explicit_end"
  | "verified_archive"
  | "idle_timeout"
  | "parent_terminal"
  | "stale_sweep"
  | "agent_completed"
  | "run_completed"
  | "superseded"
  | "host_disappeared";

export interface SessionFinalizationRequestV2 {
  format: typeof SESSION_FINALIZATION_REQUEST_FORMAT_V2;
  format_version: typeof SESSION_FINALIZATION_REQUEST_VERSION_V2;
  request_id: `sfr_${string}`;
  instance_id: `inst_${string}`;
  generation_id: `gen_${string}`;
  trigger: SessionFinalizationTriggerV2;
  reason: ApprovedSessionEndReasonV2;
  outcome:
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "denied"
    | "interrupted"
    | "unknown";
  observed_at: string;
  not_before: string;
  last_event_id: `evt_${string}`;
  observation_event_id?: `evt_${string}`;
  requested_turn_id?: `tid_${string}`;
  allowed_open_span_ids?: `span_${string}`[];
  coordination_finalized: boolean;
  status: "pending" | "cancelled" | "completed";
  cancelled_at?: string;
  completed_at?: string;
  terminal_event_id?: `evt_${string}`;
}

export function sessionFinalizationRequestDirectoryV2(coordRoot: string): string {
  return join(resolve(coordRoot), EVENT_V2_LEDGER_RELATIVE_ROOT, "finalization", "requests");
}

export function sessionFinalizationRequestPathV2(coordRoot: string, requestId: string): string {
  return join(sessionFinalizationRequestDirectoryV2(coordRoot), `${requestId}.json`);
}

export function listSessionFinalizationRequestsV2(
  coordRoot: string,
): SessionFinalizationRequestV2[] {
  const directory = sessionFinalizationRequestDirectoryV2(coordRoot);
  if (!existsSync(directory)) return [];
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("V2 session finalization request directory is unsafe");
  }
  return readdirSync(directory)
    .filter((name) => /^sfr_[0-9a-f-]+\.json$/.test(name))
    .map((name) => readSessionFinalizationRequestV2(join(directory, name)))
    .sort((left, right) => left.observed_at.localeCompare(right.observed_at));
}

export function readSessionFinalizationRequestV2(filePath: string): SessionFinalizationRequestV2 {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("V2 session finalization request is unsafe");
  }
  const request = JSON.parse(readFileSync(filePath, "utf8")) as SessionFinalizationRequestV2;
  if (
    request.format !== SESSION_FINALIZATION_REQUEST_FORMAT_V2 ||
    request.format_version !== SESSION_FINALIZATION_REQUEST_VERSION_V2 ||
    !/^sfr_[0-9a-f-]+$/.test(request.request_id) ||
    !/^inst_[a-zA-Z0-9._-]+$/.test(request.instance_id) ||
    !/^gen_[0-9a-f-]+$/.test(request.generation_id) ||
    !["pending", "cancelled", "completed"].includes(request.status)
  ) {
    throw new Error("V2 session finalization request is invalid");
  }
  return request;
}
