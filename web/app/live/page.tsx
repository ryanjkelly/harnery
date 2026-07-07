import Link from "next/link";

import { AgentChipProvider } from "@/components/AgentChip";
import { LiveLogTable } from "@/components/log-table/LiveLogTable";
import { NavBar } from "@/components/NavBar";
import {
  buildAgentSummaryMap,
  buildEndedAgentSummaries,
  buildSubagentSummaries,
} from "@/lib/agent-summary";
import { hostInfo } from "@/lib/config";
import {
  coordRoot,
  readAgents,
  readInstanceIdentities,
} from "@/lib/coord-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Live session · Harnery" };

interface PageProps {
  searchParams: Promise<{ agent?: string }>;
}

/**
 * /live: structured tail of `.harnery/events.ndjson`, projected to the
 * command stream: the host CLI `command.*` + `narration` AND bare shell commands
 * (Bash `tool.pre_use` / `tool.post_use`, with their `# intent:` narration).
 * Non-command tool calls (Read/Edit/Write/…) and state/session events belong to
 * `/events`.
 *
 * Wraps in the same `fixed inset-0` log-page shell as `/events` so the only
 * scroll surface is the table. SSE delivers an initial 200-row snapshot
 * then streams appends.
 *
 * `instanceToName` is forwarded to the session renderer so events written
 * before the producer could resolve its owner (`agent_name: "unknown"`)
 * still get the right name in the agent column when the instance_id is
 * recognized by an active or stale heartbeat.
 */
export default async function LivePage({ searchParams }: PageProps) {
  const { agent } = await searchParams;
  const { binName } = hostInfo();
  const snap = readAgents();
  const all = [...snap.active, ...snap.stale];
  // Durable instance_id → identity from session.start (main agents) +
  // subagent.start (subagents). Persists past session end, so a finished
  // agent's rows keep its name instead of reverting to a raw instance_id.
  // One scan, shared with the summary builders below.
  const identities = readInstanceIdentities();
  const instanceToName: Record<string, string> = {};
  for (const hb of all) instanceToName[hb.instance_id] = hb.name;
  // Live heartbeats win (freshest name); the durable log fills every agent that
  // has since exited (main sessions and subagents alike). Row-resolution only:
  // the agent dropdown stays scoped to live (heartbeat) agents rather than
  // listing every historical session.
  for (const [iid, id] of Object.entries(identities)) {
    if (!instanceToName[iid]) instanceToName[iid] = id.name;
  }
  const agentNames = Array.from(new Set(all.map((h) => h.name))).sort();
  // Hover cards, lowest-priority first: ended main agents (session.start) and
  // subagents (subagent.start) from the durable log, then live/recent main
  // agents, which override the rest on any name collision.
  const summaries = {
    ...buildEndedAgentSummaries(identities),
    ...buildSubagentSummaries(identities),
    ...buildAgentSummaryMap(agentNames, identities),
  };

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      <NavBar scannedDir={coordRoot()} />
      <main className="flex-1 min-h-0 flex flex-col w-full px-6 pb-6">
        <header className="mb-4 flex items-baseline justify-between flex-wrap gap-3 shrink-0">
          <div className="flex flex-col gap-0.5">
            <h1 className="text-xl font-semibold tracking-tight">Live session</h1>
            <p className="text-xs text-muted-foreground">
              Every shell command + its intent: <code className="font-mono">{binName}</code> (the
              host CLI) and bare shell (
              <code className="font-mono">git</code>, <code className="font-mono">grep</code>,{" "}
              <code className="font-mono">curl</code>…). File reads, edits, and other
              non-command tool calls stream to{" "}
              <Link
                href="/events"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Events
              </Link>
              .
            </p>
          </div>
          <code className="font-mono text-xs text-muted-foreground">
            .harnery/events.ndjson · command stream
          </code>
        </header>

        <AgentChipProvider summaries={summaries}>
          <LiveLogTable
            agentNames={agentNames}
            initialAgent={agent ?? null}
            instanceToName={instanceToName}
          />
        </AgentChipProvider>
      </main>
    </div>
  );
}
