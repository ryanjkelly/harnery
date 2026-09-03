"use client";

import { Activity, Cpu, Gauge, MemoryStick } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  RESOURCE_LOOKBACK_MINUTES,
  type ResourceLookback,
  type ResourceMachineHistory,
  type ResourceMetric,
  resourceChartData,
} from "@/lib/resource-chart";
import type { ResourceMachineSample } from "../../../src/core/resources/contract";

const PREFERENCE_KEY = "harnery:resources:lookback-minutes";
const metrics = [
  {
    key: "cpu_percent",
    label: "CPU",
    icon: Cpu,
    color: "text-emerald-600 dark:text-emerald-300",
    panel: "border-emerald-500/25 bg-emerald-500/5",
  },
  {
    key: "memory_percent",
    label: "Memory",
    icon: MemoryStick,
    color: "text-violet-600 dark:text-violet-300",
    panel: "border-violet-500/25 bg-violet-500/5",
  },
  {
    key: "load_average_1",
    label: "Load average",
    icon: Gauge,
    color: "text-sky-600 dark:text-sky-300",
    panel: "border-sky-500/25 bg-sky-500/5",
  },
  {
    key: "process_count",
    label: "Processes",
    icon: Activity,
    color: "text-amber-600 dark:text-amber-300",
    panel: "border-amber-500/25 bg-amber-500/5",
  },
] as const;

interface Props {
  machine: ResourceMachineSample;
  sampledAt: string;
  history: readonly ResourceMachineHistory[];
  nowMs: number;
  live: boolean;
  details: Record<ResourceMetric, string>;
}

