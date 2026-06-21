"use client";

/**
 * YAML renderer: parses with the `yaml` package (NOT js-yaml),
 * surfaces `doc.errors` inline, and shows the SOURCE Shiki-highlighted (yaml's
 * value is its structure + comments + anchors, which a re-serialized tree would
 * lose). A parse error renders as a banner above the still-readable source.
 */

import type { FileText } from "@/lib/file-viewer/types";
import { useMemo } from "react";
import { parseDocument } from "yaml";
import CodeRenderer from "./CodeRenderer";

export default function YamlRenderer({ file }: { file: FileText }) {
  const errors = useMemo(() => {
    try {
      // We only surface parse errors + show source; we never `doc.toJS()`, so
      // there's no alias expansion to bomb (the maxAliasCount cap applies
      // at toJS time, which this renderer deliberately avoids).
      const doc = parseDocument(file.content);
      return doc.errors.map((e) => e.message);
    } catch (e) {
      return [(e as Error).message];
    }
  }, [file.content]);

  return (
    <div className="flex flex-col">
      {errors.length > 0 && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
          <span className="font-semibold">
            YAML parse {errors.length === 1 ? "error" : "errors"}:
          </span>
          <ul className="mt-1 list-disc pl-4">
            {errors.map((m, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: error list is static per render
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      <CodeRenderer file={file} />
    </div>
  );
}
