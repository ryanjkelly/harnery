import Link from "next/link";

import { AgentChip } from "@/components/AgentChip";
import { AgentLedgerStateBadge } from "@/components/AgentLedgerStateBadge";
import { AgentStateBadges } from "@/components/AgentStateBadges";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ageLabel, type Heartbeat } from "@/lib/coord-reader";

/**
 * Card representation of one active or stale agent. Mirrors the upstream app's
 * AgentCard layout: name + platform/kind/files Badge row in the header,
 * label/value rows in the body. An inset link keeps the card clickable while
 * the AgentChip and state tooltips remain independent interactive controls.
 */
export function AgentCard({ hb, stale }: { hb: Heartbeat; stale: boolean }) {
  const platform = hb.platform ?? "unknown";
  const filesCount = hb.files_touched.length;

  return (
    <Card className="relative hover:border-primary/60 transition-colors cursor-pointer h-full">
      <Link
        href={`/agents/${encodeURIComponent(hb.instance_id)}`}
        aria-label={`Open agent ${hb.name}`}
        className="absolute inset-0 z-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      />
      <CardHeader className="relative z-10 pointer-events-none">
        <CardTitle className="w-fit pointer-events-auto text-base normal-case tracking-normal text-foreground">
          <AgentChip name={hb.name} prefix="" className="font-mono" />
        </CardTitle>
        <div className="flex items-center gap-1 flex-wrap mt-1 pointer-events-auto">
          <Badge variant="outline">{platform}</Badge>
          {hb.kind && <Badge variant="secondary">{hb.kind}</Badge>}
          {filesCount > 0 && (
            <Badge variant="default">
              {filesCount} {filesCount === 1 ? "file" : "files"}
            </Badge>
          )}
          {stale && <Badge variant="warning">stale</Badge>}
          {hb.ledger_state && <AgentLedgerStateBadge state={hb.ledger_state} />}
          <AgentStateBadges
            activity={hb.activity}
            taskState={hb.task_state}
            reason={hb.task_state_reason}
            compact
          />
        </div>
      </CardHeader>
      <CardContent className="relative z-10 pointer-events-none text-xs text-muted-foreground space-y-1">
        <Row label="last seen" value={ageLabel(hb.age_seconds)} />
        {hb.task && <Row label="task" value={truncate(hb.task, 80)} />}
        {hb.task_state === "blocked" && hb.task_state_reason && (
          <Row label="blocked" value={truncate(hb.task_state_reason, 80)} />
        )}
        {hb.model && <Row label="model" value={truncate(hb.model, 40)} />}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground/70 tabular-nums shrink-0 w-16">{label}</span>
      <span className="text-foreground/90 truncate">{value}</span>
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
