"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Archive,
  ArrowDownAZ,
  ArrowUpAZ,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Edit3,
  Eye,
  EyeOff,
  FileText,
  HelpCircle,
  ListPlus,
  RotateCcw,
  Save,
  Search,
  Send,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { useHostInfo } from "@/components/HostInfoProvider";
import { SnapshotDiff } from "@/components/diff/SnapshotDiff";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { ScratchCategory } from "@/lib/coord-writer";

import { categoryMeta, CATEGORY_META } from "./categories";
import { CategoryPicker } from "./CategoryPicker";
import { EntryCard, type EntryRow } from "./EntryCard";
import { FileSizeMeter } from "./FileSizeMeter";

type Tab = "timeline" | "compose" | "raw" | "archives";

interface ArchiveRow {
  filename: string;
  bytes: number;
  archived_at: string;
  is_pre_ui_edit: boolean;
}

const BODY_BYTE_CAP = 64 * 1024;

/**
 * Unified scratchpad section for the agent detail page. Replaces the old
 * separate "Scratchpad entries" + "Scratchpad editor" cards. Four tabs:
 *
 *   • Timeline:  chronological entry feed (default landing)
 *   • Add entry: safe single-entry append via POST /scratchpad
 *   • Raw:       view the markdown file as-is + advanced "replace whole file"
 *   • Archives:  every prior snapshot under .harnery/scratch/archived/
 */
