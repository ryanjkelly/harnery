"use client";

import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * "Add Cursor API key" control for the Cursor card. Collapsed, it's a clearly
 * labeled call-to-action that says what the key unlocks; expanded, it's a single
 * paste field with a direct link to where the key lives. On save it stores the
 * key via the cursor-key API route and refreshes so the card shows the
 * enrichment. Rendered only when no key is configured yet.
 *
 * Deliberately NOT wired to the Attention alert system: adding the key is an
 * optional enhancement, not a blocking wait, so a per-visit title-flash / chime
 * would be noise. It's a quiet-but-obvious inline affordance instead.
 */
export function CursorKeyConnect() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
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
    setOpen(false);
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
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
            setOpen(false);
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
