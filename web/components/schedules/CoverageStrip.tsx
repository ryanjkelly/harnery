import { Check } from "lucide-react";

import { FormattedDateTime } from "@/components/FormattedDateTime";
import { Notice } from "@/components/layout/Notice";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import {
  COVERAGE_TONES,
  coverageGaps,
  coverageLabel,
  type ScheduleSourceCoverage,
  SOURCE_META,
} from "@/lib/schedules";
import { TONE } from "@/lib/tone";

import { SourceIcon } from "./icons";

/** Every source on one line: a quiet check when read in full, a toned pill when not. */
export function CoverageStrip({
  coverage,
  asOf,
}: {
  coverage: ScheduleSourceCoverage[];
  asOf: string;
}) {
  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3 text-xs">
      <span className="text-muted-foreground">Sources</span>
      {coverage.map((c) => {
        const name = SOURCE_META[c.source].coverageLabel;
        const tip = (
          <span className="block max-w-xs space-y-0.5">
            <span className="block">
              {c.detail ??
                (c.state === "current" ? "Read in full." : `${name}: ${coverageLabel(c)}.`)}
            </span>
            <span className="block text-muted-foreground">
              {`Account ${c.account} · read `}
              <FormattedDateTime iso={c.read_at} kind="timestamp" />
            </span>
          </span>
        );
        return (
          <Tooltip key={`${c.source}:${c.account}`} content={tip}>
            <span className="inline-flex cursor-help items-center gap-1.5">
              <SourceIcon source={c.source} className="size-3.5" />
              <span>{name}</span>
              {c.state === "current" ? (
                <Check aria-label="read in full" className={cn("size-3.5", TONE.done.text)} />
              ) : (
                <Badge tone={COVERAGE_TONES[c.state]}>{coverageLabel(c)}</Badge>
              )}
            </span>
          </Tooltip>
        );
      })}
      <span className="ml-auto text-muted-foreground">
        {"as of "}
        <FormattedDateTime iso={asOf} />
      </span>
    </footer>
  );
}

/** A notice above the cards only when a source may be hiding schedules. */
export function CoverageNotice({ coverage }: { coverage: ScheduleSourceCoverage[] }) {
  const gaps = coverageGaps(coverage);
  if (gaps.length === 0) return null;
  const tone = gaps.some((c) => c.state === "unreadable") ? "danger" : "warn";
  return (
    <Notice tone={tone} title="Some schedules may be missing">
      <ul className="mt-1 space-y-0.5">
        {gaps.map((c) => (
          <li key={`${c.source}:${c.account}`}>
            <span className="font-medium">{SOURCE_META[c.source].coverageLabel}</span>
            {` ${coverageLabel(c)}.`}
            {c.detail ? <span className="text-muted-foreground">{` ${c.detail}`}</span> : null}
          </li>
        ))}
      </ul>
    </Notice>
  );
}
