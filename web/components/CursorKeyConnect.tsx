"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Minimal "connect usage" control for the Cursor card: paste a Cursor API key,
 * it's stored via the cursor-key API route, then the page refreshes so the card
 * shows the enrichment. Shown only when no key is configured yet.
 *
 * Deliberately NOT wired to the Attention alert system: connecting the key is an
 * optional enhancement, not a blocking wait, so a per-visit title-flash / chime
 * would be noise. It sits as a quiet inline affordance instead.
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
        className="mt-1 text-xs font-medium text-primary hover:underline"
      >
        Connect usage
      </button>
    );
  }

  return (
    <div className="mt-1 space-y-2">
      <p className="text-xs text-muted-foreground">
        Paste a Cursor API key (cursor.com → Settings → API Keys) to verify it and show Cloud Agent
        activity. Stored locally on this machine only.
      </p>
      <input
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="crsr_…"
        autoComplete="off"
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-ring"
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
          className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
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
