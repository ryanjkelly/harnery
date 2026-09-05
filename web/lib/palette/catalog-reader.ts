import { coordRoot, readAgents, readCouncils } from "@/lib/coord-reader";
import { readDecisions } from "@/lib/decision-reader";
import { readGovernors } from "@/lib/governor-reader";
import { readDurableWork } from "@/lib/work-reader";
import { readWorkflowRuns } from "@/lib/workflow-reader";

import type { PaletteCatalog, PaletteEntry } from "./catalog";

const CAPS = { councils: 30, decisions: 40, work: 50, workflows: 30 } as const;
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

  const councilsSnap = readCouncils();
  const councils: PaletteEntry[] = [
    ...councilsSnap.active,
    ...councilsSnap.closed,
    ...councilsSnap.archived,
  ]
    .slice(0, CAPS.councils)
    .map((c) => ({
      id: c.council_id,
      label: c.objective,
      sublabel: c.council_id,
      state: c.status,
      href: `/councils/${encodeURIComponent(c.council_id)}`,
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

  const work: PaletteEntry[] = readDurableWork(root)
    .slice(0, CAPS.work)
    .map(({ intent, projection }) => ({
      id: intent.id,
      label: intent.title,
      sublabel: intent.id,
      state: projection.state,
      href: `/work/${encodeURIComponent(intent.id)}`,
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

  const goals: PaletteEntry[] = readGovernors(root).map(({ intent, projection }) => ({
    id: intent.id,
    label: intent.title,
    sublabel: intent.id,
    state: projection.state,
    href: `/governors/${encodeURIComponent(intent.id)}`,
  }));

  return { agents, councils, decisions, work, workflows, goals };
}
