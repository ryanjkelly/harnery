import { NavBar } from "@/components/NavBar";
import { ImageGallery } from "@/components/images/ImageGallery";
import {
  buildAgentSummaryMap,
  buildEndedAgentSummaries,
  buildObservedAgentSummaries,
  buildSubagentSummaries,
} from "@/lib/agent-summary";
import { coordRoot, readAgents, readInstanceIdentities } from "@/lib/coord-reader";
import { readImageCaptures } from "@/lib/images";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Images · Harnery" };

/**
 * /images: the agent image feed. Every image an agent viewed (Read) or
 * produced (a Bash command wrote it) is content-addressed into
 * `.harnery/images/` and recorded as an `image.captured` event. This page
 * renders the initial snapshot (grouped by content hash, newest first)
 * and the client subscribes to `/api/events-stream?type=image.captured` for
 * live appends, reusing the existing SSE infra rather than a bespoke stream.
 */
export default async function ImagesPage() {
  const { images, meta } = readImageCaptures({ limit: 300 });

  // instance_id → display name for resolving names on live-appended events
  // (SSE rows carry instance_id, not a name). Mirrors /events: live heartbeats
  // win, the durable start-event log fills agents that have since ended.
  const snap = readAgents();
  const identities = readInstanceIdentities();
  const instanceToName: Record<string, string> = {};
  for (const hb of [...snap.active, ...snap.stale]) instanceToName[hb.instance_id] = hb.name;
  for (const [iid, id] of Object.entries(identities)) {
    if (!instanceToName[iid]) instanceToName[iid] = id.name;
  }

  // Agent hover-card summaries. Layered low→high priority:
  //   1. observed-from-feed fallback: guarantees a card for every agent in the
  //      feed even when its heartbeat + start-event are both gone (resilience);
  //   2. ended-main + subagent identities from the durable log;
  //   3. live/recent main agents (heartbeat/scratch): richest, win on collision.
  const agentNames = Array.from(new Set(images.flatMap((img) => img.agents))).sort();
  const observed = images.flatMap((img) =>
    img.touches.map((t) => ({
      name: t.agent,
      last_seen: t.ts,
      instance_id: t.instance_id || undefined,
      platform: t.harness ?? null,
    })),
  );
  const summaries = {
    ...buildObservedAgentSummaries(observed),
    ...buildEndedAgentSummaries(identities),
    ...buildSubagentSummaries(identities),
    ...buildAgentSummaryMap(agentNames, identities),
  };

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      <NavBar scannedDir={coordRoot()} />
      <main className="flex-1 min-h-0 flex flex-col w-full px-6 pb-6">
        <header className="mb-4 flex items-baseline justify-between flex-wrap gap-3 shrink-0">
          <h1 className="text-xl font-semibold tracking-tight">Images</h1>
          <div className="text-xs text-muted-foreground flex items-center gap-3">
            <span>{meta.distinct.toLocaleString()} distinct</span>
            <span>{meta.total_touches.toLocaleString()} touches</span>
            <code className="font-mono text-muted-foreground/80">.harnery/images/</code>
          </div>
        </header>

        <ImageGallery initial={images} instanceToName={instanceToName} summaries={summaries} />
      </main>
    </div>
  );
}
