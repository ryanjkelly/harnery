"use client";

/**
 * Per-event-shape `LogRowRenderer` configs consumed by the shared
 * `<LogTable>`. Two flavors today:
 *
 *   - `hookEventRenderer`: canonical V3 events across hooks, commands, and
 *     coordination producers.
 *
 *   - `sessionEventRenderer`: privacy-safe V3 command projection. Rows are
 *     typically smaller and optimized for live command review.
 *
 * Both renderers produce the same `LogRow` shape so the table doesn't have
 * to know which source it's rendering.
 */

import { FilePath } from "@/components/file-viewer/FilePath";
import type { EventRow } from "@/lib/coord-reader";
import { describeEventV3 } from "@/lib/event-v3-display";
import type { LogRowRenderer, LogRowVariant } from "@/lib/log-table/types";
import type { SessionEvent } from "@/lib/session-events";

/* ════════════════════════════════════════════════════════════════════ */
/* /events: canonical hook events                                        */
/* ════════════════════════════════════════════════════════════════════ */

export function makeHookEventRenderer(
  instanceToName: Record<string, string>,
  repoRoot = "",
): LogRowRenderer<EventRow> {
  return {
    getTs: (e) => e.ts,
    getKind: (e) => describeEventV3(e).kind,
    getKindVariant: (e) => describeEventV3(e).variant,
    getAgentName: (e) => (e.instance_id ? (instanceToName[e.instance_id] ?? null) : null),
    getAgentInstanceId: (e) => e.instance_id ?? null,
    renderSummary: (e) => <HookEventSummary event={e} repoRoot={repoRoot} />,
    getSearchableText: (e) => hookEventSearchText(e, instanceToName),
    getRaw: (e) => e,
  };
}

function HookEventSummary({ event, repoRoot }: { event: EventRow; repoRoot: string }) {
  const display = describeEventV3(event);
  return (
    <span className="inline-flex items-start gap-2 flex-wrap">
      {display.workspace_path && (
        <FilePath
          path={display.workspace_path}
          display={shortenPath(display.workspace_path, repoRoot)}
          className="font-mono text-muted-foreground break-all"
        />
      )}
      <span className="text-foreground/75 wrap-break-word">{display.summary}</span>
    </span>
  );
}

