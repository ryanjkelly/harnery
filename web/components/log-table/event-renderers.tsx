"use client";

/**
 * Per-event-shape `LogRowRenderer` configs consumed by the shared
 * `<LogTable>`. Two flavors today:
 *
 *   - `hookEventRenderer`: `.harnery/events.ndjson` (canonical per-hook log).
 *     One row per PreToolUse/PostToolUse/PromptSubmit/SessionStart event from
 *     agent-hooks. `data.tool_input` arrives as a JSON-encoded STRING; the
 *     renderer parses it back to an object so the expand-row JSON view
 *     shows structure instead of an escaped blob.
 *
 *   - `sessionEventRenderer`: `.harnery/session-events.ndjson` (session-tee
 *     command stream). command_start / output / command_end / narration /
 *     end_of_turn / hook_event. Higher cadence; rows are typically smaller.
 *
 * Both renderers produce the same `LogRow` shape so the table doesn't have
 * to know which source it's rendering.
 */

import { FilePath } from "@/components/file-viewer/FilePath";
import { linkifyPaths } from "@/components/file-viewer/linkify";
import type { EventRow } from "@/lib/coord-reader";
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
    getKind: (e) => e.event_type,
    getKindVariant: (e) => hookEventVariant(e.event_type),
    getAgentName: (e) => (e.instance_id ? (instanceToName[e.instance_id] ?? null) : null),
    getAgentInstanceId: (e) => e.instance_id ?? null,
    renderSummary: (e) => <HookEventSummary type={e.event_type} data={e.data} repoRoot={repoRoot} />,
    getSearchableText: (e) => hookEventSearchText(e, instanceToName),
    getRaw: (e) => ({ ...e, data: unpackToolInput(e.data) }),
  };
}

function hookEventVariant(type: string): LogRowVariant {
  if (type === "tool.pre_use") return "info";
  if (type === "tool.post_use") return "success";
  if (type === "tool.post_use_failure") return "destructive";
  if (type === "user_prompt.submit") return "accent";
  if (type === "turn.stop" || type === "subagent.stop") return "secondary";
  if (type === "session.start") return "accent";
  if (type.startsWith("health.")) return "warning";
  if (type.startsWith("state.")) return "muted";
  return "muted";
}

function HookEventSummary({
  type,
  data,
  repoRoot,
}: {
  type: string;
  data: Record<string, unknown> | undefined;
  repoRoot: string;
}) {
  if (!data) return null;

  if (type === "tool.pre_use" || type === "tool.post_use") {
    return <ToolSummary data={data} repoRoot={repoRoot} />;
  }
  if (type === "tool.post_use_failure") {
    return <ToolSummary data={data} repoRoot={repoRoot} failure />;
  }
  if (type === "user_prompt.submit") {
    const prompt = String(data.prompt_text ?? "");
    return <span className="text-foreground/85 italic">{truncate(prompt, 360)}</span>;
  }
  if (type === "turn.stop" || type === "subagent.stop") {
    const calls = data.tool_call_count as number | undefined;
    const textLen = data.text_length as number | undefined;
    const statusOk = data.status_box_present === true;
    return (
      <span className="inline-flex items-center gap-3 flex-wrap">
        {calls !== undefined && calls >= 0 && <KV label="calls" value={String(calls)} />}
        {textLen !== undefined && <KV label="text" value={String(textLen)} />}
        <span
          className={
            statusOk
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-amber-600 dark:text-amber-400"
          }
        >
          {statusOk ? "status box ✓" : "no status box"}
        </span>
      </span>
    );
  }
  if (type === "state.task_set") {
    const task = String(data.task ?? "");
    return (
      <span className="text-foreground/85">
        <span className="text-muted-foreground/60">task =</span> {truncate(task, 300)}
      </span>
    );
  }
  if (type === "state.status_checked") {
    return <span className="text-muted-foreground italic">status box rendered</span>;
  }
  if (type === "session.start") {
    const cwd = String(data.cwd ?? "");
    const source = String(data.source ?? "");
    return (
      <span className="text-foreground/85">
        <span className="text-muted-foreground/60">{source}</span>{" "}
        <code className="text-muted-foreground">{shortenPath(cwd, repoRoot)}</code>
      </span>
    );
  }
  if (type.startsWith("health.")) {
    return (
      <span className="text-amber-600 dark:text-amber-400 italic">
        {type.replace(/^health\./, "")}: {truncate(JSON.stringify(data), 240)}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground/70 font-mono">
      {truncate(JSON.stringify(data), 300)}
    </span>
  );
}

function ToolSummary({
  data,
  repoRoot,
  failure = false,
}: {
  data: Record<string, unknown>;
  repoRoot: string;
  failure?: boolean;
}) {
  const tool = String(data.tool_name ?? "");
  const intent = (data.intent as string | undefined) ?? "";
  const target = describeToolTarget(tool, data);
  return (
    <span className="inline-flex items-start gap-2 flex-wrap">
      <span className="font-mono text-foreground/95 shrink-0">{tool}</span>
      {/* Structured file targets become clickable: Read/Edit/
          Write/NotebookEdit file_path + Grep/Glob path are typed JSON fields, so
          no regex risk. The viewer's resolveFile accepts the absolute path and
          renders failure states (denied/not-found/dir) gracefully. */}
      {target.filePath && (
        <FilePath
          path={target.filePath}
          display={shortenPath(target.filePath, repoRoot)}
          className="font-mono text-muted-foreground break-all"
        />
      )}
      {target.text && (
        <span className="text-muted-foreground break-all">
          {/* Bash command_head path extraction: linkify
              path-shaped tokens in the command; other tools' descriptor text
              (urls/queries/patterns) stays plain. */}
          {target.linkify ? linkifyPaths(target.text) : target.text}
        </span>
      )}
      {intent && (
        <span className="text-foreground/70 italic wrap-break-word">
          <span className="text-muted-foreground/50">· </span>
          {truncate(intent, 200)}
        </span>
      )}
      {failure && <span className="text-rose-600 dark:text-rose-400 shrink-0">⚠ failed</span>}
    </span>
  );
}

/** A tool's display target: an optional clickable repo file path + optional
 * descriptor text. `filePath` is rendered as a <FilePath> (Phase-1 wire-in). */
interface ToolTarget {
  filePath?: string;
  text?: string;
  /** Run `text` through the prose path-linkifier (Bash command_head). */
  linkify?: boolean;
}

function describeToolTarget(tool: string, data: Record<string, unknown>): ToolTarget {
  const input = parseMaybeJsonObject(data.tool_input);
  if (!input) {
    if (typeof data.tool_input === "string") return { text: truncate(data.tool_input, 120) };
    return {};
  }
  switch (tool) {
    case "Bash": {
      // Prefer the command itself (not the description) so path extraction has
      // real paths to find; linkify it.
      const cmd = String(input.command ?? input.description ?? "");
      return { text: shortenCmd(cmd, 160), linkify: true };
    }
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const fp = String(input.file_path ?? "");
      return fp ? { filePath: fp } : {};
    }
    case "Grep":
    case "Glob": {
      // The pattern is the descriptor; the search `path` (when given) is the
      // clickable target. Often a directory, in which case the viewer shows a
      // "not a regular file" state for those, which is graceful, not broken.
      const path = typeof input.path === "string" ? input.path : undefined;
      return { text: String(input.pattern ?? ""), filePath: path };
    }
    case "WebFetch":
      return { text: String(input.url ?? "") };
    case "WebSearch":
      return { text: String(input.query ?? "") };
    case "Task":
      return { text: String(input.description ?? input.subagent_type ?? "") };
    case "TodoWrite":
      return {};
    case "AskUserQuestion": {
      const qs = input.questions;
      if (Array.isArray(qs) && qs.length > 0) {
        const first = qs[0] as Record<string, unknown>;
        return { text: truncate(String(first.question ?? ""), 100) };
      }
      return {};
    }
    default:
      return {};
  }
}

