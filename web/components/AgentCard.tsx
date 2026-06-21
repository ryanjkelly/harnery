import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ageLabel, type Heartbeat } from "@/lib/coord-reader";

/**
 * Card representation of one active or stale agent. Mirrors the upstream app's
 * AgentCard layout: name + platform/kind/files Badge row in the header,
 * label/value rows in the body. Anchor-wrapped so the whole card is clickable.
 */
export function AgentCard({
  hb,
  stale,
}: {
  hb: Heartbeat;
  stale: boolean;
}) {
  const platform = hb.platform ?? "unknown";
  const filesCount = hb.files_touched.length;

  return (
    <Link
      href={`/agents/${encodeURIComponent(hb.instance_id)}`}
      className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card className="hover:border-primary/60 transition-colors cursor-pointer h-full">
        <CardHeader>
          <CardTitle className="text-base normal-case tracking-normal text-foreground">
            {hb.name}
          </CardTitle>
          <div className="flex items-center gap-1 flex-wrap mt-1">
            <Badge variant="outline">{platform}</Badge>
            {hb.kind && <Badge variant="secondary">{hb.kind}</Badge>}
            {filesCount > 0 && (
              <Badge variant="default">
                {filesCount} {filesCount === 1 ? "file" : "files"}
              </Badge>
            )}
            {stale && <Badge variant="warning">stale</Badge>}
          </div>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground space-y-1">
          <Row label="last seen" value={ageLabel(hb.age_seconds)} />
          {hb.last_tool && (
            <Row
              label="last tool"
              value={
                hb.last_tool_target
                  ? `${hb.last_tool} → ${truncate(hb.last_tool_target, 40)}`
                  : hb.last_tool
              }
            />
          )}
          {hb.task && <Row label="task" value={truncate(hb.task, 80)} />}
          {hb.turn_summary && (
            <Row label="last turn" value={truncate(hb.turn_summary, 80)} />
          )}
          {hb.model && <Row label="model" value={truncate(hb.model, 40)} />}
        </CardContent>
      </Card>
    </Link>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground/70 tabular-nums shrink-0 w-16">
        {label}
      </span>
      <span className="text-foreground/90 truncate">{value}</span>
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
