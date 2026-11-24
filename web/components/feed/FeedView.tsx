"use client";

import { ArrowDownWideNarrow, ArrowUpNarrowWide, Search } from "lucide-react";
import Link from "next/link";
import { Fragment, useDeferredValue, useMemo, useState } from "react";

import { useFormatDateTime } from "@/components/FormattedDateTime";
import { CATEGORY_META } from "@/components/journal/categories";
import { EmptyState } from "@/components/layout/EmptyState";
import { cn } from "@/lib/cn";
import { type FeedItem, feedItemAgents, feedItemMachines } from "@/lib/feed-items";
import { TONE } from "@/lib/tone";

import { FeedRow } from "./FeedRow";

type KindFilter = "all" | "message" | "journal";

const WINDOW_LABELS: Array<{ value: string; label: string }> = [
  { value: "24h", label: "24 hours" },
  { value: "3d", label: "3 days" },
  { value: "7d", label: "7 days" },
];

const fieldCls =
  "h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground placeholder:text-subtle-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <fieldset
      aria-label={label}
      className="m-0 inline-flex min-w-0 rounded-md border border-border p-0"
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            i > 0 && "border-l border-border",
            value === o.value
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * Client leaf for /feed: filters, ordering, and the flat row list. The server
 * hands over every item in the window; filtering happens here so typing stays
 * instant and the global live refresh only swaps the props.
 */
export function FeedView({
  items,
  localMachine,
  windowKey,
}: {
  items: FeedItem[];
  localMachine: string;
  windowKey: string;
}) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [categories, setCategories] = useState<Set<string>>(() => new Set());
  const [machine, setMachine] = useState("all");
  const [agentInput, setAgentInput] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [oldestFirst, setOldestFirst] = useState(false);
  const agentQuery = useDeferredValue(
    agentInput
      .trim()
      .toLowerCase()
      .replace(/^agent-/, ""),
  );
  const query = useDeferredValue(queryInput.trim().toLowerCase());
  const fmt = useFormatDateTime();

  const machines = useMemo(() => {
    const set = new Set<string>([localMachine]);
    for (const item of items) for (const m of feedItemMachines(item)) set.add(m);
    return [...set].sort((a, b) =>
      a === localMachine ? -1 : b === localMachine ? 1 : a.localeCompare(b),
    );
  }, [items, localMachine]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (item.kind === "journal") counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const counts = useMemo(() => {
    let messages = 0;
    for (const item of items) if (item.kind === "message") messages++;
    return { messages, journal: items.length - messages };
  }, [items]);

  const visible = useMemo(() => {
    const out = items.filter((item) => {
      if (kind !== "all" && item.kind !== kind) return false;
      if (categories.size > 0 && kind !== "message") {
        if (item.kind !== "journal" || !categories.has(item.category)) return false;
      }
      if (machine !== "all" && !feedItemMachines(item).includes(machine)) return false;
      if (agentQuery && !feedItemAgents(item).some((n) => n.toLowerCase().includes(agentQuery))) {
        return false;
      }
      if (query && !item.body.toLowerCase().includes(query)) return false;
      return true;
    });
    return oldestFirst ? out.reverse() : out;
  }, [items, kind, categories, machine, agentQuery, query, oldestFirst]);

  const filtered =
    kind !== "all" || categories.size > 0 || machine !== "all" || agentQuery !== "" || query !== "";

  const toggleCategory = (value: string) =>
    setCategories((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });

  const clear = () => {
    setKind("all");
    setCategories(new Set());
    setMachine("all");
    setAgentInput("");
    setQueryInput("");
  };

  let lastDay = "";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <fieldset
          aria-label="Time window"
          className="m-0 inline-flex min-w-0 rounded-md border border-border p-0"
        >
          {WINDOW_LABELS.map((w, i) => (
            <Link
              key={w.value}
              href={`/feed?window=${w.value}`}
              prefetch={false}
              aria-current={windowKey === w.value ? "true" : undefined}
              className={cn(
                "inline-flex h-7 items-center px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                i > 0 && "border-l border-border",
                windowKey === w.value
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {w.label}
            </Link>
          ))}
        </fieldset>
        <Segmented
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: `All ${items.length}` },
            { value: "message", label: `Messages ${counts.messages}` },
            { value: "journal", label: `Journal ${counts.journal}` },
          ]}
        />
        {machines.length > 1 ? (
          <select
            aria-label="Machine"
            value={machine}
            onChange={(e) => setMachine(e.target.value)}
            className={fieldCls}
          >
            <option value="all">All machines</option>
            {machines.map((m) => (
              <option key={m} value={m}>
                {m === localMachine ? `${m} (this machine)` : m}
              </option>
            ))}
          </select>
        ) : null}
        <input
          type="search"
          aria-label="Filter by agent"
          placeholder="Agent"
          value={agentInput}
          onChange={(e) => setAgentInput(e.target.value)}
          className={cn(fieldCls, "w-32")}
        />
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-subtle-foreground"
          />
          <input
            type="search"
            aria-label="Search text"
            placeholder="Search text"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            className={cn(fieldCls, "w-48 pl-7")}
          />
        </div>
        <button
          type="button"
          onClick={() => setOldestFirst((v) => !v)}
          className={cn(
            fieldCls,
            "inline-flex items-center gap-1 text-muted-foreground hover:text-foreground",
          )}
        >
          {oldestFirst ? (
            <ArrowUpNarrowWide aria-hidden className="size-3.5" />
          ) : (
            <ArrowDownWideNarrow aria-hidden className="size-3.5" />
          )}
          {oldestFirst ? "Oldest first" : "Newest first"}
        </button>
        {filtered ? (
          <button
            type="button"
            onClick={clear}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Clear filters
          </button>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {filtered ? `${visible.length} of ${items.length} shown` : `${items.length} items`}
        </span>
      </div>

      {kind !== "message" && categoryCounts.size > 0 ? (
        <fieldset
          aria-label="Journal categories"
          className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0"
        >
          {CATEGORY_META.filter((m) => categoryCounts.has(m.value)).map((m) => {
            const on = categories.has(m.value);
            return (
              <button
                key={m.value}
                type="button"
                aria-pressed={on}
                onClick={() => toggleCategory(m.value)}
                className={cn(
                  "h-6 rounded-md border px-1.5 text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  on ? TONE.act.pill : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {`${m.label} ${categoryCounts.get(m.value)}`}
              </button>
            );
          })}
        </fieldset>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState>
          {items.length === 0
            ? "No messages or journal entries in this window."
            : "Nothing matches these filters."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
          {visible.map((item) => {
            const day = fmt(item.at, { kind: "date" });
            const header = day !== lastDay;
            lastDay = day;
            return (
              <Fragment key={item.id}>
                {header ? (
                  <li className="bg-muted px-3 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {day}
                  </li>
                ) : null}
                <FeedRow item={item} localMachine={localMachine} />
              </Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}
