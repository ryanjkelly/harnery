"use client";

/**
 * Archive renderer: fetches the server-side entry listing from
 * /api/file/archive (names + sizes, no extraction) and shows it as a sorted
 * list. No in-browser unzip (fflate runs server-side only, so the client bundle
 * never sees archive code).
 */

import type { FileMeta } from "@/lib/file-viewer/types";
import { FileArchive, Folder } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LoadingState, TransportErrorState } from "../ViewerStates";

interface ArchiveEntry {
  name: string;
  size: number;
  isDir: boolean;
}
interface ArchiveResponse {
  relPath: string;
  size: number;
  kind: "zip" | "tar" | "gzip";
  entries: ArchiveEntry[];
  truncated: boolean;
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ArchiveRenderer({ meta, path }: { meta: FileMeta; path: string }) {
  const [res, setRes] = useState<
    { ok: true; data: ArchiveResponse } | { ok: false; msg: string } | null
  >(null);
  const load = useCallback(() => {
    setRes(null);
    fetch(`/api/file/archive?path=${encodeURIComponent(path)}`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (r.ok && body) setRes({ ok: true, data: body as ArchiveResponse });
        else setRes({ ok: false, msg: body?.detail ?? body?.error ?? `HTTP ${r.status}` });
      })
      .catch((e) => setRes({ ok: false, msg: (e as Error).message }));
  }, [path]);
  useEffect(() => {
    load();
  }, [load]);

  if (res === null) return <LoadingState path={meta.relPath} />;
  if (!res.ok) return <TransportErrorState onRetry={load} />;

  const { kind, entries, truncated } = res.data;
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
        <FileArchive className="size-3.5" />
        <span className="uppercase tracking-wide">{kind}</span>
        <span>·</span>
        <span>{entries.length.toLocaleString()} entries</span>
        {truncated && <span className="text-amber-500/80">· listing truncated</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1 font-mono text-[11px]">
        {sorted.map((e, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: archive entry order is stable per fetch
            key={i}
            className="flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/40"
          >
            {e.isDir ? (
              <Folder className="size-3.5 shrink-0 text-sky-500/70" />
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            <span
              className={`min-w-0 flex-1 truncate ${e.isDir ? "text-sky-600 dark:text-sky-400" : "text-foreground/90"}`}
            >
              {e.name}
            </span>
            {!e.isDir && (
              <span className="shrink-0 tabular-nums text-muted-foreground/60">
                {fmtSize(e.size)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
