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

function isJsonl(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return lower.endsWith(".jsonl") || lower.endsWith(".ndjson");
}

export default function JsonRenderer({ file }: { file: FileText }) {
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
    if (!anyParsed) return <CodeRenderer file={file} />;
    return (
      <div className="flex flex-col gap-2 p-3">
        {parsed.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: line index IS the identity
          <div key={i} className="rounded border border-border/50 bg-background/30 p-2">
            <span className="mb-1 block select-none text-[10px] tabular-nums text-muted-foreground/50">
              {i + 1}
            </span>
            {row.ok ? (
              <ColorizedJson value={row.value} />
            ) : (
              <code className="font-mono text-[11px] text-amber-600 dark:text-amber-400 break-all">
                {row.value}
              </code>
            )}
          </div>
        ))}
      </div>
    );
  }

  try {
    const value = JSON.parse(file.content) as unknown;
    return (
      <div className="p-3">
        <ColorizedJson value={value} />
      </div>
    );
  } catch {
    // Malformed JSON → show highlighted source instead of a hard error.
    return <CodeRenderer file={file} />;
  }
}
