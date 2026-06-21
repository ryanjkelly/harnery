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

import type { FileText } from "@/lib/file-viewer/types";
import { useEffect, useState } from "react";
import TextRenderer from "./TextRenderer";
import { highlightToHtml, langForExt } from "./shiki";

function extOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export default function CodeRenderer({ file }: { file: FileText }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

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

  if (failed) return <TextRenderer file={file} />;
  if (html === null) {
    // Highlighting in flight, so show plain text immediately to avoid a flash
    // of empty (the grammar import can take a beat on first use).
    return <TextRenderer file={file} />;
  }
  return (
    <div
      className="shiki-host overflow-auto p-3 text-[12px] leading-relaxed [&_pre]:m-0 [&_pre]:bg-transparent! [&_pre]:whitespace-pre"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki-tokenized escaped HTML, not raw file bytes
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
