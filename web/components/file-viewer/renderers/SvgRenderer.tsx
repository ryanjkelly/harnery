"use client";

/**
 * SVG renderer: `<img>` preview (default) + a source toggle. NEVER
 * inlines untrusted SVG into the app DOM (an inline <svg> can carry <script>/
 * onload); the <img> tag renders SVG as an image with scripting disabled, and
 * the source view is Shiki-highlighted text. The raw route also serves SVG with
 * CSP `sandbox`, so even the <img> src can't execute.
 */

import { type FetchResult, fetchText, rawUrl } from "@/lib/file-viewer/client";
import type { FileMeta, FileText } from "@/lib/file-viewer/types";
import { Code2, Image as ImageIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LoadingState, TransportErrorState } from "../ViewerStates";
import CodeRenderer from "./CodeRenderer";

export default function SvgRenderer({ meta, path }: { meta: FileMeta; path: string }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
        <ModeButton
          active={mode === "preview"}
          onClick={() => setMode("preview")}
          icon={<ImageIcon className="size-3.5" />}
        >
          Preview
        </ModeButton>
        <ModeButton
          active={mode === "source"}
          onClick={() => setMode("source")}
          icon={<Code2 className="size-3.5" />}
        >
          Source
        </ModeButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "preview" ? (
          <div className="flex h-full items-center justify-center bg-muted/20 p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={rawUrl(path)}
              alt={meta.relPath.split("/").pop() ?? "svg"}
              className="max-h-[78vh] max-w-full object-contain"
            />
          </div>
        ) : (
          <SvgSource path={path} relPath={meta.relPath} />
        )}
      </div>
    </div>
  );
}

function SvgSource({ path, relPath }: { path: string; relPath: string }) {
  const [res, setRes] = useState<FetchResult<FileText> | null>(null);
  const load = useCallback(() => {
    setRes(null);
    fetchText(path).then(setRes);
  }, [path]);
  useEffect(() => {
    load();
  }, [load]);
  if (res === null) return <LoadingState path={relPath} />;
  if (!res.ok) return <TransportErrorState onRetry={load} />;
  return <CodeRenderer file={res.data} />;
}

function ModeButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition ${
        active
          ? "bg-muted/70 text-foreground"
          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
