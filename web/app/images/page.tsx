import { ImageGallery } from "@/components/images/ImageGallery";
import { NavBar } from "@/components/NavBar";
import {
  buildAgentSummaryMap,
  buildEndedAgentSummaries,
  buildObservedAgentSummaries,
  buildSubagentSummaries,
} from "@/lib/agent-summary";
import { coordRoot, readInstanceIdentities } from "@/lib/coord-reader";
import { readImageCaptures } from "@/lib/images";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Images · Harnery" };

/**
 * /images: canonical V3 artifact observations joined to the bounded local
 * content-addressed blob store. Older retained blobs remain visible even when
 * they predate V3 attribution metadata.
 */
export default async function ImagesPage() {
  const { images, meta } = readImageCaptures({ limit: 300 });

  const identities = readInstanceIdentities();

  // Agent hover-card summaries. Layered low→high priority:
  //   1. observed-from-feed fallback: guarantees a card for every agent in the
  //      feed even when its heartbeat + start-event are both gone (resilience);
  //   2. ended-main + subagent identities from the durable log;
  //   3. live/recent main agents (heartbeat/journal): richest, win on collision.
  const agentNames = Array.from(new Set(images.flatMap((img) => img.agents))).sort();
  const observed = images.flatMap((img) =>
    img.touches.map((t) => ({
      name: t.agent,
      last_seen: t.ts,
      instance_id: t.instance_id || undefined,
      platform: t.adapter ?? null,
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

        <ImageGallery initial={images} summaries={summaries} unavailableReason={meta.reason} />
      </main>
    </div>
  );
}
