"use client";

/**
 * CSV / TSV renderer: papaparse feeds a @tanstack/react-virtual list so a
 * 50k-row file renders only the visible window. Header auto-detected (row 0 is
 * the header unless it's mostly numeric). The /text body is already line+byte
 * capped server-side, so this never sees an unbounded file; a parse error with
 * zero usable rows falls back to the raw text renderer.
 *
 * Layout is div-based (NOT <table>): a virtualized list can't keep a real
 * <thead> aligned with absolutely-positioned <tr>s, so header + rows share one
 * flex grid (a fixed `#` gutter + equal flex-1 cells) and stay aligned.
 */

import type { FileText } from "@/lib/file-viewer/types";
import { useVirtualizer } from "@tanstack/react-virtual";
import Papa from "papaparse";
import { useMemo, useRef } from "react";
import TextRenderer from "./TextRenderer";

const ROW_HEIGHT = 28;
const GUTTER = "5ch";

function looksNumeric(cells: string[]): boolean {
  const nums = cells.filter((c) => c.trim() !== "" && !Number.isNaN(Number(c)));
  return cells.length > 0 && nums.length / cells.length > 0.6;
}

export default function CsvRenderer({ file }: { file: FileText }) {
  const parsed = useMemo(() => {
    const delimiter = file.relPath.toLowerCase().endsWith(".tsv") ? "\t" : "";
    return Papa.parse<string[]>(file.content, { delimiter, skipEmptyLines: true });
  }, [file.content, file.relPath]);

  const rows = parsed.data as string[][];

  const { header, body } = useMemo(() => {
    if (rows.length === 0) return { header: [] as string[], body: [] as string[][] };
    if (looksNumeric(rows[0]!)) {
      const cols = rows[0]!.length;
      return { header: Array.from({ length: cols }, (_, i) => `col ${i + 1}`), body: rows };
    }
    return { header: rows[0]!, body: rows.slice(1) };
  }, [rows]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: body.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Zero usable rows → not really tabular; show raw text.
  if (rows.length === 0) return <TextRenderer file={file} />;

  const colCount = Math.max(header.length, ...body.slice(0, 50).map((r) => r.length), 1);
  const cols = Array.from({ length: colCount });

  return (
    <div className="flex min-h-0 flex-1 flex-col font-mono text-[11px]">
      <div className="shrink-0 border-b border-border bg-muted/20 px-3 py-1 text-muted-foreground">
        {body.length.toLocaleString()} rows · {colCount} cols
      </div>
      {/* header row, same grid as body rows */}
      <div className="flex shrink-0 border-b border-border bg-muted/40">
        <Cell width={GUTTER} className="text-right text-muted-foreground/60">
          #
        </Cell>
        {cols.map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: column index IS the identity
          <Cell key={i} className="font-semibold text-foreground">
            {header[i] ?? `col ${i + 1}`}
          </Cell>
        ))}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = body[vi.index]!;
            return (
              <div
                key={vi.key}
                className="absolute flex w-full border-b border-border/40"
                style={{ transform: `translateY(${vi.start}px)`, height: `${ROW_HEIGHT}px` }}
              >
                <Cell width={GUTTER} className="text-right tabular-nums text-muted-foreground/50">
                  {vi.index + 1}
                </Cell>
                {cols.map((_, ci) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: (row,col) index is the identity
                  <Cell key={ci} className="text-foreground/90" title={row[ci] ?? ""}>
                    {row[ci] ?? ""}
                  </Cell>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Cell({
  children,
  className,
  width,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  width?: string;
  title?: string;
}) {
  return (
    <div
      title={title}
      className={`truncate border-r border-border/50 px-2 py-1 ${width ? "shrink-0" : "flex-1 min-w-0"} ${className ?? ""}`}
      style={width ? { width } : undefined}
    >
      {children}
    </div>
  );
}
