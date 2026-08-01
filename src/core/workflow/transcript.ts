import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fsyncParentDirectory, stableDigest } from "./durable-record.ts";

// Limit for the JSON record body. The trailing newline delimiter is outside the
// record and is not counted by readers after splitting transcript lines.
export const WORKFLOW_TRANSCRIPT_EVENT_BYTES = 16 * 1024;

/** Key under which a shrunk record names the fields it had to drop. */
export const WORKFLOW_TRANSCRIPT_OMITTED = "omitted_fields";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface WorkflowTranscriptOmission {
  field: string;
  bytes: number;
  sha256: string;
}

export function workflowTranscriptPath(coordRoot: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`invalid workflow run id ${JSON.stringify(runId)}`);
  return join(resolve(coordRoot), ".harnery", "workflows", runId, "transcript.jsonl");
}

/**
 * Append one transcript record, always.
 *
 * A record that would exceed what a reader accepts has its largest fields
 * replaced by a digest and a byte count until it fits, and it names what it
 * dropped. Size never raises.
 *
 * Refusing an oversized record would let a valid run fail on its own opening
 * line: `run.start` carries the workflow's declared metadata plus the frozen
 * work and attempt context, and Harnery's own validators permit those to exceed
 * this limit by construction. Losing detail from a record is recoverable.
 * Losing the run that was writing it is not.
 */
export function appendWorkflowTranscriptEvent(
  coordRoot: string,
  runId: string,
  event: string,
  data: Record<string, unknown>,
): void {
  const path = workflowTranscriptPath(coordRoot, runId);
  const record = fitWorkflowTranscriptRecord(
    { schema_version: 1, run_id: runId, ts: new Date().toISOString(), event },
    data,
  );
  const line = `${JSON.stringify(record)}\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existed = existsSync(path);
  const fd = openSync(path, "a", 0o600);
  try {
    writeFileSync(fd, line, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!existed) fsyncParentDirectory(path);
}

/**
 * Shrink a record to the reader's limit by dropping its largest fields first.
 * The envelope is never dropped, so a record keeps its run id, timestamp, and
 * event name however much detail it loses. Exported for tests.
 */
export function fitWorkflowTranscriptRecord(
  envelope: Record<string, unknown>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const candidate = { ...envelope, ...data };
  if (Buffer.byteLength(JSON.stringify(candidate)) <= WORKFLOW_TRANSCRIPT_EVENT_BYTES) {
    return candidate;
  }
  const kept: Record<string, unknown> = { ...data };
  const omitted: WorkflowTranscriptOmission[] = [];
  const bySize = Object.keys(data)
    .map((field) => ({ field, bytes: Buffer.byteLength(JSON.stringify(data[field]) ?? "") }))
    .sort((a, b) => b.bytes - a.bytes);

  for (const { field, bytes } of bySize) {
    omitted.push({ field, bytes, sha256: stableDigest(data[field]) });
    delete kept[field];
    const next = { ...envelope, ...kept, [WORKFLOW_TRANSCRIPT_OMITTED]: omitted };
    if (Buffer.byteLength(JSON.stringify(next)) <= WORKFLOW_TRANSCRIPT_EVENT_BYTES) return next;
  }
  // Every field dropped and still over: the omission list is itself the excess.
  // Keep the envelope and a count so the record stays parseable and honest.
  return { ...envelope, [WORKFLOW_TRANSCRIPT_OMITTED]: omitted.length };
}