function hookEventSearchText(e: EventRow, instanceToName: Record<string, string>): string {
  const name = e.instance_id ? (instanceToName[e.instance_id] ?? "") : "";
  // Flatten everything that could plausibly be searched on. Including raw
  // JSON of `data` so an operator can find rows by any nested value.
  return [
    e.event_type,
    e.event_id,
    name,
    e.instance_id ?? "",
    e.session_id ?? "",
    e.harness ?? "",
    e.source ?? "",
    e.data ? JSON.stringify(e.data) : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Hook events stash `tool_input` as a JSON-encoded STRING. Parse it back to
 * an object so the expand-row JSON view shows the structure. Also unwrap a
 * few other commonly-stringified fields (`output_summary`). Idempotent: if
 * the value isn't a parseable JSON object, return as-is.
 */
function unpackToolInput(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return data;
  const out: Record<string, unknown> = { ...data };
  if (typeof out.tool_input === "string") {
    const parsed = parseMaybeJsonObject(out.tool_input);
    if (parsed) out.tool_input = parsed;
  }
  if (typeof out.output_summary === "string") {
    const parsed = parseMaybeJsonObject(out.output_summary);
    if (parsed) out.output_summary = parsed;
  }
  return out;
}

function parseMaybeJsonObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
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
    // `command_start`/`command_end` carry a `cmd_id` but aren't `output`, so
    // they return null and anchor the block instead of joining it.
    getGroupKey: (e) =>
      e.type === "output" && e.cmd_id ? `${e.stream ?? "stdout"}:${e.cmd_id}` : null,
  };
}

function sessionKindLabel(e: SessionEvent): string {
  if (e.type === "output") return e.stream === "stderr" ? "stderr" : "stdout";
  if (e.type === "command_end") {
    return e.exit === 0 ? "exit ✓" : `exit ✗${e.exit ?? "?"}`;
  }
  return e.type;
}

function sessionEventVariant(e: SessionEvent): LogRowVariant {
  switch (e.type) {
    case "command_start":
      return "info";
    case "command_end":
      return e.exit === 0 ? "success" : "destructive";
    case "output":
      return e.stream === "stderr" ? "warning" : "muted";
    case "narration":
      return "info";
    case "end_of_turn":
      return "accent";
    case "hook_event":
      return "accent";
    case "set_task":
      return "secondary";
    case "file_claim":
    case "file_release":
    case "peer_change":
      return "secondary";
    default:
      return "muted";
  }
}

function SessionEventSummary({ event }: { event: SessionEvent }) {
  switch (event.type) {
    case "command_start":
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
    case "command_end": {
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
    case "output":
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
    case "narration":
      return (
        <span className="text-cyan-700 dark:text-cyan-300 italic wrap-break-word">
          ⋯ {event.message}
        </span>
      );
    case "end_of_turn":
      return <span className="text-violet-700 dark:text-violet-300">end of turn</span>;
    case "hook_event":
      return (
        <span className="text-foreground/80">
          hook: {String((event as unknown as { hook?: string }).hook ?? "")}
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
