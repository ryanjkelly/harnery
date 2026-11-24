"use client";

import { MessageSquare, NotebookPen } from "lucide-react";
import { memo, useState } from "react";

import { AgentChip } from "@/components/AgentChip";
import { useDateTimeFormat } from "@/components/DateTimeFormatProvider";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { categoryMeta } from "@/components/journal/categories";
import { RelativeTimeAgo } from "@/components/RelativeTimeAgo";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { FeedAgentRef, FeedItem } from "@/lib/feed-items";
import { TONE } from "@/lib/tone";

/** Bodies longer than this (or with more lines) get a show-all toggle. */
const CLAMP_LINES = 6;
const CLAMP_CHARS = 480;

function isLong(body: string): boolean {
  if (body.length > CLAMP_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < body.length; i++) {
    if (body.charCodeAt(i) === 10 && ++lines > CLAMP_LINES) return true;
  }
  return false;
}

function Machine({ label }: { label: string }) {
  return (
    <span className="rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">
      {`@${label}`}
    </span>
  );
}

function Agent({ who, localMachine }: { who: FeedAgentRef; localMachine: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <AgentChip name={who.name} className="font-mono text-foreground" />
      {who.machine !== localMachine ? <Machine label={who.machine} /> : null}
    </span>
  );
}

function Time({ iso }: { iso: string }) {
  const prefs = useDateTimeFormat();
  const template = /H/.test(prefs.timestamp.template) ? "HH:mm" : "h:mm A";
  return (
    <Tooltip
      content={
        <span>
          <FormattedDateTime iso={iso} /> · <RelativeTimeAgo iso={iso} />
        </span>
      }
      side="right"
    >
      <FormattedDateTime iso={iso} template={template} />
    </Tooltip>
  );
}

/**
 * One feed row: time, kind marker, who, and the body. Kept flat (no card) so
 * rows stack into one contiguous list; every body stays in the DOM for find.
 */
export const FeedRow = memo(function FeedRow({
  item,
  localMachine,
}: {
  item: FeedItem;
  localMachine: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = isLong(item.body);
  const isMessage = item.kind === "message";
  const meta = item.kind === "journal" ? categoryMeta(item.category) : null;

  return (
    <li
      className={cn(
        "flex gap-3 border-l-2 px-3 py-1.5 hover:bg-muted/40",
        isMessage ? TONE.accent.accentBorder : TONE.neutral.accentBorder,
      )}
    >
      <div className="w-[4.25rem] shrink-0 whitespace-nowrap pt-px font-mono text-xs tabular-nums text-muted-foreground">
        <Time iso={item.at} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          {item.kind === "message" ? (
            <>
              <MessageSquare aria-label="Message" className={cn("size-3.5", TONE.accent.text)} />
              <Agent who={item.from} localMachine={localMachine} />
              <span aria-hidden className="text-subtle-foreground">
                →
              </span>
              <Agent who={item.to} localMachine={localMachine} />
            </>
          ) : (
            <>
              <NotebookPen aria-label="Journal entry" className="size-3.5 text-muted-foreground" />
              <Agent who={item.agent} localMachine={localMachine} />
              {meta ? (
                <Badge variant={meta.variant} title={meta.short}>
                  {meta.label}
                </Badge>
              ) : null}
            </>
          )}
          {item.body_truncated ? (
            <Badge variant="muted" title="The sharing machine shortened this text.">
              shortened
            </Badge>
          ) : null}
        </div>
        <div
          className={cn(
            "mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-snug text-foreground",
            long && !expanded && "line-clamp-6",
          )}
        >
          {item.body}
        </div>
        {long ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {expanded ? "Show less" : "Show all"}
          </button>
        ) : null}
      </div>
    </li>
  );
});
