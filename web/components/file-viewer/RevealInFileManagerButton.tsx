"use client";

import { Check, FolderOpen, LoaderCircle, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { revealInFileManager } from "@/lib/file-viewer/client";

type State = "idle" | "opening" | "opened" | "error";

export function RevealInFileManagerButton({ path }: { path: string }) {
  const [state, setState] = useState<State>("idle");
  const [detail, setDetail] = useState<string | null>(null);

  const label =
    state === "opening"
      ? "Opening containing folder…"
      : state === "opened"
        ? "Folder open requested"
        : state === "error"
          ? `Could not open the containing folder${detail ? `: ${detail}` : ""}`
          : "Show in Explorer, Finder, or the system file manager";

  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        disabled={state === "opening"}
        onClick={async () => {
          setState("opening");
          setDetail(null);
          const result = await revealInFileManager(path);
          if (!result.ok) {
            setDetail(result.detail ?? result.code);
            setState("error");
            return;
          }
          setState("opened");
          setTimeout(() => setState("idle"), 1500);
        }}
        className="inline-flex items-center justify-center rounded border border-border p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
      >
        {state === "opening" ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : state === "opened" ? (
          <Check className="size-4 text-emerald-400" />
        ) : state === "error" ? (
          <TriangleAlert className="size-4 text-amber-500" />
        ) : (
          <FolderOpen className="size-4" />
        )}
      </button>
    </Tooltip>
  );
}