export function ScratchpadPanel({
  instanceId,
  agentName,
  scratch,
  rawBody,
  archiveCount,
  readOnly = false,
}: {
  instanceId: string;
  agentName: string;
  scratch: {
    exists: boolean;
    bytes: number;
    entries: EntryRow[];
    path: string;
  };
  rawBody: string | null;
  archiveCount: number;
  /** Ended agents: hide the write surfaces (compose tab + Raw replace editor).
   * The journal is still fully readable; appending to a dead instance's file
   * would just orphan it. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  // Landing tab. Live agents with no content default to "compose" (seed one);
  // read-only agents can't compose, so prefer whatever's readable: entries →
  // timeline, else archives if any, else the (empty-state) raw view.
  const [tab, setTab] = useState<Tab>(() => {
    if (scratch.exists && scratch.entries.length > 0) return "timeline";
    if (readOnly) return archiveCount > 0 ? "archives" : "raw";
    return "compose";
  });

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle className="flex items-center gap-1.5">
            <FileText className="size-4 text-muted-foreground" />
            Scratchpad
          </CardTitle>
          <Tooltip
            side="right"
            content={
              <div className="space-y-1.5 max-w-[20rem]">
                <div className="font-semibold">What is the scratchpad?</div>
                <div className="text-popover-foreground/90">
                  An append-only markdown journal the agent writes during a
                  session. Used to leave notes for future-self (across
                  compaction), surface blockers, and hand off context to
                  peers. The file is at <code>{scratch.path}</code>.
                </div>
                <div className="text-muted-foreground">
                  Other agents pull-read this on demand. That&apos;s how they
                  coordinate without burning context.
                </div>
              </div>
            }
          >
            <span
              aria-label="What is the scratchpad?"
              className="text-muted-foreground hover:text-foreground cursor-help"
            >
              <HelpCircle className="size-3.5" />
            </span>
          </Tooltip>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Tooltip
            content={
              <div>
                <div className="font-semibold">
                  {scratch.entries.length}{" "}
                  {scratch.entries.length === 1 ? "entry" : "entries"}
                </div>
                <div className="text-muted-foreground">
                  Parsed from headers like{" "}
                  <code>## YYYY-MM-DD H:MM AM/PM CDT · category</code>.
                </div>
              </div>
            }
          >
            <span className="text-xs text-muted-foreground tabular-nums cursor-help">
              {scratch.entries.length}{" "}
              {scratch.entries.length === 1 ? "entry" : "entries"}
            </span>
          </Tooltip>
          <FileSizeMeter bytes={scratch.bytes} />
          {archiveCount > 0 && (
            <Tooltip
              content={
                <span>
                  {archiveCount} prior snapshot
                  {archiveCount === 1 ? "" : "s"} under{" "}
                  <code>.harnery/scratch/archived/</code>.
                </span>
              }
            >
              <button
                type="button"
                onClick={() => setTab("archives")}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <Archive className="size-3" />
                {archiveCount}
              </button>
            </Tooltip>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <TabBar
          tab={tab}
          setTab={setTab}
          hasContent={scratch.exists}
          readOnly={readOnly}
        />
        {tab === "timeline" && (
          <TimelineView
            entries={scratch.entries}
            exists={scratch.exists}
            readOnly={readOnly}
            onMutated={() => router.refresh()}
          />
        )}
        {tab === "compose" && !readOnly && (
          <ComposeView
            instanceId={instanceId}
            onSaved={() => {
              setTab("timeline");
              router.refresh();
            }}
          />
        )}
        {tab === "raw" && (
          <RawView
            instanceId={instanceId}
            agentName={agentName}
            initialBody={rawBody}
            readOnly={readOnly}
            onSaved={() => {
              setTab("timeline");
              router.refresh();
            }}
          />
        )}
        {tab === "archives" && <ArchivesView instanceId={instanceId} />}
      </CardContent>
    </Card>
  );
}

// ─── Tab bar ──────────────────────────────────────────────────────────────

function TabBar({
  tab,
  setTab,
  hasContent,
  readOnly,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  hasContent: boolean;
  readOnly: boolean;
}) {
  const tabs: {
    id: Tab;
    label: string;
    icon: React.ReactNode;
    tip: string;
  }[] = [
    {
      id: "timeline",
      label: "Timeline",
      icon: <Clock className="size-3.5" />,
      tip: "Browse parsed entries newest-first. Each card carries a category badge with its own hover tip.",
    },
    // Compose is a write surface, so omit it for ended agents (read-only).
    ...(readOnly
      ? []
      : [
          {
            id: "compose" as const,
            label: "Add entry",
            icon: <ListPlus className="size-3.5" />,
            tip: "Append one well-formed entry. Safer than Raw edit: produces a properly-formatted header the parser can read.",
          },
        ]),
    {
      id: "raw",
      label: "Raw",
      icon: <FileText className="size-3.5" />,
      tip: readOnly
        ? "View the markdown file as-is (read-only; the agent's session has ended)."
        : "View the markdown file as-is. Advanced: wholesale replace (audit-archived). Most operators want Add entry instead.",
    },
    {
      id: "archives",
      label: "Archives",
      icon: <Archive className="size-3.5" />,
      tip: "Every prior snapshot of this scratchpad, auto-archived on session end + every Raw replace.",
    },
  ];
  return (
    <div
      role="tablist"
      className="flex items-center gap-1 border-b border-border/40 pb-2 flex-wrap"
    >
      {tabs.map((t) => {
        const active = t.id === tab;
        const disabled = !hasContent && (t.id === "timeline" || t.id === "raw");
        return (
          <Tooltip key={t.id} side="bottom" content={t.tip}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => !disabled && setTab(t.id)}
              disabled={disabled}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                disabled && "opacity-40 cursor-not-allowed",
              )}
            >
              {t.icon}
              {t.label}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ─── Timeline view ────────────────────────────────────────────────────────

function TimelineView({
  entries,
  exists,
  readOnly,
  onMutated,
}: {
  entries: EntryRow[];
  exists: boolean;
  readOnly: boolean;
  onMutated: () => void;
}) {
  const { binName } = useHostInfo();
  const [filter, setFilter] = useState<ScratchCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<"desc" | "asc">("desc");

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const e of entries) {
      out[e.category] = (out[e.category] ?? 0) + 1;
    }
    return out;
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = entries.filter((e) => {
      if (filter !== "all" && e.category !== filter) return false;
      if (q && !e.body.toLowerCase().includes(q)) return false;
      return true;
    });
    if (order === "asc") rows = [...rows].reverse();
    return rows;
  }, [entries, filter, query, order]);

  if (!exists) {
    return (
      <EmptyState
        icon={<FileText className="size-6 text-muted-foreground" />}
        title="No scratchpad on disk"
        body={
          readOnly ? (
            <>
              This agent&apos;s session ended without a live scratchpad on disk.
              Anything it journaled would be under the <strong>Archives</strong>{" "}
              tab.
            </>
          ) : (
            <>
              Active agents create one on their first{" "}
              <code className="text-xs">{`${binName} scratch add`}</code>. Use the{" "}
              <strong>Add entry</strong> tab to seed one as the operator.
            </>
          )
        }
      />
    );
  }
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<Clock className="size-6 text-muted-foreground" />}
        title="No entries parsed"
        body="The file exists but contains no entries matching the expected header format. Switch to the Raw tab to inspect."
      />
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative grow min-w-56">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search entry bodies…"
            className="w-full text-xs pl-7 pr-2 py-1.5 rounded-md border border-border/60 bg-muted/10 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
        <Tooltip
          side="bottom"
          content={
            order === "desc"
              ? "Newest first. Click to flip to oldest first."
              : "Oldest first. Click to flip back to newest first."
          }
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOrder((o) => (o === "desc" ? "asc" : "desc"))}
            className="cursor-pointer"
          >
            {order === "desc" ? (
              <ArrowDownAZ />
            ) : (
              <ArrowUpAZ />
            )}
            {order === "desc" ? "Newest" : "Oldest"}
          </Button>
        </Tooltip>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <Tooltip side="bottom" content="Show every category.">
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors cursor-pointer",
              filter === "all"
                ? "border-foreground/30 bg-muted text-foreground"
                : "border-border/40 text-muted-foreground hover:bg-muted/60",
            )}
          >
            All
            <span className="text-muted-foreground tabular-nums">
              {entries.length}
            </span>
          </button>
        </Tooltip>
        {CATEGORY_META.map((m) => {
          const n = counts[m.value] ?? 0;
          if (n === 0) return null;
          const active = filter === m.value;
          return (
            <Tooltip
              key={m.value}
              side="bottom"
              content={
                <div className="max-w-[16rem] space-y-0.5">
                  <div className="font-semibold">{m.label}</div>
                  <div className="text-muted-foreground">{m.short}</div>
                </div>
              }
            >
              <button
                type="button"
                onClick={() => setFilter(active ? "all" : m.value)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-all cursor-pointer",
                  active
                    ? "border-foreground/30 bg-muted text-foreground"
                    : "border-border/40 text-muted-foreground hover:bg-muted/60 opacity-80",
                )}
              >
                {m.label}
                <span className="tabular-nums">{n}</span>
              </button>
            </Tooltip>
          );
        })}
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground italic px-1 py-3">
          No entries match the current filter.
        </p>
      ) : (
        <ul className="space-y-2 max-h-112 overflow-y-auto pr-1">
          {filtered.map((e) => {
            const trueIndex = entries.indexOf(e);
            return (
              <EntryCard
                key={`idx-${trueIndex}`}
                entry={e}
                index={trueIndex}
                readOnly={readOnly}
                onMutated={onMutated}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Compose view ─────────────────────────────────────────────────────────

function ComposeView({
  instanceId,
  onSaved,
}: {
  instanceId: string;
  onSaved: () => void;
}) {
  const [category, setCategory] = useState<ScratchCategory>("note");
  const [body, setBody] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();
  const trimmed = body.trim();
  const tooLarge = new TextEncoder().encode(body).length > 32 * 1024;

  function handleSubmit() {
    if (!trimmed || pending || tooLarge) return;
    setFeedback(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(instanceId)}/scratchpad`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ category, body }),
          },
        );
        const data = (await res.json()) as
          | { ok: true; entries?: number; bytes?: number }
          | { error: string };
        if (!res.ok || !("ok" in data)) {
          setFeedback({
            ok: false,
            msg:
              "error" in data
                ? data.error
                : `append failed (HTTP ${res.status})`,
          });
          return;
        }
        setBody("");
        setFeedback({
          ok: true,
          msg: `Entry appended (${data.entries ?? "?"} total · ${data.bytes ?? 0} bytes).`,
        });
        onSaved();
      } catch (err) {
        setFeedback({
          ok: false,
          msg: `Append failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  const meta = categoryMeta(category);

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border/40 bg-muted/10 p-3 space-y-2.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">1. Category</span>
          <Tooltip
            side="top"
            content="Picks the badge color + signals to peers + future-you what kind of note this is. Hover any chip for a per-category explanation."
          >
            <HelpCircle className="size-3.5 cursor-help" />
          </Tooltip>
        </div>
        <CategoryPicker
          value={category}
          onChange={setCategory}
          disabled={pending}
        />
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {meta.long}
        </p>
      </div>
      <div className="rounded-md border border-border/40 bg-muted/10 p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">2. Body</span>
          <Tooltip
            side="top"
            content="Free-form markdown. One entry can be one line or several paragraphs. The whole thing is appended atomically, with no nesting and no overwrites of prior entries."
          >
            <HelpCircle className="size-3.5 cursor-help" />
          </Tooltip>
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          spellCheck={false}
          rows={6}
          disabled={pending}
          className="w-full text-sm font-sans p-2 rounded-md border border-border/40 bg-background focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
          placeholder={`Write a ${category} entry…`}
        />
        <div className="flex items-center justify-between gap-3 flex-wrap text-[11px] text-muted-foreground">
          <span>
            {body.length} chars
            {tooLarge && (
              <span className="text-destructive ml-2">
                (over 32KB per-entry cap)
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            {body.length > 0 && (
              <Tooltip side="top" content="Clear the textarea.">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setBody("")}
                  disabled={pending}
                  className="cursor-pointer"
                >
                  <RotateCcw />
                  Clear
                </Button>
              </Tooltip>
            )}
            <Tooltip
              side="top"
              content={
                trimmed
                  ? "Appends a properly-formatted entry to the bottom of the scratchpad file."
                  : "Type something first."
              }
            >
              <Button
                variant="default"
                size="sm"
                onClick={handleSubmit}
                disabled={!trimmed || pending || tooLarge}
                className="cursor-pointer"
              >
                <Send />
                {pending ? "Saving…" : "Append entry"}
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>
      {feedback && (
        <p
          className={cn(
            "text-xs",
            feedback.ok ? "text-emerald-500" : "text-destructive",
          )}
        >
          {feedback.msg}
        </p>
      )}
    </div>
  );
}

// ─── Raw view ─────────────────────────────────────────────────────────────

function RawView({
  instanceId,
  agentName,
  initialBody,
  readOnly,
  onSaved,
}: {
  instanceId: string;
  agentName: string;
  initialBody: string | null;
  readOnly: boolean;
  onSaved: () => void;
}) {
  const body = initialBody ?? "";
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  if (!body) {
    return (
      <EmptyState
        icon={<FileText className="size-6 text-muted-foreground" />}
        title="No file on disk"
        body={
          readOnly ? (
            <>
              No live scratchpad for this ended session. Check the{" "}
              <strong>Archives</strong> tab for snapshots taken on session end.
            </>
          ) : (
            <>
              Switch to <strong>Add entry</strong> to seed one; appending an
              entry creates the file.
            </>
          )
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Tooltip side="bottom" content="Copy the raw markdown to your clipboard.">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className="cursor-pointer"
          >
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </Tooltip>
        {!readOnly && (
          <Tooltip
            side="bottom"
            content={
              editing
                ? "Hide the wholesale-replace editor. Most operators want Add entry instead."
                : "Show the wholesale-replace editor. Replaces the whole file (audit-archived first). Use Add entry for one-off entries."
            }
          >
            <Button
              variant={editing ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setEditing((v) => !v)}
              className="cursor-pointer"
            >
              {editing ? <ChevronDown /> : <ChevronRight />}
              <span className="inline-flex items-center gap-1">
                <AlertTriangle className="size-3.5" />
                Advanced: replace whole file
              </span>
            </Button>
          </Tooltip>
        )}
      </div>
      <pre className="text-xs whitespace-pre-wrap font-mono max-h-112 overflow-y-auto leading-relaxed border border-border/40 rounded-md p-3 bg-muted/10 m-0">
        {body}
      </pre>
      {editing && !readOnly && (
        <ReplaceEditor
          instanceId={instanceId}
          agentName={agentName}
          initialBody={body}
          onSaved={() => {
            setEditing(false);
            onSaved();
          }}
        />
      )}
    </div>
  );
}

function ReplaceEditor({
  instanceId,
  agentName,
  initialBody,
  onSaved,
}: {
  instanceId: string;
  agentName: string;
  initialBody: string;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(initialBody);
  const [showDiff, setShowDiff] = useState(false);
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  const byteLen = useMemo(
    () => new TextEncoder().encode(draft).length,
    [draft],
  );
  const overCap = byteLen > BODY_BYTE_CAP;
  const dirty = draft !== initialBody;

  function handleSave() {
    if (!dirty || overCap) return;
    setFeedback(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(instanceId)}/scratchpad`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              body: draft,
              summary: `Replaced via web UI for ${agentName}`,
            }),
          },
        );
        const data = (await res.json()) as
          | { ok: true }
          | { error: string };
        if (!res.ok || !("ok" in data)) {
          setFeedback({
            ok: false,
            msg:
              "error" in data ? data.error : `replace failed (HTTP ${res.status})`,
          });
          return;
        }
        setFeedback({
          ok: true,
          msg: "Replaced. Prior content archived under .harnery/scratch/archived/.",
        });
        onSaved();
      } catch (err) {
        setFeedback({
          ok: false,
          msg: `Replace failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
      <div className="flex items-start gap-2 text-xs">
        <AlertTriangle className="size-4 text-amber-500 shrink-0 mt-0.5" />
        <div className="text-muted-foreground leading-relaxed">
          <strong className="text-foreground">Wholesale replace.</strong>{" "}
          Overwrites the whole scratchpad. The prior file is archived to{" "}
          <code className="text-foreground">
            .harnery/scratch/archived/{instanceId.slice(0, 8)}…-pre-ui-&lt;ts&gt;.md
          </code>{" "}
          and the helper appends a synthetic <code>note</code> entry so peers
          still see an append-only journal. Prefer <strong>Add entry</strong>{" "}
          for single notes.
        </div>
      </div>
      {showDiff ? (
        <SnapshotDiff
          left={{
            label: "Before (on disk)",
            body: initialBody,
            bytes: new TextEncoder().encode(initialBody).length,
          }}
          right={{
            label: "After (draft)",
            body: draft,
            bytes: byteLen,
          }}
          maxHeightClass="max-h-96"
          emptyMessage="No textual differences yet; the draft matches the file on disk."
        />
      ) : (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          rows={12}
          className="w-full text-xs font-mono p-2 rounded-md border border-border/40 bg-background focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
        />
      )}
      <div className="flex items-center justify-between gap-3 flex-wrap text-[11px] text-muted-foreground">
        <span>
          {byteLen.toLocaleString()} / {BODY_BYTE_CAP.toLocaleString()} bytes
          {overCap && (
            <span className="text-destructive ml-2">(over cap)</span>
          )}
        </span>
        <div className="flex items-center gap-2">
          <Tooltip side="top" content="Side-by-side before vs after.">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDiff((v) => !v)}
              className="cursor-pointer"
            >
              {showDiff ? <EyeOff /> : <Eye />}
              {showDiff ? "Edit" : "Diff"}
            </Button>
          </Tooltip>
          <Tooltip
            side="top"
            content="Revert to the file on disk."
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDraft(initialBody)}
              disabled={!dirty || pending}
              className="cursor-pointer"
            >
              <X />
              Revert
            </Button>
          </Tooltip>
          <Tooltip
            side="top"
            content={
              !dirty
                ? "No changes."
                : overCap
                  ? "Over the 64KB cap."
                  : "Archive current file + write new body. Cannot be undone except by hand."
            }
          >
            <Button
              variant="default"
              size="sm"
              onClick={handleSave}
              disabled={!dirty || pending || overCap}
              className="cursor-pointer"
            >
              {pending ? <Edit3 className="animate-pulse" /> : <Save />}
              {pending ? "Saving…" : "Replace"}
            </Button>
          </Tooltip>
        </div>
      </div>
      {feedback && (
        <p
          className={cn(
            "text-xs",
            feedback.ok ? "text-emerald-500" : "text-destructive",
          )}
        >
          {feedback.msg}
        </p>
      )}
    </div>
  );
}

// ─── Archives view ────────────────────────────────────────────────────────

function ArchivesView({ instanceId }: { instanceId: string }) {
  const [archives, setArchives] = useState<ArchiveRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(instanceId)}/scratchpad/archives`,
        );
        const data = (await res.json()) as
          | { archives: ArchiveRow[] }
          | { error: string };
        if (cancelled) return;
        if ("archives" in data) setArchives(data.archives);
        else setError(data.error);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [instanceId]);

  async function loadArchive(filename: string) {
    if (selected === filename) {
      setSelected(null);
      setContent(null);
      return;
    }
    setSelected(filename);
    setContent(null);
    setLoadingContent(true);
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(instanceId)}/scratchpad/archives?filename=${encodeURIComponent(filename)}`,
      );
      const data = (await res.json()) as
        | { filename: string; body: string }
        | { error: string };
      if ("body" in data) setContent(data.body);
      else setContent(`(error: ${data.error})`);
    } catch (err) {
      setContent(`(error: ${err instanceof Error ? err.message : String(err)})`);
    } finally {
      setLoadingContent(false);
    }
  }

  if (error) {
    return <p className="text-sm text-destructive">Failed to load: {error}</p>;
  }
  if (!archives) {
    return (
      <p className="text-sm text-muted-foreground italic">Loading…</p>
    );
  }
  if (archives.length === 0) {
    return (
      <EmptyState
        icon={<Archive className="size-6 text-muted-foreground" />}
        title="No archives"
        body="Snapshots land here every time the session ends or the Raw editor's Replace button is used."
      />
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        Pre-UI-edit snapshots have a{" "}
        <Badge variant="warning" className="text-[9px]!">
          pre-ui
        </Badge>{" "}
        tag. Others are session-end auto-archives.
      </p>
      <ul className="space-y-1 max-h-112 overflow-y-auto pr-1">
        {archives.map((a) => {
          const isOpen = selected === a.filename;
          return (
            <li
              key={a.filename}
              className="rounded-md border border-border/50 bg-card/30"
            >
              <button
                type="button"
                onClick={() => loadArchive(a.filename)}
                className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/40 transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-2 min-w-0">
                  {isOpen ? (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="text-xs truncate">
                    {a.archived_at ? (
                      <FormattedDateTime
                        iso={a.archived_at}
                        withWeekday
                        withYear
                        withSeconds
                        className="tabular-nums"
                      />
                    ) : (
                      <span className="font-mono">{a.filename}</span>
                    )}
                  </span>
                  {a.is_pre_ui_edit && (
                    <Badge variant="warning" className="text-[9px]!">
                      pre-ui
                    </Badge>
                  )}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                  {formatKB(a.bytes)}
                </span>
              </button>
              {isOpen && (
                <div className="px-3 pb-3">
                  {loadingContent ? (
                    <p className="text-xs text-muted-foreground italic">
                      Loading…
                    </p>
                  ) : (
                    <pre className="text-xs whitespace-pre-wrap font-mono max-h-96 overflow-y-auto leading-relaxed border border-border/40 rounded-md p-2 bg-muted/10 m-0">
                      {content ?? "(empty)"}
                    </pre>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Shared ────────────────────────────────────────────────────────────────

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 px-4 rounded-md border border-dashed border-border/60 bg-muted/10">
      <div>{icon}</div>
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="text-xs text-muted-foreground text-center max-w-md leading-relaxed">
        {body}
      </div>
    </div>
  );
}

function formatKB(n: number): string {
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
}
