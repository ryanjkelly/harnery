import { coordRoot, readAgents } from "@/lib/coord-reader";
import { readDecisions } from "@/lib/decision-reader";
import { readWorkflowRuns } from "@/lib/workflow-reader";

import type { PaletteCatalog, PaletteEntry } from "./catalog";

const CAPS = { decisions: 40, workflows: 30 } as const;
export function buildPaletteCatalog(): PaletteCatalog {
  const root = coordRoot();
  const snap = readAgents();

  const agents: PaletteEntry[] = [...snap.active, ...snap.stale].map((hb) => ({
    id: hb.instance_id,
    label: hb.name,
    sublabel: hb.task ?? undefined,
    state: hb.activity,
    href: `/agents/${encodeURIComponent(hb.instance_id)}`,
  }));

  const decisionsSnap = readDecisions();
  const decisions: PaletteEntry[] = [
    ...decisionsSnap.waiting,
    ...decisionsSnap.queue,
    ...decisionsSnap.review,
    ...decisionsSnap.reviewed,
  ]
    .slice(0, CAPS.decisions)
    .map((d) => ({
      id: d.decision_id,
      label: d.question,
      sublabel: d.decision_id,
      state: d.status,
      href: `/decisions/${encodeURIComponent(d.decision_id)}`,
    }));

  const workflows: PaletteEntry[] = readWorkflowRuns(root)
    .slice(0, CAPS.workflows)
    .map((run) => ({
      id: run.runId,
      label: run.name,
      sublabel: run.runId,
      state: run.status,
      href: `/workflows/${encodeURIComponent(run.runId)}`,
    }));

  return { agents, decisions, workflows };
}
