"use client";

/**
 * Syntax-highlighted code via Shiki (lazy grammar per language). Highlights
 * async with a plain-text-while-loading state, and falls back to TextRenderer
 * when no grammar exists for the extension or highlighting throws.
 *
 * `dangerouslySetInnerHTML` here is safe: the HTML is Shiki's own tokenized,
 * HTML-escaped output (`codeToHtml`), NOT raw file content. The ban is on
 * injecting untrusted FILE bytes, which this never does.
 */

import { useEffect, useState } from "react";
import type { FileText } from "@/lib/file-viewer/types";
import { highlightToHtml, langForExt } from "./shiki";
import TextRenderer from "./TextRenderer";
import { useWrapPref, WrapToggle, wrapClass } from "./WrapToggle";

function extOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export default function CodeRenderer({
  file,
  wrap: wrapProp,
}: {
  file: FileText;
  /** Controlled soft-wrap. When omitted, this renderer owns the preference and
   * shows its own Wrap button (HtmlRenderer hosts one in its Source|Preview bar
   * instead, so it passes the value down and no second toolbar appears). */
  wrap?: boolean;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [ownWrap, toggleOwnWrap] = useWrapPref();
  const controlled = wrapProp !== undefined;
  const wrap = controlled ? wrapProp : ownWrap;

  useEffect(() => {
    let live = true;
    const lang = langForExt(extOf(file.relPath));
    if (!lang) {
      setFailed(true);
      return;
    }
    highlightToHtml(file.content, lang)
      .then((out) => {
        if (!live) return;
        if (out) setHtml(out);
        else setFailed(true);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [file.relPath, file.content]);

  // Keep the toolbar around the fallback too: loading or a missing grammar
  // must not remove the user's Wrap control.
  const body =
    failed || html === null ? (
      <TextRenderer file={file} wrap={wrap} />
    ) : (
      <div
        className={`shiki-host min-h-0 flex-1 overflow-auto p-3 text-[12px] leading-relaxed [&_pre]:m-0 [&_pre]:bg-transparent! ${wrapClass(wrap)}`}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki-tokenized escaped HTML, not raw file bytes
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  if (controlled) return body;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* sticky: for plain code files the scroll container is the parent pane,
          so a static bar would scroll out of reach on a long file. */}
      <div className="sticky top-0 z-10 flex shrink-0 items-center justify-end border-b border-border bg-card px-3 py-1.5">
        <WrapToggle wrap={wrap} onToggle={toggleOwnWrap} />
      </div>
      {body}
    </div>
  );
}