export function ResourceMetricCharts(props: Props) {
  const [minutes, setMinutes] = useState<ResourceLookback>(5);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(PREFERENCE_KEY));
      if (RESOURCE_LOOKBACK_MINUTES.includes(saved as ResourceLookback))
        setMinutes(saved as ResourceLookback);
    } catch {
      /* The chart works when browser storage is unavailable. */
    }
  }, []);
  const choose = (value: ResourceLookback) => {
    setMinutes(value);
    try {
      localStorage.setItem(PREFERENCE_KEY, String(value));
    } catch {
      /* Keep the in-page selection. */
    }
  };
  return (
    <section aria-label="Machine pressure" className="mb-6" data-resource-metrics>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={`size-1.5 rounded-full ${props.live ? "bg-emerald-500" : "bg-amber-500"}`}
          />
          {props.live ? "Live values" : "Last recorded values"}
          <span aria-hidden>·</span>
          <span>{`Last ${minutes} ${minutes === 1 ? "minute" : "minutes"}`}</span>
        </div>
        <fieldset className="flex items-center gap-1 rounded-lg border border-border/60 bg-card p-1">
          <legend className="sr-only">Chart lookback</legend>
          <span className="px-2 text-xs text-muted-foreground">History</span>
          {RESOURCE_LOOKBACK_MINUTES.map((value) => (
            <button
              key={value}
              type="button"
              aria-label={`Last ${value} ${value === 1 ? "minute" : "minutes"}`}
              aria-pressed={value === minutes}
              onClick={() => choose(value)}
              className={`min-h-8 min-w-12 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${value === minutes ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            >
              {value}m
            </button>
          ))}
        </fieldset>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {metrics.map((metric) => {
          const value =
            metric.key === "load_average_1"
              ? (props.machine.load_average?.[0] ?? null)
              : props.machine[metric.key];
          return (
            <Card key={metric.key} className={`${metric.panel} ${metric.color}`}>
              <CardContent className="p-4 sm:p-5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <metric.icon className="size-4" aria-hidden />
                  {metric.label}
                </div>
                <div className="mt-3 grid min-w-0 gap-4 min-[440px]:grid-cols-[minmax(120px,0.85fr)_minmax(0,1.5fr)] min-[440px]:items-center">
                  <div className="min-w-0">
                    <div
                      className="text-3xl font-semibold tabular-nums tracking-tight text-foreground"
                      data-resource-value={metric.key}
                    >
                      {format(value, metric.key)}
                    </div>
                    <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      {props.details[metric.key]}
                    </div>
                  </div>
                  <MetricChart
                    key={minutes}
                    {...props}
                    metric={metric.key}
                    label={metric.label}
                    minutes={minutes}
                  />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function MetricChart({
  machine,
  sampledAt,
  history,
  nowMs,
  metric,
  label,
  minutes,
}: Props & { metric: ResourceMetric; label: string; minutes: ResourceLookback }) {
  const id = useId();
  const [selectedAt, setSelectedAt] = useState<number | null>(null);
  const { samples, paths, ceiling } = resourceChartData(
    history,
    { machine, sampledAt },
    metric,
    minutes,
    nowMs,
  );
  const selected = samples.find((point) => point.at === selectedAt);
  const latest = samples.at(-1);
  return (
    <div
      className="min-w-0"
      data-resource-chart={metric}
      data-lookback-minutes={minutes}
      data-sample-count={samples.length}
    >
      <div className="mb-1 flex h-4 justify-end text-[10px] tabular-nums text-muted-foreground">
        {selected
          ? `${format(selected.value, metric)} · ${Math.max(0, Math.round((nowMs - selected.at) / 1000))}s ago`
          : samples.length < 2
            ? "Collecting history"
            : ""}
      </div>
      <div className="flex gap-2">
        <div
          aria-hidden
          className="flex w-7 shrink-0 flex-col justify-between py-0.5 text-right text-[10px] tabular-nums text-muted-foreground"
        >
          <span>{axis(ceiling, metric)}</span>
          <span>{axis(ceiling / 2, metric)}</span>
          <span>0</span>
        </div>
        <svg
          viewBox="0 0 300 100"
          preserveAspectRatio="none"
          role="img"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-description`}
          tabIndex={samples.length ? 0 : undefined}
          className="h-24 min-w-0 flex-1 overflow-visible rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          onPointerMove={(event) => {
            if (!samples.length) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const x = ((event.clientX - rect.left) / rect.width) * 300;
            const nearest = samples.reduce((best, point) =>
              Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best,
            );
            setSelectedAt(nearest.at);
          }}
          onPointerLeave={() => setSelectedAt(null)}
          onBlur={() => setSelectedAt(null)}
          onKeyDown={(event) => {
            if (!samples.length || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const current =
              selectedAt === null
                ? samples.length - 1
                : samples.findIndex((point) => point.at === selectedAt);
            const index =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? samples.length - 1
                  : Math.max(
                      0,
                      Math.min(samples.length - 1, current + (event.key === "ArrowLeft" ? -1 : 1)),
                    );
            setSelectedAt(samples[index]!.at);
          }}
        >
          <title
            id={`${id}-title`}
          >{`${label} history, last ${minutes} ${minutes === 1 ? "minute" : "minutes"}`}</title>
          <desc
            id={`${id}-description`}
          >{`${samples.length} readings. Latest: ${latest ? format(latest.value, metric) : "unavailable"}. Use left and right arrow keys to inspect readings. Gaps represent missing data.`}</desc>
          <path
            d="M0 4H300 M0 50H300 M0 96H300"
            className="stroke-border/80"
            strokeWidth="1"
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
          {paths.map((path) => (
            <path
              key={path}
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {latest ? <circle cx={latest.x} cy={latest.y} r="2.5" fill="currentColor" /> : null}
          {selected ? (
            <>
              <path
                d={`M${selected.x} 0V100`}
                stroke="currentColor"
                strokeWidth="1"
                strokeDasharray="3 3"
                opacity="0.4"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={selected.x} cy={selected.y} r="3" fill="currentColor" />
            </>
          ) : null}
        </svg>
      </div>
      <div aria-hidden className="ml-9 mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{`−${minutes} min`}</span>
        <span>Now</span>
      </div>
      <span className="sr-only" aria-live="polite">
        {selected
          ? `${label}: ${format(selected.value, metric)}, ${Math.round((nowMs - selected.at) / 1000)} seconds ago`
          : ""}
      </span>
    </div>
  );
}

function format(value: number | null, metric: ResourceMetric): string {
  if (value === null) return "Unknown";
  if (metric.endsWith("percent")) return `${value.toFixed(1)}%`;
  return metric === "load_average_1" ? value.toFixed(2) : value.toLocaleString();
}
function axis(value: number, metric: ResourceMetric): string {
  return metric.endsWith("percent") ? `${value}%` : Number(value.toPrecision(3)).toLocaleString();
}
