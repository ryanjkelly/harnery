"use client";

import { Check, Edit3, Send, Trash2, X } from "lucide-react";
import { useState, useTransition } from "react";

import { FormattedDateTime } from "@/components/FormattedDateTime";
import { linkifyPaths } from "@/components/file-viewer/linkify";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { ScratchCategory } from "@/lib/coord-writer";

import { CategoryPicker } from "./CategoryPicker";
import { categoryMeta } from "./categories";

export interface EntryRow {
  ts_chicago: string;
  ts_iso: string | null;
  category: string;
  body: string;
}

/**
 * One scratchpad entry, rendered as a card with category badge + canonical
 * datetime + body. Edit / delete actions live on hover; clicking edit swaps
 * the body for an inline editor with category picker. Delete asks for an
 * inline confirm before firing the DELETE.
 */
export function EntryCard({
  entry,
  index,
  readOnly = false,
  onMutated,
}: {
  entry: EntryRow;
  index: number;
  /** Ended agents: hide the inline edit / delete actions (read-only journal). */
  readOnly?: boolean;
  onMutated: () => void;
}) {
  const meta = categoryMeta(entry.category);
  const [mode, setMode] = useState<"read" | "edit" | "confirm-delete">("read");

  return (
    <li
      className={cn(
        "group rounded-md border px-3 py-2.5 transition-colors",
        mode === "edit"
          ? "border-foreground/30 bg-card"
          : mode === "confirm-delete"
            ? "border-destructive/50 bg-destructive/5"
            : "border-border/60 bg-card/40 hover:border-border",
      )}
    >
      <div className="flex items-baseline gap-2 flex-wrap mb-1.5">
        <Badge
          variant={meta.variant}
          title={
            <div className="max-w-[16rem] space-y-1">
              <div className="font-semibold">{meta.label}</div>
              <div className="text-muted-foreground">{meta.short}</div>
            </div>
          }
        >
          {meta.label}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {entry.ts_iso ? (
            <FormattedDateTime iso={entry.ts_iso} withWeekday withYear className="tabular-nums" />
          ) : (
            <span className="font-mono">{entry.ts_chicago}</span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {mode === "read" && !readOnly && (
            <>
              <Tooltip side="top" content="Edit this entry's body or category.">
                <button
                  type="button"
                  onClick={() => setMode("edit")}
                  aria-label="Edit entry"
                  className="inline-flex items-center justify-center size-6 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
                >
                  <Edit3 className="size-3.5" />
                </button>
              </Tooltip>
              <Tooltip
                side="top"
                content="Delete this entry. The full file is archived first so you can recover it."
              >
                <button
                  type="button"
                  onClick={() => setMode("confirm-delete")}
                  aria-label="Delete entry"
                  className="inline-flex items-center justify-center size-6 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors cursor-pointer"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </Tooltip>
            </>
          )}
        </div>
      </div>
      {mode === "read" && (
        <pre className="scratch text-sm leading-relaxed whitespace-pre-wrap wrap-break-word font-sans m-0">
          {entry.body ? (
            // Linkify path-shaped tokens: handoff/ping bodies
            // and notes routinely cite repo paths. Conservative; resolveFile
            // arbitrates, so a false positive degrades to Unresolvable.
            linkifyPaths(entry.body)
          ) : (
            <span className="text-muted-foreground italic">(empty body)</span>
          )}
        </pre>
      )}
      {mode === "edit" && (
        <InlineEditor
          entry={entry}
          index={index}
          onCancel={() => setMode("read")}
          onSaved={() => {
            setMode("read");
            onMutated();
          }}
        />
      )}
      {mode === "confirm-delete" && (
        <ConfirmDelete
          entry={entry}
          index={index}
          onCancel={() => setMode("read")}
          onDeleted={() => {
            setMode("read");
            onMutated();
          }}
        />
      )}
    </li>
  );
}

// ─── Inline editor ────────────────────────────────────────────────────────

function InlineEditor({
  entry,
  index,
  onCancel,
  onSaved,
}: {
  entry: EntryRow;
  index: number;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [category, setCategory] = useState<ScratchCategory>(entry.category as ScratchCategory);
  const [body, setBody] = useState(entry.body);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const ownerId = useOwnerIdFromPath();
  const dirty = body !== entry.body || category !== entry.category;
  const tooLarge = new TextEncoder().encode(body).length > 32 * 1024;

  function handleSave() {
    if (!ownerId || !dirty || pending || tooLarge || !body.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(ownerId)}/scratchpad/entries/${index}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              category,
              body,
              expected_ts_display: entry.ts_chicago,
            }),
          },
        );
        const data = (await res.json()) as { ok: true } | { error: string };
        if (!res.ok || !("ok" in data)) {
          setError("error" in data ? data.error : `edit failed (HTTP ${res.status})`);
          return;
        }
        onSaved();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="space-y-2 mt-2">
      <CategoryPicker value={category} onChange={setCategory} disabled={pending} />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        spellCheck={false}
        disabled={pending}
        rows={Math.min(12, Math.max(3, body.split("\n").length))}
        className="w-full text-sm font-sans p-2 rounded-md border border-border/40 bg-background focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
      />
      <div className="flex items-center justify-between gap-2 flex-wrap text-[11px] text-muted-foreground">
        <span>
          {body.length} chars
          {tooLarge && <span className="text-destructive ml-2">(over 32KB cap)</span>}
        </span>
        <div className="flex items-center gap-1.5">
          <Tooltip side="top" content="Discard changes.">
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={pending}
              className="cursor-pointer"
            >
              <X />
              Cancel
            </Button>
          </Tooltip>
          <Tooltip
            side="top"
            content={
              !body.trim()
                ? "Body cannot be empty."
                : !dirty
                  ? "No changes."
                  : "Archive current file + write the edited entry. The original entry's timestamp is preserved."
            }
          >
            <Button
              variant="default"
              size="sm"
              onClick={handleSave}
              disabled={!dirty || pending || tooLarge || !body.trim()}
              className="cursor-pointer"
            >
              {pending ? <Send className="animate-pulse" /> : <Check />}
              {pending ? "Saving…" : "Save"}
            </Button>
          </Tooltip>
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ─── Inline delete confirm ────────────────────────────────────────────────

function ConfirmDelete({
  entry,
  index,
  onCancel,
  onDeleted,
}: {
  entry: EntryRow;
  index: number;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const ownerId = useOwnerIdFromPath();

  function handleDelete() {
    if (!ownerId || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(ownerId)}/scratchpad/entries/${index}?expected_ts_display=${encodeURIComponent(entry.ts_chicago)}`,
          { method: "DELETE" },
        );
        const data = (await res.json()) as { ok: true } | { error: string };
        if (!res.ok || !("ok" in data)) {
          setError("error" in data ? data.error : `delete failed (HTTP ${res.status})`);
          return;
        }
        onDeleted();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="space-y-2 mt-2 text-sm">
      <p className="text-muted-foreground leading-relaxed">
        Delete this entry? The full scratchpad is archived to{" "}
        <code className="text-foreground">.harnery/scratch/archived/</code> first, so you can
        recover it from the <strong>Archives</strong> tab.
      </p>
      <div className="flex items-center gap-1.5">
        <Tooltip side="top" content="Keep the entry.">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={pending}
            className="cursor-pointer"
          >
            <X />
            Cancel
          </Button>
        </Tooltip>
        <Tooltip
          side="top"
          content="Archive current file + remove this entry. Recoverable from Archives."
        >
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={pending}
            className="cursor-pointer"
          >
            <Trash2 />
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </Tooltip>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * Pull the agent owner_id out of the URL. The detail page is
 * `/agents/<id>`, so we grab the second path segment. Falls back to null;
 * the caller refuses to fire mutations without one.
 */
function useOwnerIdFromPath(): string | null {
  if (typeof window === "undefined") return null;
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts[0] !== "agents" || !parts[1]) return null;
  return decodeURIComponent(parts[1]);
}
