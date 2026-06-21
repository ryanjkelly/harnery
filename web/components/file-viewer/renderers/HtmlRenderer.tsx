"use client";

/**
 * HTML / XML renderer: Shiki-highlighted SOURCE by default, plus a
 * Preview toggle that renders the HTML in a `sandbox`ed `<iframe>` from a blob
 * URL. Source is the default (source is default, preview opt-in). The
 * iframe sandbox has NO allow-same-origin, so the previewed document gets a
 * unique opaque origin and can never touch the dashboard. The blob: URL is
 * created from the file text only when the user opts into Preview.
 */

import type { FileText } from "@/lib/file-viewer/types";
import { Code2, Eye } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import CodeRenderer from "./CodeRenderer";

export default function HtmlRenderer({ file }: { file: FileText }) {
  const [mode, setMode] = useState<"source" | "preview">("source");
  const isXml = file.relPath.toLowerCase().endsWith(".xml");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
        <ModeButton
          active={mode === "source"}
          onClick={() => setMode("source")}
          icon={<Code2 className="size-3.5" />}
        >
          Source
        </ModeButton>
        {!isXml && (
          <ModeButton
            active={mode === "preview"}
            onClick={() => setMode("preview")}
            icon={<Eye className="size-3.5" />}
          >
            Preview
          </ModeButton>
        )}
        {mode === "preview" && (
          <span className="ml-2 text-[10px] text-muted-foreground/70">
            sandboxed · scripts disabled · isolated origin
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "preview" && !isXml ? (
          <HtmlPreview content={file.content} />
        ) : (
          <CodeRenderer file={file} />
        )}
      </div>
    </div>
  );
}

function HtmlPreview({ content }: { content: string }) {
  const blobUrl = useMemo(() => {
    const blob = new Blob([content], { type: "text/html" });
    return URL.createObjectURL(blob);
  }, [content]);
  useEffect(() => () => URL.revokeObjectURL(blobUrl), [blobUrl]);
  return (
    <iframe
      src={blobUrl}
      title="HTML preview"
      // No allow-scripts, no allow-same-origin: the preview is inert + isolated.
      sandbox=""
      className="h-full min-h-0 w-full flex-1 border-0 bg-white"
    />
  );
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
