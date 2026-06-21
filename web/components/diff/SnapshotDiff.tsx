"use client";

import { useMemo, useState } from "react";
import { diffLines, diffWordsWithSpace } from "diff";
import { Check, Copy as CopyIcon } from "lucide-react";

import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

/**
 * Generic side-by-side line+word diff. Extracted from RoundDiff so any
 * surface that needs "before vs after" rendering (council plan evolution,
 * scratchpad wholesale-replace preview, anything else) shares the same
 * look + behavior:
 *
 *   • Two-column table with line numbers + word-level inline highlights
 *   • Headers: red/green tinted, with label + optional byte count + Copy
 *   • Stats row: "N removed (−X%)" / "N added (+Y%)" with rich tooltips
 *   • Long unchanged runs collapse to "… N unchanged lines …" markers
 *
 * Pure presentational; the caller is responsible for any pager / navigation.
 */

export interface DiffSnapshot {
  /** Display label, e.g. "r3 · agent-Maya" or "Before". */
  label: string;
  /** Raw text body to diff. */
  body: string;
  /** Optional byte count rendered in the panel header. */
  bytes?: number;
}

export function SnapshotDiff({
  left,
  right,
  maxHeightClass = "max-h-150",
  contextLines = 3,
  emptyMessage,
}: {
  left: DiffSnapshot;
  right: DiffSnapshot;
  /** Tailwind max-h-* class for the scrollable diff body. */
  maxHeightClass?: string;
  /** Unchanged lines to keep on each side of a change. */
  contextLines?: number;
  /** Rendered in place of the diff when bodies are identical. */
  emptyMessage?: React.ReactNode;
}) {
  const { rows, stats } = useMemo(
    () => buildRows(left.body, right.body),
    [left.body, right.body],
  );
  const collapsed = useMemo(
    () => collapseContext(rows, contextLines),
    [rows, contextLines],
  );

  if (stats.linesAdded === 0 && stats.linesRemoved === 0) {
    return (
      <div className="rounded-md border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground italic">
        {emptyMessage ?? "No textual differences between these two snapshots."}
      </div>
    );
  }

  const pctRemoved =
    stats.linesTotalLeft > 0
      ? ((stats.linesRemoved / stats.linesTotalLeft) * 100).toFixed(1)
      : "0.0";
  const pctAdded =
    stats.linesTotalRight > 0
      ? ((stats.linesAdded / stats.linesTotalRight) * 100).toFixed(1)
      : "0.0";

  return (
    <div className="rounded-md border border-border overflow-hidden">
      <div className="grid grid-cols-2 text-[10px] font-mono border-b border-border">
        <div className="flex items-center justify-between gap-2 px-2 py-1 bg-rose-500/5 border-r border-border">
          <span className="text-rose-300 truncate">
            − {left.label}
            {typeof left.bytes === "number" && (
              <> ({left.bytes.toLocaleString()} B)</>
            )}
          </span>
          <CopyButton text={left.body} label={left.label} />
        </div>
        <div className="flex items-center justify-between gap-2 px-2 py-1 bg-emerald-500/5">
          <span className="text-emerald-300 truncate">
            + {right.label}
            {typeof right.bytes === "number" && (
              <> ({right.bytes.toLocaleString()} B)</>
            )}
          </span>
          <CopyButton text={right.body} label={right.label} />
        </div>
      </div>
      <div className="grid grid-cols-2 text-[10px] font-mono text-muted-foreground border-b border-border">
        <div className="px-2 py-0.5 bg-background border-r border-border">
          <Tooltip
            content={
              <div className="space-y-1 font-mono text-[11px] leading-relaxed">
                <div className="font-semibold text-foreground">Lines</div>
                <div>Total: {stats.linesTotalLeft.toLocaleString()}</div>
                <div className="text-rose-300">
                  Removed: {stats.linesRemoved.toLocaleString()} (−
                  {pctRemoved}%)
                </div>
                <div className="font-semibold text-foreground mt-1.5">
                  Characters
                </div>
                <div>Total: {stats.charsTotalLeft.toLocaleString()}</div>
                <div className="text-rose-300">
                  Removed: {stats.charsRemoved.toLocaleString()}
                </div>
              </div>
            }
          >
            <span className="cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">
              {stats.linesRemoved.toLocaleString()} removed (−{pctRemoved}%)
            </span>
          </Tooltip>
        </div>
        <div className="px-2 py-0.5 bg-background">
          <Tooltip
            content={
              <div className="space-y-1 font-mono text-[11px] leading-relaxed">
                <div className="font-semibold text-foreground">Lines</div>
                <div>Total: {stats.linesTotalRight.toLocaleString()}</div>
                <div className="text-emerald-300">
                  Added: {stats.linesAdded.toLocaleString()} (+{pctAdded}%)
                </div>
                <div className="font-semibold text-foreground mt-1.5">
                  Characters
                </div>
                <div>Total: {stats.charsTotalRight.toLocaleString()}</div>
                <div className="text-emerald-300">
                  Added: {stats.charsAdded.toLocaleString()}
                </div>
              </div>
            }
          >
            <span className="cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">
              {stats.linesAdded.toLocaleString()} added (+{pctAdded}%)
            </span>
          </Tooltip>
        </div>
      </div>
      <div className={cn("overflow-auto", maxHeightClass)}>
        <table className="w-full text-[11px] font-mono leading-relaxed border-collapse">
          <tbody>
            {collapsed.map((item, idx) =>
              item.kind === "collapsed" ? (
                <tr key={`c-${idx}`}>
                  <td
                    colSpan={4}
                    className="px-3 py-1 text-center text-[10px] text-muted-foreground/70 bg-background/60 border-t border-b border-border/40 italic"
                  >
                    … {item.count} unchanged line
                    {item.count === 1 ? "" : "s"} …
                  </td>
                </tr>
              ) : (
                <DiffRow key={`r-${idx}`} row={item.row} />
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface Row {
  leftNo: number | null;
  rightNo: number | null;
  leftText: string | null;
  rightText: string | null;
  kind: "context" | "added" | "removed" | "changed";
}

function buildRows(
  a: string,
  b: string,
): {
  rows: Row[];
  stats: {
    linesTotalLeft: number;
    linesTotalRight: number;
    linesRemoved: number;
    linesAdded: number;
    charsTotalLeft: number;
    charsTotalRight: number;
    charsRemoved: number;
    charsAdded: number;
  };
} {
  const chunks = diffLines(a, b, { newlineIsToken: false });
  const rows: Row[] = [];
  let leftNo = 0;
  let rightNo = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let charsAdded = 0;
  let charsRemoved = 0;

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const lines = c.value.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    if (c.added) {
      for (const line of lines) {
        rightNo++;
        rows.push({
          leftNo: null,
          rightNo,
          leftText: null,
          rightText: line,
          kind: "added",
        });
        linesAdded++;
        charsAdded += line.length;
      }
    } else if (c.removed) {
      const next = chunks[i + 1];
      if (next?.added) {
        const nextLines = next.value.split("\n");
        if (
          nextLines.length > 0 &&
          nextLines[nextLines.length - 1] === ""
        )
          nextLines.pop();
        const min = Math.min(lines.length, nextLines.length);
        for (let j = 0; j < min; j++) {
          leftNo++;
          rightNo++;
          rows.push({
            leftNo,
            rightNo,
            leftText: lines[j]!,
            rightText: nextLines[j]!,
            kind: "changed",
          });
          linesRemoved++;
          linesAdded++;
          charsRemoved += lines[j]!.length;
          charsAdded += nextLines[j]!.length;
        }
        for (let j = min; j < lines.length; j++) {
          leftNo++;
          rows.push({
            leftNo,
            rightNo: null,
            leftText: lines[j]!,
            rightText: null,
            kind: "removed",
          });
          linesRemoved++;
          charsRemoved += lines[j]!.length;
        }
        for (let j = min; j < nextLines.length; j++) {
          rightNo++;
          rows.push({
            leftNo: null,
            rightNo,
            leftText: null,
            rightText: nextLines[j]!,
            kind: "added",
          });
          linesAdded++;
          charsAdded += nextLines[j]!.length;
        }
        i++;
      } else {
        for (const line of lines) {
          leftNo++;
          rows.push({
            leftNo,
            rightNo: null,
            leftText: line,
            rightText: null,
            kind: "removed",
          });
          linesRemoved++;
          charsRemoved += line.length;
        }
      }
    } else {
      for (const line of lines) {
        leftNo++;
        rightNo++;
        rows.push({
          leftNo,
          rightNo,
          leftText: line,
          rightText: line,
          kind: "context",
        });
      }
    }
  }
  return {
    rows,
    stats: {
      linesTotalLeft: leftNo,
      linesTotalRight: rightNo,
      linesRemoved,
      linesAdded,
      charsTotalLeft: a.length,
      charsTotalRight: b.length,
      charsRemoved,
      charsAdded,
    },
  };
}

function DiffRow({ row }: { row: Row }) {
  let leftContent: React.ReactNode;
  let rightContent: React.ReactNode;
  if (row.kind === "changed" && row.leftText !== null && row.rightText !== null) {
    const parts = diffWordsWithSpace(row.leftText, row.rightText);
    leftContent = parts.map((p, i) =>
      p.removed ? (
        <span key={i} className="bg-rose-500/30 rounded-sm">
          {p.value}
        </span>
      ) : p.added ? null : (
        <span key={i}>{p.value}</span>
      ),
    );
    rightContent = parts.map((p, i) =>
      p.added ? (
        <span key={i} className="bg-emerald-500/30 rounded-sm">
          {p.value}
        </span>
      ) : p.removed ? null : (
        <span key={i}>{p.value}</span>
      ),
    );
  } else {
    leftContent = row.leftText ?? "";
    rightContent = row.rightText ?? "";
  }

  const leftBg =
    row.kind === "removed" || row.kind === "changed" ? "bg-rose-500/8" : "";
  const rightBg =
    row.kind === "added" || row.kind === "changed" ? "bg-emerald-500/8" : "";

  return (
    <tr className="align-top">
      <td className="select-none w-10 text-right pr-1.5 text-[10px] text-muted-foreground/60 tabular-nums">
        {row.leftNo ?? ""}
      </td>
      <td
        className={cn(
          "whitespace-pre-wrap wrap-break-word pl-1 pr-2 border-r border-border/40",
          leftBg,
        )}
      >
        {leftContent}
      </td>
      <td className="select-none w-10 text-right pr-1.5 text-[10px] text-muted-foreground/60 tabular-nums">
        {row.rightNo ?? ""}
      </td>
      <td
        className={cn(
          "whitespace-pre-wrap wrap-break-word pl-1 pr-2",
          rightBg,
        )}
      >
        {rightContent}
      </td>
    </tr>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* silent */
    }
  };
  return (
    <Tooltip content={`Copy the full body (${label}) to clipboard.`}>
      <button
        type="button"
        onClick={onCopy}
        className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground cursor-pointer"
        aria-label={`Copy ${label} body`}
      >
        {copied ? (
          <Check className="size-3 text-emerald-400" />
        ) : (
          <CopyIcon className="size-3" />
        )}
        <span className="text-[10px]">{copied ? "Copied" : "Copy"}</span>
      </button>
    </Tooltip>
  );
}

type CollapsedItem =
  | { kind: "row"; row: Row }
  | { kind: "collapsed"; count: number };

function collapseContext(rows: Row[], context: number): CollapsedItem[] {
  const out: CollapsedItem[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    if (r.kind !== "context") {
      out.push({ kind: "row", row: r });
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.kind === "context") j++;
    const runLen = j - i;
    const isStart = i === 0;
    const isEnd = j === rows.length;
    if (runLen > context * 2 + 1) {
      const headKeep = isStart ? 0 : context;
      const tailKeep = isEnd ? 0 : context;
      for (let k = i; k < i + headKeep; k++) {
        out.push({ kind: "row", row: rows[k]! });
      }
      const collapsedCount = runLen - headKeep - tailKeep;
      if (collapsedCount > 0) {
        out.push({ kind: "collapsed", count: collapsedCount });
      }
      for (let k = j - tailKeep; k < j; k++) {
        out.push({ kind: "row", row: rows[k]! });
      }
    } else {
      for (let k = i; k < j; k++) {
        out.push({ kind: "row", row: rows[k]! });
      }
    }
    i = j;
  }
  return out;
}
