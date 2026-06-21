"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { AgentChip } from "@/components/AgentChip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SnapshotDiff } from "@/components/diff/SnapshotDiff";
import type { CouncilRoundView } from "@/lib/coord-reader";

const SNAPSHOT_MIN_BYTES = 5_000;

interface SnapshotEntry {
  round: number;
  author: string;
  body: string;
  bytes: number;
}

/**
 * Paginated snapshot-vs-snapshot diff of the council's target plan-doc.
 * Walks every >5 KB contribution across all prior rounds (in manifest round-
 * robin order, Maya → Ophelia → Phoebe → Quark within each round) and lets
 * the operator step through adjacent pairs.
 *
 * Rendering delegates to <SnapshotDiff>, the same shared component the
 * scratchpad replace-editor uses, so council + scratchpad diffs are visually
 * identical (line numbers, inline word-level highlights, collapsed unchanged
 * runs, per-side Copy buttons, removed/added stats with rich tooltips).
 */
export function RoundDiff({ rounds }: { rounds: CouncilRoundView[] }) {
  const snapshots = useMemo<SnapshotEntry[]>(() => {
    const out: SnapshotEntry[] = [];
    for (const r of rounds) {
      for (const c of r.contributors) {
        if (c.bytes < SNAPSHOT_MIN_BYTES) continue;
        out.push({
          round: r.round,
          author: c.author,
          body: c.body,
          bytes: c.bytes,
        });
      }
    }
    return out;
  }, [rounds]);

  const initialRightIdx = Math.max(1, snapshots.length - 1);
  const [rightIdx, setRightIdx] = useState(initialRightIdx);

  if (snapshots.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No plan-doc snapshots in prior rounds yet. Each contribution must
        upload a doc body (&gt;5 KB) to anchor a diff.
      </p>
    );
  }

  if (snapshots.length === 1) {
    const only = snapshots[0]!;
    return (
      <p className="text-sm text-muted-foreground italic">
        Only one snapshotted contribution so far (round {only.round} ·{" "}
        <AgentChip name={only.author} className="font-mono" />). A round-over-
        round diff needs at least two.
      </p>
    );
  }

  const right = snapshots[rightIdx]!;
  const left = snapshots[rightIdx - 1]!;
  const canGoPrev = rightIdx > 1;
  const canGoNext = rightIdx < snapshots.length - 1;

  const leftLabel = `r${left.round} · ${left.author}`;
  const rightLabel = `r${right.round} · ${right.author}`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-muted-foreground">
            r{left.round}·
            <AgentChip name={left.author} prefix="" className="font-mono" />
          </span>
          <span className="text-muted-foreground/60">→</span>
          <span className="font-mono font-semibold">
            r{right.round}·
            <AgentChip name={right.author} prefix="" className="font-mono font-semibold" />
          </span>
          <Badge
            variant="outline"
            title={`Comparing round ${left.round} · ${left.author} (${left.bytes.toLocaleString()} B) vs round ${right.round} · ${right.author} (${right.bytes.toLocaleString()} B). Pager walks every snapshotted contribution across prior rounds, in manifest round-robin order.`}
          >
            {rightIdx} of {snapshots.length - 1}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRightIdx((i) => Math.max(1, i - 1))}
            disabled={!canGoPrev}
            tooltip={
              canGoPrev
                ? `Compare r${snapshots[rightIdx - 2]!.round}·${snapshots[rightIdx - 2]!.author.replace(/^agent-/, "")} → r${left.round}·${left.author.replace(/^agent-/, "")}.`
                : "Already at the earliest adjacent pair."
            }
          >
            <ChevronLeft className="size-3" />
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setRightIdx((i) => Math.min(snapshots.length - 1, i + 1))
            }
            disabled={!canGoNext}
            tooltip={
              canGoNext
                ? `Compare r${right.round}·${right.author.replace(/^agent-/, "")} → r${snapshots[rightIdx + 1]!.round}·${snapshots[rightIdx + 1]!.author.replace(/^agent-/, "")}.`
                : "Already at the latest adjacent pair."
            }
          >
            Next
            <ChevronRight className="size-3" />
          </Button>
        </div>
      </div>

      <SnapshotDiff
        left={{ label: leftLabel, body: left.body, bytes: left.bytes }}
        right={{ label: rightLabel, body: right.body, bytes: right.bytes }}
        emptyMessage={
          <>
            No textual differences between these two snapshots. The
            contributor who landed round {right.round} signed off with no
            edits.
          </>
        }
      />
    </div>
  );
}
