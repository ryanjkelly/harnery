import { ChevronRight } from "lucide-react";
import { sourceLabel } from "@/components/permissions/levels";
import { cn } from "@/lib/cn";

interface Rule {
  rule: string;
  source: string;
}

/**
 * A long list of permission rules, collapsed behind a count and grouped by the
 * settings file each rule came from. `inactive` dims it when the tool's mode
 * skips the rules anyway.
 */
export function RuleList({
  title,
  rules,
  inactive = false,
}: {
  title: string;
  rules: Rule[];
  inactive?: boolean;
}) {
  if (rules.length === 0) return null;
  const groups = new Map<string, string[]>();
  for (const r of rules) {
    const list = groups.get(r.source) ?? [];
    list.push(r.rule);
    groups.set(r.source, list);
  }
  return (
    <details className={cn("group/rules", inactive && "opacity-70")}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/rules:rotate-90" />
        <span>{title}</span>
        <span className="tabular-nums">{`(${rules.length})`}</span>
      </summary>
      <div className="mt-2 space-y-2 pl-5">
        {[...groups.entries()].map(([source, list]) => (
          <div key={source}>
            <div className="mb-1 text-xs text-muted-foreground">
              {`From ${sourceLabel(source)} (${list.length})`}
            </div>
            <ul className="flex flex-wrap gap-1">
              {list.map((rule) => (
                <li
                  key={rule}
                  className="max-w-full break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                >
                  {rule}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}
