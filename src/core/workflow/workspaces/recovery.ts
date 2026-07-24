import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readWorkflowProof } from "../proof.ts";

export type WorkflowLiveness = "active" | "inactive" | "unknown";

export function readWorkflowLiveness(coordRoot: string, runId: string): WorkflowLiveness {
  const root = resolve(coordRoot);
  const proofPath = join(root, ".harnery", "workflows", runId, "proof.json");
  if (existsSync(proofPath)) {
    try {
      const proof = readWorkflowProof(root, runId);
      return ["succeeded", "failed"].includes(proof.run.status) ? "inactive" : "unknown";
    } catch {
      return "unknown";
    }
  }

  const journalPath = join(root, ".harnery", "workflows", runId, "journal.jsonl");
  if (!existsSync(journalPath)) return "unknown";
  let events: Array<{ event?: string; run_id?: string; ok?: unknown; status?: unknown }>;
  try {
    events = readFileSync(journalPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            event?: string;
            run_id?: string;
            ok?: unknown;
            status?: unknown;
          },
      );
  } catch {
    return "unknown";
  }
  if (events.some((item) => item.run_id !== runId || typeof item.event !== "string")) {
    return "unknown";
  }

  let liveness: WorkflowLiveness | undefined;
  for (const item of events) {
    if (item.event === "run.start" || item.event === "run.resume") liveness = "active";
    if (item.event === "run.parked") liveness = "inactive";
    if (item.event === "run.end") {
      if (typeof item.ok !== "boolean") return "unknown";
      liveness = "inactive";
    }
    if (item.event === "workspace.reattach.failed") {
      if (item.status !== "blocked" && item.status !== "lost") return "unknown";
      liveness = "inactive";
    }
  }
  return liveness ?? "unknown";
}
