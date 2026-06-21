"use client";

/**
 * One Shiki-highlighted code block, async with a plain-`<pre>` fallback. Shared
 * by the markdown renderer's fenced blocks. (CodeRenderer is the whole-file
 * variant with a line-number fallback; this one is the inline-fence variant.)
 */

import { useEffect, useState } from "react";
import { highlightToHtml, langForExt } from "./shiki";

export default function ShikiBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const resolved = langForExt(lang) ?? lang;
    highlightToHtml(code, resolved)
      .then((out) => {
        if (live && out) setHtml(out);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code, lang]);

  if (html === null) {
    return (
      <pre className="overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed whitespace-pre">
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <div
      className="shiki-host overflow-auto rounded-md border border-border text-[12px] leading-relaxed [&_pre]:m-0 [&_pre]:p-3 [&_pre]:whitespace-pre"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki-tokenized escaped HTML, not raw bytes
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
