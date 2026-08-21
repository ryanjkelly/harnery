import { coordRoot, readAgents, readCouncils } from "@/lib/coord-reader";
import { readDecisions } from "@/lib/decision-reader";
import { readGovernors } from "@/lib/governor-reader";
import { readDurableWork } from "@/lib/work-reader";
import { readWorkflowRuns } from "@/lib/workflow-reader";

export const dynamic = "force-dynamic";

/**
 * GET /api/palette — one compact catalog for the command palette: every
 * searchable entity as `{id, label, sublabel?, state?, href}`, grouped by
 * kind. Fetched when the palette opens (rate-limited client-side), so it
 * must stay cheap: everything comes from the same derived readers the pages
 * use — never a raw scan of the full event ledger — and each group is capped.
 * A short in-process TTL absorbs rapid open/close cycles.
 */

export interface PaletteEntry {
  id: string;
  label: string;
  sublabel?: string;
  state?: string;
  href: string;
}

export interface PaletteCatalog {
  agents: PaletteEntry[];
  councils: PaletteEntry[];
  decisions: PaletteEntry[];
  work: PaletteEntry[];
  workflows: PaletteEntry[];
  goals: PaletteEntry[];
}

const CAPS = { councils: 30, decisions: 40, work: 50, workflows: 30 } as const;
const TTL_MS = 10_000;

let cache: { at: number; body: PaletteCatalog } | null = null;

function buildCatalog(): PaletteCatalog {
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

export function GET(): Response {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return Response.json(cache.body);
  const body = buildCatalog();
  cache = { at: now, body };
  return Response.json(body);
}
