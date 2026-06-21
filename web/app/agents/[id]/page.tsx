import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EndSessionButton } from "@/components/EndSessionButton";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { HealActions } from "@/components/HealActions";
import { HeartbeatJson } from "@/components/HeartbeatJson";
import { NavBar } from "@/components/NavBar";
import { NudgeBox } from "@/components/NudgeBox";
import { RecentActivity } from "@/components/RecentActivity";
import { ReleaseClaimButton } from "@/components/ReleaseClaimButton";
import { ScratchpadPanel } from "@/components/scratchpad/ScratchpadPanel";
import { NO_DATA } from "@/lib/format/no-data";
import {
  ageLabel,
  coordRoot,
  listScratchArchives,
  readAgent,
  readEndedAgent,
  readEvents,
  readScratch,
  scratchDir,
} from "@/lib/coord-reader";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  // Live heartbeat wins. When it's gone (session ended / file pruned) fall back
  // to a read-only view reconstructed from the durable event log, so the hover
  // card's "Open" button never dead-ends at a 404 for a stale agent. Call
  // notFound only when neither a heartbeat nor a durable identity exists.
  const live = readAgent(decoded);
  const isLive = !!live;
  const hb = live ?? readEndedAgent(decoded);
  if (!hb) notFound();

  const scratch = readScratch(decoded);
  const scratchPath = path.join(scratchDir(), `${decoded}.md`);
  const scratchBody = existsSync(scratchPath)
    ? readFileSync(scratchPath, "utf-8")
    : null;
  const archives = listScratchArchives(decoded);
  const events = readEvents({ instanceId: decoded, limit: 60 });

  return (
    <>
      <NavBar scannedDir={coordRoot()} />
      <main className="w-full max-w-screen-2xl mx-auto px-6 pb-10">
        <nav className="mb-4 text-xs text-muted-foreground">
          <Link href="/" className="hover:text-foreground">
            ← Dashboard
          </Link>
        </nav>
        <header className="mb-6 flex items-baseline justify-between flex-wrap gap-3">
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2 flex-wrap">
            <span className="font-mono">agent-{hb.name}</span>
            <Badge variant="outline">{hb.platform ?? "unknown"}</Badge>
            {hb.kind && <Badge variant="secondary">{hb.kind}</Badge>}
            {!isLive && (
              <Badge variant="outline" className="border-amber-500/40 text-amber-400">
                session ended
              </Badge>
            )}
          </h1>
          <div className="text-xs text-muted-foreground">
            {isLive ? ageLabel(hb.age_seconds) : `last seen ${ageLabel(hb.age_seconds)}`}
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Heartbeat</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
                <span className="text-muted-foreground">instance_id</span>
                <span className="font-mono break-all">{hb.instance_id}</span>
                <span className="text-muted-foreground">session_id</span>
                <span className="font-mono break-all">
                  {hb.session_id ?? NO_DATA}
                </span>
                <span className="text-muted-foreground">started</span>
                <span>
                  {hb.started_at ? (
                    <FormattedDateTime iso={hb.started_at} />
                  ) : (
                    NO_DATA
                  )}
                </span>
                <span className="text-muted-foreground">last heartbeat</span>
                <span>
                  <FormattedDateTime iso={hb.last_heartbeat} />
                </span>
                <span className="text-muted-foreground">model</span>
                <span className="font-mono">{hb.model || NO_DATA}</span>
                <span className="text-muted-foreground">last tool</span>
                <span className="font-mono">
                  {hb.last_tool ?? NO_DATA}
                  {hb.last_tool_target && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {hb.last_tool_target}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground">task</span>
                <span>
                  {hb.task ?? (
                    <span className="text-muted-foreground italic">none</span>
                  )}
                </span>
                {hb.turn_summary && (
                  <>
                    <span className="text-muted-foreground">turn summary</span>
                    <span className="text-muted-foreground">
                      {hb.turn_summary}
                    </span>
                  </>
                )}
              </div>
              {isLive && (
                <div className="mt-4 flex gap-2">
                  <EndSessionButton instanceId={hb.instance_id} name={hb.name} />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>File claims ({hb.files_touched.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {hb.files_touched.length === 0 ? (
                <p className="text-muted-foreground text-sm italic">
                  No file claims.
                </p>
              ) : (
                <ul className="text-xs space-y-1 max-h-60 overflow-y-auto">
                  {hb.files_touched.map((p) => (
                    <li
                      key={p}
                      className="flex items-center justify-between gap-2 group"
                    >
                      <span className="font-mono break-all min-w-0 flex-1">
                        {p}
                      </span>
                      <ReleaseClaimButton
                        instanceId={hb.instance_id}
                        path={p}
                        agentName={`agent-${hb.name}`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {isLive ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            <NudgeBox
              instanceId={hb.instance_id}
              agentName={`agent-${hb.name}`}
            />
            <HealActions
              instanceId={hb.instance_id}
              agentName={`agent-${hb.name}`}
            />
          </div>
        ) : (
          <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-muted-foreground">
            This agent&apos;s session has ended, so this view is read-only. Identity and recent
            activity are reconstructed from the durable event log; the live heartbeat (task, file
            claims, model) and the heal / nudge / kill actions are unavailable. They return
            automatically if the agent starts a new session.
          </div>
        )}

        <div className="mb-4">
          <ScratchpadPanel
            instanceId={hb.instance_id}
            agentName={`agent-${hb.name}`}
            scratch={scratch}
            rawBody={scratchBody}
            archiveCount={archives.length}
            readOnly={!isLive}
          />
        </div>

        <div className="mb-4">
          <HeartbeatJson heartbeat={hb as unknown as Record<string, unknown>} />
        </div>

        <RecentActivity events={events.rows} />
      </main>
    </>
  );
}
