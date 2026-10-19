import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readWorkflowProof } from "../proof.ts";

export type WorkflowLiveness = "active" | "inactive" | "unknown";

/** Corruption must not hide a readable active marker from an audited override. */
export function hasActiveWorkflowEvidence(coordRoot: string, runId: string): boolean {
  const path = join(resolve(coordRoot), ".harnery", "workflows", runId, "transcript.jsonl");
  if (!existsSync(path)) return false;
  let active = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event?.run_id !== runId) continue;
      if (["run.start", "run.resume", "agent.start"].includes(event.event)) active = true;
      if (
        event.event === "run.parked" ||
        (event.event === "run.end" && typeof event.ok === "boolean") ||
        (event.event === "workspace.reattach.failed" && ["blocked", "lost"].includes(event.status))
      )
        active = false;
    } catch {
      /* Unreadable evidence cannot establish inactivity. */
    }
  }
  return active;
}

export function readWorkflowLiveness(coordRoot: string, runId: string): WorkflowLiveness {
  const root = resolve(coordRoot);
  const transcriptPath = join(root, ".harnery", "workflows", runId, "transcript.jsonl");
  if (!existsSync(transcriptPath)) return "unknown";
  let events: Array<{ event?: string; run_id?: string; ok?: unknown; status?: unknown }>;
  try {
    events = readFileSync(transcriptPath, "utf8")
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
  if (
    events.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        item.run_id !== runId ||
        typeof item.event !== "string",
    )
  ) {
    return "unknown";
  }

  let liveness: WorkflowLiveness | undefined;
  for (const item of events) {
    if (item.event === "run.start" || item.event === "run.resume" || item.event === "agent.start")
      liveness = "active";
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
  // A terminal proof can predate a resumed run. Only the current transcript
  // can establish that no later activity invalidated that terminal observation.
  if (liveness !== "inactive") return liveness ?? "unknown";
  const proofPath = join(root, ".harnery", "workflows", runId, "proof.json");
  if (existsSync(proofPath)) {
    try {
      const proof = readWorkflowProof(root, runId);
      return ["succeeded", "failed"].includes(proof.run.status) ? "inactive" : "unknown";
    } catch {
      return "unknown";
    }
  }
  return "inactive";
}
