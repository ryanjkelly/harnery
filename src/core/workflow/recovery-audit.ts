import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { stateDirMode } from "../storage/modes.ts";
import { assertWorkflowRunId } from "./approvals.ts";
import {
  fsyncParentDirectory,
  readJsonRecord,
  stableDigest,
  writeImmutableJson,
} from "./durable-record.ts";

export interface WorkflowRecoveryAuthorization {
  actor: string;
  reason: string;
}

export interface WorkflowRecoveryIntent extends WorkflowRecoveryAuthorization {
  schema_version: 1;
  operation_id: string;
  run_id: string;
  action: "reclaim_unknown_liveness" | "unlock_resume";
  target_sha256: string;
  target: Record<string, unknown>;
  recorded_at: string;
  pid: number;
  host: string;
  outcome: "unknown";
}

export interface WorkflowRecoveryRecord {
  intent: WorkflowRecoveryIntent;
  outcome: "unknown" | "completed";
}

export function validateWorkflowRecoveryAuthorization(
  authorization: WorkflowRecoveryAuthorization,
): void {
  for (const [field, limit] of [
    ["actor", 200],
    ["reason", 2_000],
  ] as const) {
    const value = authorization[field];
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > limit ||
      Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    ) {
      throw new Error(
        `workflow recovery requires a nonempty ${field} of at most ${limit} characters without control characters`,
      );
    }
  }
}

/** Canonical recovery ledger: immutable intent is durable before effects.
 * Completion cites that exact intent; absence always means unknown. */
export function beginWorkflowRecovery(
  coordRoot: string,
  input: Omit<
    WorkflowRecoveryIntent,
    "schema_version" | "operation_id" | "recorded_at" | "pid" | "host" | "outcome"
  >,
): { intent: WorkflowRecoveryIntent; assertCurrent(): void; complete(): void } {
  assertWorkflowRunId(input.run_id);
  validateWorkflowRecoveryAuthorization(input);
  if (!/^[a-f0-9]{64}$/.test(input.target_sha256))
    throw new Error("workflow recovery requires an exact preview digest");
  const intent: WorkflowRecoveryIntent = {
    ...input,
    schema_version: 1,
    operation_id: `recovery-${randomUUID()}`,
    recorded_at: new Date().toISOString(),
    pid: process.pid,
    host: hostname(),
    outcome: "unknown",
  };
  const directory = join(
    coordRoot,
    ".harnery",
    "workflows",
    input.run_id,
    "recovery",
    intent.operation_id,
  );
  // Sync each newly published directory name too. Syncing only the intent's
  // immediate parent cannot make a newly created ancestor durable.
  const runDirectory = join(coordRoot, ".harnery", "workflows", input.run_id);
  ensureDurableDirectory(runDirectory);
  const ledgerDirectory = join(runDirectory, "recovery");
  ensureDurableDirectory(ledgerDirectory);
  fsyncParentDirectory(ledgerDirectory);
  mkdirSync(directory, { mode: stateDirMode() });
  fsyncParentDirectory(directory);
  const intentPath = join(directory, "intent.json");
  writeImmutableJson(intentPath, intent);
  const assertCurrent = () => {
    if (stableDigest(readJsonRecord(intentPath, "recovery intent")) !== stableDigest(intent))
      throw new Error("workflow recovery audit authority changed");
  };
  return {
    intent,
    assertCurrent,
    complete: () => {
      assertCurrent();
      writeImmutableJson(join(directory, "completion.json"), {
        schema_version: 1,
        operation_id: intent.operation_id,
        intent_sha256: stableDigest(intent),
        outcome: "completed",
        recorded_at: new Date().toISOString(),
      });
    },
  };
}

function ensureDurableDirectory(path: string): void {
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory())
      throw new Error("workflow recovery ledger is not a directory");
    return;
  }
  ensureDurableDirectory(dirname(path));
  try {
    mkdirSync(path, { mode: stateDirMode() });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !lstatSync(path).isDirectory())
      throw error;
  }
  fsyncParentDirectory(path);
}

export function readWorkflowRecoveryLedger(
  coordRoot: string,
  runId: string,
): WorkflowRecoveryRecord[] {
  assertWorkflowRunId(runId);
  const directory = join(coordRoot, ".harnery", "workflows", runId, "recovery");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .sort()
    .map((entry) => {
      if (!/^recovery-[a-f0-9-]{36}$/.test(entry))
        throw new Error("invalid workflow recovery ledger entry");
      const intent = readJsonRecord<WorkflowRecoveryIntent>(
        join(directory, entry, "intent.json"),
        "recovery intent",
      );
      if (
        intent.schema_version !== 1 ||
        intent.operation_id !== entry ||
        intent.run_id !== runId ||
        intent.outcome !== "unknown" ||
        !["reclaim_unknown_liveness", "unlock_resume"].includes(intent.action) ||
        !/^[a-f0-9]{64}$/.test(intent.target_sha256)
      ) {
        throw new Error("invalid workflow recovery intent authority");
      }
      validateWorkflowRecoveryAuthorization(intent);
      const completionPath = join(directory, entry, "completion.json");
      if (!existsSync(completionPath)) return { intent, outcome: "unknown" };
      const completion = readJsonRecord<{
        schema_version: number;
        operation_id: string;
        intent_sha256: string;
        outcome: string;
      }>(completionPath, "recovery completion");
      if (
        completion.schema_version !== 1 ||
        completion.operation_id !== entry ||
        completion.intent_sha256 !== stableDigest(intent) ||
        completion.outcome !== "completed"
      )
        throw new Error("invalid workflow recovery completion authority");
      return { intent, outcome: "completed" };
    });
}
