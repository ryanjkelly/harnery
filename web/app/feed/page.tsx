import { AgentChipProvider } from "@/components/AgentChip";
import { FeedView } from "@/components/feed/FeedView";
import { Notice } from "@/components/layout/Notice";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { buildAgentSummaryMap } from "@/lib/agent-summary";
import { coordRoot } from "@/lib/coord-reader";
import {
  FEED_WINDOWS,
  type FeedSnapshot,
  parseFeedWindow,
  REMOTE_FEED_WINDOW_MS,
  readFeedSnapshot,
} from "@/lib/feed-reader";
import { formatDuration } from "@/lib/format/duration";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Feed · Harnery" };

interface PageProps {
  searchParams: Promise<{ window?: string | string[] }>;
}

function readSnapshot(windowMs: number): FeedSnapshot | { error: string } {
  try {
    return readFeedSnapshot(coordRoot(), { windowMs });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Names of agents on this machine, so their chips get hover cards. */
function localAgentNames(snap: FeedSnapshot): Set<string> {
  const names = new Set<string>();
  for (const item of snap.items) {
    const refs = item.kind === "message" ? [item.from, item.to] : [item.agent];
    for (const ref of refs) if (ref.machine === snap.machine) names.add(ref.name);
  }
  return names;
}

export default async function FeedPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const windowKey = parseFeedWindow(sp.window);
  const result = readSnapshot(FEED_WINDOWS[windowKey]);
  const snap: FeedSnapshot | null = "items" in result ? result : null;
  const error = snap ? snap.error : (result as { error: string }).error;
  const now = new Date().toISOString();
  const remoteSources = snap?.sources.filter((s) => !s.local) ?? [];
  const summaries = snap ? buildAgentSummaryMap(localAgentNames(snap)) : {};

  return (
    <AgentChipProvider summaries={summaries}>
      <PageShell width="wide">
        <PageHeader
          title="Feed"
          description="Messages agents send each other and the journal entries they write, newest first, from this machine and every machine that shares its feed."
          actions={
            snap ? (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {snap.sources.map((s) => (
                  <span key={s.key} className="font-mono">
                    {s.local
                      ? `${s.label} (this machine) · ${s.items}`
                      : `${s.label} · ${s.items}${s.publishedAt ? ` · shared ${formatDuration(s.publishedAt, now)} ago` : ""}`}
                  </span>
                ))}
              </span>
            ) : null
          }
        />

        <div className="mb-3 flex flex-col gap-2 empty:hidden">
          {error ? (
            <Notice tone="danger" title="Could not read the feed">
              {error}
            </Notice>
          ) : null}
          {snap && !snap.sharing ? (
            <Notice>
              Only this machine&apos;s items are shown. Other machines appear once the project sets{" "}
              <code className="font-mono">feed.share: true</code>.
            </Notice>
          ) : null}
          {remoteSources
            .filter((s) => s.stale)
            .map((s) => (
              <Notice key={s.key} tone="warn">
                {s.publishedAt
                  ? `${s.label} last shared its feed ${formatDuration(s.publishedAt, now)} ago, so its newest items may be missing.`
                  : `${s.label} has stopped sharing its feed, so its newest items may be missing.`}
              </Notice>
            ))}
          {remoteSources.some((s) => s.truncated > 0) ? (
            <Notice>
              {`Some machines left out their oldest items to stay under the size limit: ${remoteSources
                .filter((s) => s.truncated > 0)
                .map((s) => `${s.label} (${s.truncated})`)
                .join(", ")}.`}
            </Notice>
          ) : null}
          {snap && remoteSources.length > 0 && snap.windowMs > REMOTE_FEED_WINDOW_MS ? (
            <Notice>
              Other machines share only their last 3 days, so older items come from this machine
              alone.
            </Notice>
          ) : null}
          {snap && snap.dropped > 0 ? (
            <Notice>
              {`Only the newest ${snap.items.length} items are shown; ${snap.dropped} older ones in this window are left out.`}
            </Notice>
          ) : null}
          {snap && (snap.skippedFiles > 0 || snap.malformedRefs.length > 0) ? (
            <Notice>
              {[
                snap.skippedFiles > 0 ? `${snap.skippedFiles} local files could not be read` : "",
                snap.malformedRefs.length > 0
                  ? `${snap.malformedRefs.length} shared feeds could not be parsed (${snap.malformedRefs.join(", ")})`
                  : "",
              ]
                .filter(Boolean)
                .join("; ")
                .concat(".")}
            </Notice>
          ) : null}
        </div>

        <FeedView
          items={snap?.items ?? []}
          localMachine={snap?.machine ?? ""}
          windowKey={windowKey}
        />
      </PageShell>
    </AgentChipProvider>
  );
}