function hookEventSearchText(e: EventRow, instanceToName: Record<string, string>): string {
  const name = e.instance_id ? (instanceToName[e.instance_id] ?? "") : "";
  const display = describeEventV3(e);
  return [
    e.event_type,
    display.kind,
    display.summary,
    e.event_id,
    name,
    e.instance_id ?? "",
    e.session_id ?? "",
    e.adapter ?? "",
    e.source ?? "",
    JSON.stringify(e.data),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/* ════════════════════════════════════════════════════════════════════ */
/* /live: session-tee events                                             */
/* ════════════════════════════════════════════════════════════════════ */

export function makeSessionEventRenderer(
  instanceToName: Record<string, string> = {},
): LogRowRenderer<SessionEvent> {
  return {
    // No `getId`: React keys come from LogTable's identity-WeakMap. Tried
    // a (ts, type, cmd_id, line-prefix) tuple here originally; two `ls`
    // output lines that shared a 48-char path prefix at the same ms
    // collided and triggered React's duplicate-key error. Identity is the
    // only collision-free choice.
    getTs: (e) => e.ts,
    getKind: (e) => sessionKindLabel(e),
    getKindVariant: (e) => sessionEventVariant(e),
    // `agent_name: "unknown"` is the session-tee producer's fallback when
    // its pid-map walk doesn't resolve to an owner (most commonly when the
    // owner's session started before the pid-map entry was minted, e.g.
    // after a pidmap heal). When we see it, drop back to the instance_id
    // lookup so historical "unknown" rows pick up the right name once
    // heartbeats catch up.
    getAgentName: (e) => {
      const name = e.agent_name;
      if (name && name !== "unknown") return name;
      if (e.instance_id && instanceToName[e.instance_id]) return instanceToName[e.instance_id];
      return null;
    },
    getAgentInstanceId: (e) => e.instance_id ?? null,
    renderSummary: (e) => <SessionEventSummary event={e} />,
    getSearchableText: (e) =>
      [
        e.type,
        e.agent_name,
        e.cmd ?? "",
        e.intent ?? "",
        e.line ?? "",
        e.message ?? "",
        e.stream ?? "",
        e.exit !== undefined && e.exit !== null ? `exit ${e.exit}` : "",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    getRaw: (e) => e,
    // Fold a command's per-line output into one block. Each stdout/stderr
    // line is its own ndjson record (that's how the streaming tee writes
    // them) but they share `cmd_id` and arrive contiguously. Key by stream
    // too so a stdout run and a stderr run from the same command stay
    // visually distinct rather than merging into one mixed block.
    // Command boundary events carry a `cmd_id` but are not output, so they
    // return null and anchor the block instead of joining it.
    getGroupKey: (e) =>
      e.type === "command.output_observed" && e.cmd_id
        ? `${e.stream ?? "stdout"}:${e.cmd_id}`
        : null,
  };
}

function sessionKindLabel(e: SessionEvent): string {
  if (e.type === "command.output_observed") return e.stream === "stderr" ? "stderr" : "stdout";
  if (e.type === "command.completed" || e.type === "tool.completed") {
    return e.exit === 0 ? "exit ✓" : `exit ✗${e.exit ?? "?"}`;
  }
  return e.type;
}

function sessionEventVariant(e: SessionEvent): LogRowVariant {
  switch (e.type) {
    case "command.started":
    case "tool.requested":
      return "info";
    case "command.completed":
    case "tool.completed":
      return e.exit === 0 ? "success" : "destructive";
    case "command.output_observed":
      return e.stream === "stderr" ? "warning" : "muted";
    default:
      return "muted";
  }
}

function SessionEventSummary({ event }: { event: SessionEvent }) {
  switch (event.type) {
    case "command.started":
    case "tool.requested":
      return (
        <span className="text-foreground/90 break-all">
          <span className="text-muted-foreground">$</span>{" "}
          {event.intent && event.intent !== event.cmd ? (
            <>
              <span className="text-sky-700 dark:text-sky-400 italic">{event.intent}</span>{" "}
              <span className="text-muted-foreground">→</span>{" "}
            </>
          ) : null}
          <code className="text-foreground/90">{event.cmd}</code>
        </span>
      );
    case "command.completed":
    case "tool.completed": {
      const ok = event.exit === 0;
      return (
        <span
          className={
            ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"
          }
        >
          {ok ? "✓" : "✗"} exit {event.exit ?? "?"}
          {event.signal ? ` (${event.signal})` : ""}
          {event.duration_ms ? (
            <>
              {" · "}
              <span className="text-muted-foreground tabular-nums">
                {formatDuration(event.duration_ms)}
              </span>
            </>
          ) : null}
        </span>
      );
    }
    case "command.output_observed":
      return (
        <span
          className={
            event.stream === "stderr"
              ? "text-amber-700 dark:text-amber-300 whitespace-pre-wrap break-all"
              : "text-foreground/85 whitespace-pre-wrap break-all"
          }
        >
          {event.line}
        </span>
      );
    default:
      return (
        <span className="text-muted-foreground font-mono break-all">
          {truncate(JSON.stringify(event), 240)}
        </span>
      );
  }
}

/* ════════════════════════════════════════════════════════════════════ */
/* Shared helpers                                                        */
/* ════════════════════════════════════════════════════════════════════ */

function KV({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-muted-foreground/60">{label}</span>{" "}
      <span className="tabular-nums text-foreground/85">{value}</span>
    </span>
  );
}

function shortenPath(p: string, repoRoot: string): string {
  if (!p) return "";
  // Strip the coord-root prefix so paths render repo-relative on any host.
  const prefix = repoRoot && !repoRoot.endsWith("/") ? `${repoRoot}/` : repoRoot;
  if (prefix && p.startsWith(prefix)) return p.slice(prefix.length);
  return p.length > 120 ? `…${p.slice(-117)}` : p;
}

function shortenCmd(s: string, n: number): string {
  if (!s) return "";
  const stripped = s.replace(/^#\s*intent:[^\n]*\n/m, "").trim();
  return truncate(stripped, n);
}

function truncate(s: string, n: number): string {
  if (!s) return s;
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}
