"use client";

/**
 * HTML / XML renderer: Shiki-highlighted SOURCE by default, plus a
 * Preview toggle that loads the complete document through the sandboxed render
 * tree. Source is the default in the overlay (preview opt-in); `/files/view`
 * may seed Preview via `initialMode`. The iframe sandbox has NO
 * allow-same-origin, so the previewed document gets a unique opaque origin and
 * can never touch the dashboard. Source limits do not truncate the preview;
 * relative styles and images resolve beside the document in the render tree.
 */

import { Code2, Eye } from "lucide-react";
import { useEffect, useState } from "react";
import { sandboxedRenderUrl } from "@/lib/file-viewer/client";
import type { FileText } from "@/lib/file-viewer/types";
import { TruncationBanner } from "../ViewerStates";
import CodeRenderer from "./CodeRenderer";
import { useWrapPref, WrapToggle } from "./WrapToggle";

export default function HtmlRenderer({
  file,
  initialMode = "source",
}: {
  file: FileText;
  initialMode?: "source" | "preview";
}) {
  const isXml = file.relPath.toLowerCase().endsWith(".xml");
  const seed: "source" | "preview" = isXml ? "source" : initialMode;
  const [mode, setMode] = useState<"source" | "preview">(seed);
  const [wrap, toggleWrap] = useWrapPref();

  // Path / deep-link mode changes (standalone replaceState, sequence nav).
  useEffect(() => {
    setMode(file.relPath.toLowerCase().endsWith(".xml") ? "source" : initialMode);
  }, [file.relPath, initialMode]);

  const setModeAndUrl = (next: "source" | "preview") => {
    setMode(next);
    // Keep /files/view shareable when the user toggles Source | Preview.
    if (typeof window === "undefined") return;
    if (!window.location.pathname.startsWith("/files/view")) return;
    const u = new URL(window.location.href);
    u.searchParams.set("mode", next);
    window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
        <ModeButton
          active={mode === "source"}
          onClick={() => setModeAndUrl("source")}
          icon={<Code2 className="size-3.5" />}
        >
          Source
        </ModeButton>
        {!isXml && (
          <ModeButton
            active={mode === "preview"}
            onClick={() => setModeAndUrl("preview")}
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
        {mode === "source" && (
          <div className="ml-auto">
            <WrapToggle wrap={wrap} onToggle={toggleWrap} />
          </div>
        )}
      </div>
      {mode === "source" && file.truncated && <TruncationBanner lines={file.lines} />}
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "preview" && !isXml ? (
          <HtmlPreview path={file.relPath} />
        ) : (
          <CodeRenderer file={file} wrap={wrap} />
        )}
      </div>
    </div>
  );
}

function HtmlPreview({ path }: { path: string }) {
  return (
    <iframe
      src={sandboxedRenderUrl(path)}
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
