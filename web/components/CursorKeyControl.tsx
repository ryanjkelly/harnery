"use client";

import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Manage the machine-local Cursor API key from the Cursor card, across all
 * three states:
 *   - not configured → a clear "Add Cursor API key" call-to-action
 *   - configured + valid → a compact row showing the key name + Replace / Remove
 *   - configured + broken → a warning row + Replace / Remove
 *
 * Add and Replace share one paste field (POST /api/devtools/cursor-key); Remove
 * calls DELETE. Each mutation refreshes the page so the card re-reads state.
 *
 * Not wired to the Attention alert system on purpose: key management is an
 * optional, user-initiated action, not a blocking wait the page is stuck on.
 */
export function CursorKeyControl({
  configured,
  valid,
  keyName,
}: {
  configured: boolean;
  valid: boolean;
  keyName: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function save() {
    setError(null);
    const res = await fetch("/api/devtools/cursor-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key.trim() }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not store the key.");
      return;
    }
    setKey("");
    setEditing(false);
    startTransition(() => router.refresh());
  }

  async function remove() {
    setError(null);
    const res = await fetch("/api/devtools/cursor-key", { method: "DELETE" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not remove the key.");
      return;
    }
    startTransition(() => router.refresh());
  }

  if (editing) {
    return (
      <div className="mt-4 space-y-2 rounded-md border border-border p-3">
        <p className="text-xs text-muted-foreground">
          Paste a Cursor API key from{" "}
          <a
            href="https://cursor.com/dashboard/api"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary hover:underline"
          >
            cursor.com → API Keys
          </a>
          . Stored locally on this machine only.
        </p>
        {/** biome-ignore lint/a11y/noAutofocus: focusing the single field is the point of opening the form */}
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="crsr_…"
          autoComplete="off"
          autoFocus
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
          onKeyDown={(e) => {
            if (e.key === "Enter" && key.trim()) save();
          }}
        />
        {error ? <p className="text-xs text-negative">{error}</p> : null}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!key.trim() || pending}
            onClick={save}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save key"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setKey("");
              setError(null);
            }}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Not configured → prominent add CTA.
  if (!configured) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="mt-4 flex w-full items-center gap-2.5 rounded-md border border-dashed border-border px-3 py-2.5 text-left transition-colors hover:border-ring hover:bg-accent/40"
      >
        <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="leading-tight">
          <span className="block text-sm font-medium text-foreground">Add Cursor API key</span>
          <span className="block text-xs text-muted-foreground">
            Verify your key and show Cloud Agent activity
          </span>
        </span>
      </button>
    );
  }

  // Configured → manage row (Replace / Remove), with a warning tint when broken.
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          <KeyRound
            className={`size-3.5 shrink-0 ${valid ? "text-muted-foreground" : "text-negative"}`}
            aria-hidden
          />
          {valid ? (
            <span className="truncate text-muted-foreground">
              API key{keyName ? <span className="text-foreground"> {keyName}</span> : ""}
            </span>
          ) : (
            <span className="font-medium text-negative">API key not working</span>
          )}
        </span>
        <span className="flex shrink-0 gap-3">
          <button
            type="button"
            onClick={() => {
              setKey("");
              setError(null);
              setEditing(true);
            }}
            className="font-medium text-primary hover:underline"
          >
            Replace
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={remove}
            className="text-muted-foreground hover:text-negative disabled:opacity-50"
          >
            Remove
          </button>
        </span>
      </div>
      {error ? <p className="mt-1 text-xs text-negative">{error}</p> : null}
    </div>
  );
}
