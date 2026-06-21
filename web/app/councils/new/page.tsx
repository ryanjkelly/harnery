import Link from "next/link";

import { NavBar } from "@/components/NavBar";
import { NewCouncilForm, type AgentRegistryRow } from "@/components/NewCouncilForm";
import { coordRoot, readAgents } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";

const STALE_AGE_SECONDS = 5 * 60;

/**
 * Server-rendered new-council page. Loads the current agent registry from
 * `.harnery/active/*.json` and hands it to the client form. Submission goes
 * to POST /api/councils which shells through to `harn agents council create`.
 *
 * Preselect via `?objective=<encoded>`: the /council skill's create mode
 * emits this URL with the operator's objective baked in.
 */
export default async function NewCouncilPage({
  searchParams,
}: {
  searchParams: Promise<{ objective?: string }>;
}) {
  const sp = await searchParams;
  const initialObjective = (sp.objective ?? "").slice(0, 4000);

  const snap = readAgents();

  // Build the agent-picker rows. snap.active and snap.stale each carry the
  // full Heartbeat shape; we want one row per heartbeat with the bare name.
  const rows: AgentRegistryRow[] = [...snap.active, ...snap.stale]
    .filter((hb) => hb.name && hb.name.length > 0)
    .map((hb) => {
      const bare = hb.name.startsWith("agent-")
        ? hb.name.slice("agent-".length)
        : hb.name;
      return {
        name: bare,
        instance_id: hb.instance_id,
        active: hb.age_seconds < STALE_AGE_SECONDS,
        age_seconds: hb.age_seconds,
        platform: hb.platform ?? null,
        task: hb.task ?? null,
      };
    })
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.age_seconds - b.age_seconds;
    });

  // Dedupe by bare name: multiple harnesses can share a name (e.g. detached
  // subagents); the picker shows one row per identity.
  const seen = new Set<string>();
  const dedupedAgents: AgentRegistryRow[] = [];
  for (const a of rows) {
    if (seen.has(a.name)) continue;
    seen.add(a.name);
    dedupedAgents.push(a);
  }

  return (
    <>
      <NavBar scannedDir={coordRoot()} />
      <main className="w-full max-w-screen-md mx-auto px-6 pb-10">
        <nav className="mb-4 text-xs text-muted-foreground">
          <Link href="/councils" className="hover:text-foreground">
            ← Councils
          </Link>
          {" / "}
          <Link href="/agents" className="hover:text-foreground">
            Agents
          </Link>
        </nav>

        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight">New council</h1>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
            Pick members + steward + (optional) target doc. Submitting creates
            the council via{" "}
            <code className="font-mono text-xs">harn agents council create</code>{" "}
            and routes you to its detail page. Members get pinged via their
            scratchpads if currently active; others see the invite on next
            SessionStart.
          </p>
        </header>

        <NewCouncilForm
          initialObjective={initialObjective}
          agents={dedupedAgents}
        />
      </main>
    </>
  );
}
