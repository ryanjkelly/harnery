"use client";

/**
 * JSON / JSONL renderer: reuses the existing ColorizedJson tree-walker (which
 * also unwraps JSON-in-string payloads). On a parse failure, falls back to
 * Shiki-highlighted source so a malformed .json still shows something useful
 * rather than a render error. JSONL → one parsed value per non-empty line.
 */

import { ColorizedJson } from "@/components/log-table/ColorizedJson";
import type { FileText } from "@/lib/file-viewer/types";
import CodeRenderer from "./CodeRenderer";
import { useWrapPref, WrapToggle } from "./WrapToggle";

function isJsonl(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return lower.endsWith(".jsonl") || lower.endsWith(".ndjson");
}

export default function JsonRenderer({ file }: { file: FileText }) {
  const [wrap, toggleWrap] = useWrapPref();
  let body: React.ReactNode;

  if (isJsonl(file.relPath)) {
    const rows = file.content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    let anyParsed = false;
    const parsed = rows.map((line) => {
      try {
        anyParsed = true;
        return { ok: true as const, value: JSON.parse(line) as unknown };
      } catch {
        return { ok: false as const, value: line };
      }
    });
    if (!anyParsed) body = <CodeRenderer file={file} wrap={wrap} />;
    else
      body = (
        <div className="flex flex-col gap-2 p-3">
          {parsed.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: line index IS the identity
            <div key={i} className="rounded border border-border/50 bg-background/30 p-2">
              <span className="mb-1 block select-none text-[10px] tabular-nums text-muted-foreground/50">
                {i + 1}
              </span>
              {row.ok ? (
                <ColorizedJson value={row.value} wrap={wrap} />
              ) : (
                <code
                  className={`font-mono text-[11px] text-amber-600 dark:text-amber-400 ${
                    wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"
                  }`}
                >
                  {row.value}
                </code>
              )}
            </div>
          ))}
        </div>
      );
  } else {
    try {
      const value = JSON.parse(file.content) as unknown;
      body = (
        <div className="p-3">
          <ColorizedJson value={value} wrap={wrap} />
        </div>
      );
    } catch {
      // Malformed JSON → show highlighted source instead of a hard error.
      body = <CodeRenderer file={file} wrap={wrap} />;
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="sticky top-0 z-10 flex shrink-0 items-center justify-end border-b border-border bg-card px-3 py-1.5">
        <WrapToggle wrap={wrap} onToggle={toggleWrap} />
      </div>
      {body}
    </div>
  );
}
