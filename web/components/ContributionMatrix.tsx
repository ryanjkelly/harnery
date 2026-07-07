import type {
  ContributionMatrix,
  ChangelogEntry,
  ContributionType,
} from "@/lib/changelog-parser";

import { AgentChip } from "@/components/AgentChip";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";
import {
  FinancialTable,
  FinancialTableRow,
} from "@/components/data-viz/financial-table";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { NO_DATA } from "@/lib/format/no-data";
import { RelativeTimeAgo } from "@/components/RelativeTimeAgo";
import { isoFromChangelogTs } from "@/lib/format/datetime";

/**
 * Rounds × members contribution-type matrix. Each row = one round, each
 * column = one council member, each cell = zero or more S/T/? chips for the
 * changelog entries by that member in that round. Trailing tally column
 * rolls up S/T counts for the round; "all-T" rounds count toward the exit
 * criterion.
 *
 * Rendered through `<FinancialTable>` so the row chrome (zebra stripe + hover
 * transition) matches the upstream app's other dense-table surfaces.
 */
export function ContributionMatrixCard({
  matrix,
  currentRound,
}: {
  matrix: ContributionMatrix;
  currentRound: number;
}) {
  if (matrix.rounds.length === 0 || matrix.mapping.length === 0) return null;

  const memberOrder = matrix.mapping.map((m) => m.member);

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 flex-wrap">
          <span>Round history</span>
          <Badge
            variant="outline"
            title="Parsed from the target doc's Plan changelog section. One row per round; one chip per changelog entry by that member in that round."
          >
            {matrix.rounds.length} round
            {matrix.rounds.length === 1 ? "" : "s"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <FinancialTable className="text-xs">
            <thead>
              <tr className="text-xs text-muted-foreground border-b border-border/60">
                <th className="text-left font-medium pb-1.5 pr-3 w-[6ch]">
                  Round
                </th>
                {matrix.mapping.map((m) => (
                  <th
                    key={m.member}
                    className="text-left font-medium pb-1.5 px-2"
                  >
                    <div>
                      <AgentChip
                        name={m.member}
                        className="font-mono text-foreground"
                      />
                    </div>
                    <div className="text-[10px] font-normal text-muted-foreground/80">
                      {m.model}
                    </div>
                  </th>
                ))}
                <th className="text-left font-medium pb-1.5 pl-2 w-[10ch]">
                  <Tooltip content="Per-round S/T tally. All-T rounds count toward the exit criterion.">
                    <span className="cursor-help">Tally</span>
                  </Tooltip>
                </th>
              </tr>
            </thead>
            <tbody>
              {matrix.rounds.map((row) => {
                const cellByMember = new Map(
                  row.cells.map((c) => [c.member, c]),
                );
                const tally = tallyRow(row.cells.flatMap((c) => c.entries));
                const isCurrent = row.round === currentRound;
                return (
                  <FinancialTableRow
                    key={row.round}
                    className={
                      isCurrent
                        ? "bg-primary/7! hover:bg-primary/12!"
                        : undefined
                    }
                  >
                    <td className="py-1.5 pr-3 font-mono tabular-nums text-foreground/80">
                      {row.round}
                      {isCurrent && (
                        <span className="ml-1 text-[9px] uppercase tracking-wide text-primary/80">
                          now
                        </span>
                      )}
                    </td>
                    {memberOrder.map((member) => {
                      const cell = cellByMember.get(member);
                      const entries = cell?.entries ?? [];
                      return (
                        <td key={member} className="py-1.5 px-2 align-top">
                          {entries.length === 0 ? (
                            <Tooltip
                              content={`No contribution from ${member} in round ${row.round}.`}
                            >
                              <span className="text-muted-foreground/50 tabular-nums cursor-help">
                                {NO_DATA}
                              </span>
                            </Tooltip>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1">
                              {entries.map((e, i) => (
                                <TypeChip key={i} entry={e} />
                              ))}
                            </div>
                          )}
                        </td>
                      );
                    })}
                    <td className="py-1.5 pl-2 align-top text-[11px] tabular-nums">
                      <TallyChip
                        substantive={tally.substantive}
                        trivial={tally.trivial}
                        unknown={tally.unknown}
                      />
                    </td>
                  </FinancialTableRow>
                );
              })}
            </tbody>
          </FinancialTable>
        </div>
        <Legend />
        {matrix.unmapped.length > 0 && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {/* Single template literal: entity-whitespace trap, see
                harnery/AGENTS.md § Web app. */}
            {`${matrix.unmapped.length} changelog ${matrix.unmapped.length === 1 ? "entry" : "entries"} couldn't be matched to a member (model not in the configured members table).`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function TypeChip({ entry }: { entry: ChangelogEntry }) {
  const { letter, cls } = chipStyle(entry.type);
  return (
    <Tooltip
      content={
        <div className="space-y-1.5 max-w-md">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
            <span className="font-semibold text-foreground">{entry.type}</span>
            <span>·</span>
            <span>round {entry.round}</span>
            <span>·</span>
            <FormattedDateTime
              iso={isoFromChangelogTs(entry.ts)}
              className="font-mono"
            />
            <RelativeTimeAgo
              iso={isoFromChangelogTs(entry.ts)}
              className="before:content-['·_'] before:mr-1"
            />
          </div>
          <p className="text-xs leading-relaxed">{entry.summary}</p>
        </div>
      }
    >
      <span
        className={`inline-flex items-center justify-center size-5 rounded font-mono text-[10px] font-semibold cursor-help ${cls}`}
      >
        {letter}
      </span>
    </Tooltip>
  );
}

function chipStyle(type: ContributionType): { letter: string; cls: string } {
  switch (type) {
    case "Substantive":
      return {
        letter: "S",
        cls: "bg-amber-500/15 text-amber-300 border border-amber-500/40",
      };
    case "Trivial":
      return {
        letter: "T",
        cls: "bg-muted text-muted-foreground border border-border",
      };
    case "Unknown":
      return {
        letter: "?",
        cls: "border border-dashed border-border text-muted-foreground/70",
      };
  }
}

function tallyRow(entries: ChangelogEntry[]): {
  substantive: number;
  trivial: number;
  unknown: number;
} {
  let substantive = 0;
  let trivial = 0;
  let unknown = 0;
  for (const e of entries) {
    if (e.type === "Substantive") substantive++;
    else if (e.type === "Trivial") trivial++;
    else unknown++;
  }
  return { substantive, trivial, unknown };
}

function TallyChip({
  substantive,
  trivial,
  unknown,
}: {
  substantive: number;
  trivial: number;
  unknown: number;
}) {
  if (substantive === 0 && trivial === 0 && unknown === 0) {
    return <span className="text-muted-foreground/50">{NO_DATA}</span>;
  }
  const parts: string[] = [];
  if (substantive > 0) parts.push(`${substantive}S`);
  if (trivial > 0) parts.push(`${trivial}T`);
  if (unknown > 0) parts.push(`${unknown}?`);
  const cls =
    substantive === 0 && unknown === 0
      ? "text-muted-foreground"
      : substantive > 0
        ? "text-amber-300"
        : "text-muted-foreground";
  const tip =
    substantive > 0
      ? `${substantive} substantive entr${substantive === 1 ? "y" : "ies"} this round; not yet all-Trivial.`
      : trivial > 0
        ? `All ${trivial} entries this round were Trivial.`
        : null;
  if (!tip) {
    return <span className={cls}>{parts.join(" · ")}</span>;
  }
  return (
    <Tooltip content={tip}>
      <span className={`${cls} cursor-help`}>{parts.join(" · ")}</span>
    </Tooltip>
  );
}

function Legend() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="inline-flex items-center justify-center size-5 rounded font-mono text-[10px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/40">
          S
        </span>
        Substantive (scope / schema / architecture)
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-flex items-center justify-center size-5 rounded font-mono text-[10px] font-semibold bg-muted text-muted-foreground border border-border">
          T
        </span>
        Trivial (wording / formatting only)
      </span>
      <span>{NO_DATA} no contribution this round</span>
    </div>
  );
}
