import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { notFound } from "next/navigation";
import { AgentChip } from "@/components/AgentChip";
import { AgentLedgerStateBadge } from "@/components/AgentLedgerStateBadge";
import { AgentStateBadges } from "@/components/AgentStateBadges";
import { AgentStateAtlas } from "@/components/agent/AgentStateAtlas";
import { BreakableMono } from "@/components/BreakableMono";
import { EndSessionButton } from "@/components/EndSessionButton";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { HealActions } from "@/components/HealActions";
import { HeartbeatJson } from "@/components/HeartbeatJson";
import { JournalPanel } from "@/components/journal/JournalPanel";
import { EmptyState } from "@/components/layout/EmptyState";
import { Notice } from "@/components/layout/Notice";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { NudgeBox } from "@/components/NudgeBox";
import { RecentActivity } from "@/components/RecentActivity";
import { ReleaseClaimButton } from "@/components/ReleaseClaimButton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { selectAgentSceneDetail } from "@/lib/agent-detail";
import { buildScene } from "@/lib/codec/scene-source";
import {
  ageLabel,
  coordRoot,
  journalDir,
  listJournalArchives,
  readAgent,
  readEndedAgent,
  readEvents,
  readInstanceIdentities,
  readJournal,
} from "@/lib/coord-reader";
import { NO_DATA } from "@/lib/format/no-data";
import { lookupByName } from "@/lib/identities";
import type { SemanticAgentReadModelV2 } from "../../../../src/core/semantic/contract";
import { inspectSemanticDocument } from "../../../../src/core/semantic/storage";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  // The live V3 generation wins. Once it ends, fall back to the durable V3
  // terminal record so the hover card never dead-ends at a 404.
  const live = readAgent(decoded);
  const hb = live ?? readEndedAgent(decoded);
  if (!hb) notFound();
  const hasLiveGeneration = !!live;
  const isTerminal = hb.ledger_state === "terminal" || !live;

  const journal = readJournal(decoded);
  const journalPath = path.join(journalDir(), `${decoded}.md`);
  const journalBody = existsSync(journalPath) ? readFileSync(journalPath, "utf-8") : null;
  const archives = listJournalArchives(decoded);
  const events = readEvents({ instanceId: hb.generation_id ? hb.instance_id : decoded, limit: 60 });
  const scene = await buildScene();
  const sceneDetail = selectAgentSceneDetail(scene, [
    decoded,
    hb.instance_id,
    hb.v3_instance_id,
    hb.generation_id,
  ]);
  const persona = lookupByName(hb.name);
  const instanceIdentities = readInstanceIdentities();
  const instanceIdentity = [hb.v3_instance_id, hb.instance_id, decoded]
    .map((candidate) => (candidate ? instanceIdentities[candidate] : undefined))
    .find((candidate) => candidate !== undefined);
  let semanticDocument: SemanticAgentReadModelV2 | undefined;
  try {
    semanticDocument = inspectSemanticDocument(
      coordRoot(),
      hb.generation_id ?? sceneDetail.panel?.instance_id ?? hb.v3_instance_id ?? hb.instance_id,
    );
  } catch {
    // The readable deterministic page remains available when a local semantic
    // file is corrupt; the raw event and coordination records still diagnose it.
  }
  const namesByInstance = Object.fromEntries(
    scene.panels.map((panel) => [panel.instance_id, panel.identity.display_name]),
  );

  return (
    <PageShell width="wide">
      <PageHeader
        back={{ href: "/", label: "Dashboard" }}
        title={<AgentChip name={hb.name} />}
        meta={
          <>
            <Badge variant="outline">{hb.platform ?? "unknown"}</Badge>
            {hb.kind && <Badge variant="secondary">{hb.kind}</Badge>}
            <AgentStateBadges
              activity={hb.activity}
              taskState={hb.task_state}
              reason={hb.task_state_reason}
            />
            {hb.ledger_state && <AgentLedgerStateBadge state={hb.ledger_state} />}
          </>
        }
        actions={isTerminal ? `last seen ${ageLabel(hb.age_seconds)}` : ageLabel(hb.age_seconds)}
      />

      <AgentStateAtlas
        panel={sceneDetail.panel}
        relationships={sceneDetail.relationships}
        transients={sceneDetail.transients}
        sceneFreshness={scene.freshness}
        sceneGeneratedAt={scene.generated_at}
        semanticDocument={semanticDocument}
        namesByInstance={namesByInstance}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Direct coordination record</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
              <span className="text-muted-foreground">instance_id</span>
              <span className="font-mono break-all">{hb.instance_id}</span>
              <span className="text-muted-foreground">v3_instance_id</span>
              <span className="font-mono break-all">{hb.v3_instance_id ?? NO_DATA}</span>
              <span className="text-muted-foreground">session_id</span>
              <span className="font-mono break-all">{hb.session_id ?? NO_DATA}</span>
              <span className="text-muted-foreground">started</span>
              <span>{hb.started_at ? <FormattedDateTime iso={hb.started_at} /> : NO_DATA}</span>
              <span className="text-muted-foreground">last observed</span>
              <span>
                <FormattedDateTime iso={hb.last_heartbeat} />
              </span>
              <span className="text-muted-foreground">model</span>
              <span className="font-mono">{hb.model || NO_DATA}</span>
              <span className="text-muted-foreground">task</span>
              <span>{hb.task ?? <span className="text-muted-foreground italic">none</span>}</span>
              <span className="text-muted-foreground">task observed</span>
              <span>
                {hb.task_updated_at ? <FormattedDateTime iso={hb.task_updated_at} /> : NO_DATA}
              </span>
              <span className="text-muted-foreground">activity</span>
              <span>
                {hb.activity}
                {hb.activity_source && (
                  <span className="text-muted-foreground"> via {hb.activity_source}</span>
                )}
              </span>
              <span className="text-muted-foreground">activity observed</span>
              <span>
                {hb.activity_updated_at ? (
                  <FormattedDateTime iso={hb.activity_updated_at} />
                ) : (
                  NO_DATA
                )}
              </span>
              <span className="text-muted-foreground">lifecycle</span>
              <span>
                {hb.task_state}
                {hb.task_state_reason && (
                  <span className="text-muted-foreground">: {hb.task_state_reason}</span>
                )}
              </span>
              <span className="text-muted-foreground">lifecycle observed</span>
              <span>
                {hb.task_state_updated_at ? (
                  <FormattedDateTime iso={hb.task_state_updated_at} />
                ) : (
                  NO_DATA
                )}
              </span>
              {hb.generation_id && (
                <>
                  <span className="text-muted-foreground">ledger generation</span>
                  <span className="font-mono break-all">{hb.generation_id}</span>
                </>
              )}
              {hb.open_span_count !== undefined && hb.open_span_count > 0 && (
                <>
                  <span className="text-muted-foreground">open tool spans</span>
                  <span>{hb.open_span_count}</span>
                </>
              )}
            </div>
            {hasLiveGeneration && !isTerminal && (
              <div className="mt-4 flex gap-2">
                <EndSessionButton instanceId={hb.instance_id} name={hb.name} />
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Durable identity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-[7rem_1fr] gap-y-1 text-xs">
                <span className="text-muted-foreground">persona id</span>
                <span className="font-mono break-all">
                  {persona?.agent_id ?? instanceIdentity?.agent_id ?? NO_DATA}
                </span>
                <span className="text-muted-foreground">created</span>
                <span>
                  {persona?.created_at ? <FormattedDateTime iso={persona.created_at} /> : NO_DATA}
                </span>
                <span className="text-muted-foreground">aliases</span>
                <span>
                  {persona?.aliases.length
                    ? persona.aliases
                        .map((alias) => `${alias.name} (${alias.retired_at})`)
                        .join(", ")
                    : NO_DATA}
                </span>
                <span className="text-muted-foreground">agent type</span>
                <span>{instanceIdentity?.agent_type ?? hb.kind ?? NO_DATA}</span>
                <span className="text-muted-foreground">durable model</span>
                <span className="font-mono">{instanceIdentity?.model ?? NO_DATA}</span>
                <span className="text-muted-foreground">durable last seen</span>
                <span>
                  {instanceIdentity?.last_ts ? (
                    <FormattedDateTime iso={instanceIdentity.last_ts} />
                  ) : (
                    NO_DATA
                  )}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>File claims ({hb.files_touched.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {hb.files_touched.length === 0 ? (
                <EmptyState>No file claims.</EmptyState>
              ) : (
                <ul className="text-xs space-y-1 max-h-60 overflow-y-auto">
                  {hb.files_touched.map((p) => (
                    <li key={p} className="flex items-center justify-between gap-2 group">
                      <BreakableMono text={p} className="min-w-0 flex-1" />
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
      </div>

      {hasLiveGeneration && !isTerminal ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          <NudgeBox instanceId={hb.instance_id} agentName={`agent-${hb.name}`} />
          <HealActions instanceId={hb.instance_id} agentName={`agent-${hb.name}`} />
        </div>
      ) : (
        <Notice className="mb-4">
          This view is read-only because no live V3 generation is available. Durable lifecycle and
          recent activity remain visible.
        </Notice>
      )}

      <div className="mb-4">
        <JournalPanel
          instanceId={hb.instance_id}
          agentName={`agent-${hb.name}`}
          journal={journal}
          rawBody={journalBody}
          archiveCount={archives.length}
          readOnly={!hasLiveGeneration || isTerminal}
        />
      </div>

      <div className="mb-4">
        <HeartbeatJson
          title="Direct coordination JSON"
          heartbeat={hb as unknown as Record<string, unknown>}
        />
      </div>

      {sceneDetail.panel && (
        <div className="mb-4">
          <HeartbeatJson
            title="Codec projection JSON"
            heartbeat={sceneDetail.panel as unknown as Record<string, unknown>}
          />
        </div>
      )}

      {semanticDocument && (
        <div className="mb-4">
          <HeartbeatJson
            title="Semantic document JSON"
            heartbeat={semanticDocument as unknown as Record<string, unknown>}
          />
        </div>
      )}

      <RecentActivity events={events.rows} />
    </PageShell>
  );
}
