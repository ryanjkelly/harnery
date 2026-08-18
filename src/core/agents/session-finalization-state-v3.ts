import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ApprovedSessionEndReasonV3 } from "../events/v3/producers/recorder.ts";
import { EVENT_V3_LEDGER_RELATIVE_ROOT } from "../events/v3/writer.ts";

export const SESSION_FINALIZATION_REQUEST_FORMAT_V3 =
  "harnery-v3-session-finalization-request" as const;
export const SESSION_FINALIZATION_REQUEST_VERSION_V3 = 1 as const;

export type SessionFinalizationTriggerV3 =
  | "explicit_end"
  | "verified_archive"
  | "idle_timeout"
  | "parent_terminal"
  | "stale_sweep"
  | "agent_completed"
  | "run_completed"
  | "superseded"
  | "host_disappeared";

export interface SessionFinalizationRequestV3 {
  format: typeof SESSION_FINALIZATION_REQUEST_FORMAT_V3;
  format_version: typeof SESSION_FINALIZATION_REQUEST_VERSION_V3;
  request_id: `sfr_${string}`;
  instance_id: `inst_${string}`;
  generation_id: `gen_${string}`;
  trigger: SessionFinalizationTriggerV3;
  reason: ApprovedSessionEndReasonV3;
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

export function sessionFinalizationRequestDirectoryV3(coordRoot: string): string {
  return join(resolve(coordRoot), EVENT_V3_LEDGER_RELATIVE_ROOT, "finalization", "requests");
}

export function sessionFinalizationRequestPathV3(coordRoot: string, requestId: string): string {
  return join(sessionFinalizationRequestDirectoryV3(coordRoot), `${requestId}.json`);
}

export function listSessionFinalizationRequestsV3(
  coordRoot: string,
): SessionFinalizationRequestV3[] {
  const directory = sessionFinalizationRequestDirectoryV3(coordRoot);
  if (!existsSync(directory)) return [];
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("V3 session finalization request directory is unsafe");
  }
  return readdirSync(directory)
    .filter((name) => /^sfr_[0-9a-f-]+\.json$/.test(name))
    .map((name) => readSessionFinalizationRequestV3(join(directory, name)))
    .sort((left, right) => left.observed_at.localeCompare(right.observed_at));
}

export function readSessionFinalizationRequestV3(filePath: string): SessionFinalizationRequestV3 {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("V3 session finalization request is unsafe");
  }
  const request = JSON.parse(readFileSync(filePath, "utf8")) as SessionFinalizationRequestV3;
  if (
    request.format !== SESSION_FINALIZATION_REQUEST_FORMAT_V3 ||
    request.format_version !== SESSION_FINALIZATION_REQUEST_VERSION_V3 ||
    !/^sfr_[0-9a-f-]+$/.test(request.request_id) ||
    !/^inst_[a-zA-Z0-9._-]+$/.test(request.instance_id) ||
    !/^gen_[0-9a-f-]+$/.test(request.generation_id) ||
    !["pending", "cancelled", "completed"].includes(request.status)
  ) {
    throw new Error("V3 session finalization request is invalid");
  }
  return request;
}
