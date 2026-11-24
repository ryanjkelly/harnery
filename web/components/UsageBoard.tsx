// Shared usage board and formatting helpers for the Usage and Tools pages.

import type * as React from "react";
import { BrandLogo } from "@/components/BrandLogo";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { Section } from "@/components/layout/Section";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type {
  AccountUsage,
  RecentRate,
  ResetGrant,
  ToolStatus,
  UsageSource,
} from "@/lib/devtools-reader";
import { TONE, type Tone } from "@/lib/tone";

export const TOOL_LABELS: Record<ToolStatus["tool"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

export const SOURCE_LABELS: Record<UsageSource, { label: string; hint: string }> = {
  direct: {
    label: "direct",
    hint: "Read from the vendor's usage endpoint with the account's own stored token.",
  },
  "codex-app-server": {
    label: "codex app-server",
    hint: "Read by Codex itself (codex app-server), which refreshes its own token.",
  },
  cliproxy: {
    label: "CLI Proxy",
    hint: "Read through the local CLI Proxy API server with the token it holds for this account.",
  },
  snapshot: {
    label: "snapshot",
    hint: "The last rate-limit snapshot a local Codex session wrote. It ages until the next turn.",
  },
};

// ---------------------------------------------------------------------------
// usage board: one row per account, showing what is LEFT so it reads at a glance
// ---------------------------------------------------------------------------

/** Board columns: 0 = short window (5-hour), 1 = weekly / monthly, 2-3 = other limits. */
export type Slot = 0 | 1 | 2 | 3;

export interface Meter {
  label: string;
  /** Percent of the allowance still available, 0-100, or null when unknown. */
  left: number | null;
  resetsAt: string | null;
  /** Full length of the window, for pace. Null when unknown. */
  durationMs: number | null;
  slot: Slot;
  /** Recent burn rate and trend points from the usage history, when recorded. */
  recent?: RecentRate;
}

export type PaceState = "under" | "on" | "over";

export interface Pace {
  /** Percent that would be left right now at an even burn across the window, when its length is known. */
  expectedLeft: number | null;
  state: PaceState;
  /** At the current burn rate, ms until the limit runs out, when that is before the reset. */
  runOutMs: number | null;
  /** `recent`: the rate over the history lookback; `average`: the average since the window opened. */
  basis: "recent" | "average";
  /** The lookback behind a recent rate. */
  lookbackMs: number | null;
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** Points either side of an even burn that still count as "on pace". */
export const PACE_TOLERANCE = 5;

/**
 * Hue for a remaining percentage, sliding from red (0% left) through orange
 * and yellow to green (100% left), so a bar's colour shows how close it is to
 * running out rather than jumping at fixed thresholds.
 */
export function leftHue(left: number | null): number | null {
  return left == null ? null : 25 + 1.25 * Math.max(0, Math.min(100, left));
}

/** Inline style that feeds a hue to the `--h` custom property the classes below read. */
export function hueStyle(left: number | null): React.CSSProperties | undefined {
  const h = leftHue(left);
  return h == null ? undefined : ({ "--h": h } as React.CSSProperties);
}
export const HUE_TEXT = "text-[oklch(0.52_0.15_var(--h))] dark:text-[oklch(0.8_0.14_var(--h))]";
export const HUE_BG = "bg-[oklch(0.72_0.17_var(--h))]";

export function windowName(window: string): string {
  if (window === "5h") return "5-hour";
  const w = window.replace(/\s*·\s*/g, " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Window length from its label: "5h", "45m", "3d", "weekly…" (7 days). */
export function windowDuration(window: string): number | null {
  const m = /^(\d+)\s*(m|h|d)$/.exec(window.trim());
  if (m) return Number(m[1]) * (m[2] === "m" ? 60_000 : m[2] === "h" ? HOUR : DAY);
  if (/^weekly/i.test(window)) return 7 * DAY;
  if (/^monthly/i.test(window)) return 30 * DAY;
  return null;
}

export function toLeft(usedPercent: number | null): number | null {
  if (usedPercent == null) return null;
  return 100 - Math.max(0, Math.min(100, Math.round(usedPercent)));
}

/** Every limit an account reports, as remaining percentages placed in board columns. */
export function accountMeters(a: AccountUsage): Meter[] {
  const out: Meter[] = [];
  let extra: Slot = 2;
  const nextExtra = (): Slot => {
    const s = extra;
    if (extra < 3) extra = 3;
    return s;
  };
  for (const q of a.quota ?? []) {
    const durationMs = windowDuration(q.window);
    const slot: Slot =
      durationMs != null && durationMs < DAY ? 0 : /^weekly$/i.test(q.window) ? 1 : nextExtra();
    out.push({
      label: windowName(q.window),
      left: toLeft(q.usedPercent),
      resetsAt: q.resetsAt,
      durationMs,
      slot,
      recent: q.recent,
    });
  }
  if (a.usage) {
    const u = a.usage;
    const reset = u.cycleEnd;
    const span =
      u.cycleStart && u.cycleEnd ? Date.parse(u.cycleEnd) - Date.parse(u.cycleStart) : NaN;
    const durationMs = Number.isFinite(span) && span > 0 ? span : 30 * DAY;
    if (u.totalPercentUsed != null)
      out.push({
        label: "Monthly",
        left: toLeft(u.totalPercentUsed),
        resetsAt: reset,
        durationMs,
        slot: 1,
        recent: u.recent?.total,
      });
    if (u.firstPartyPercentUsed != null)
      out.push({
        label: "Auto (Cursor models)",
        left: toLeft(u.firstPartyPercentUsed),
        resetsAt: reset,
        durationMs,
        slot: nextExtra(),
        recent: u.recent?.auto,
      });
    if (u.apiPercentUsed != null)
      out.push({
        label: "API (other models)",
        left: toLeft(u.apiPercentUsed),
        resetsAt: reset,
        durationMs,
        slot: nextExtra(),
        recent: u.recent?.api,
      });
  }
  return out;
}

/** Percent an even burn would leave now, or null when the window length is unknown. */
export function evenLeft(m: Meter, remainingMs: number): number | null {
  if (!m.durationMs || remainingMs > m.durationMs) return null;
  return 100 * (remainingMs / m.durationMs);
}

/**
 * Pace. With a recent rate from the usage history, compare it with the rate
 * that would last exactly until the reset (within 10% counts as on pace).
 * Without one, compare what is left with an even burn across the window; that
 * average is null when the window length or reset is unknown, or in the first
 * 3% of a window, where one burst of work would read as wildly over pace.
 */
export function paceOf(m: Meter, now: number): Pace | null {
  if (m.left == null || !m.resetsAt) return null;
  const remainingMs = Date.parse(m.resetsAt) - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const expectedLeft = evenLeft(m, remainingMs);
  const recentRate = m.recent?.ratePerHour;
  if (recentRate != null && m.recent) {
    const sustainable = m.left / (remainingMs / HOUR);
    const state: PaceState =
      recentRate <= 0 || recentRate < sustainable * 0.9
        ? "under"
        : recentRate > sustainable * 1.1
          ? "over"
          : "on";
    const runOut = recentRate > 0 && m.left > 0 ? (m.left / recentRate) * HOUR : null;
    return {
      expectedLeft,
      state,
      runOutMs: runOut != null && runOut < remainingMs ? runOut : null,
      basis: "recent",
      lookbackMs: m.recent.lookbackMs,
    };
  }
  if (expectedLeft == null || !m.durationMs) return null;
  const elapsed = 1 - remainingMs / m.durationMs;
  if (elapsed < 0.03) return null;
  const diff = m.left - expectedLeft;
  const state: PaceState = diff > PACE_TOLERANCE ? "under" : diff < -PACE_TOLERANCE ? "over" : "on";
  const used = 100 - m.left;
  const rate = used / (elapsed * m.durationMs);
  const runOut = rate > 0 && m.left > 0 ? m.left / rate : null;
  return {
    expectedLeft,
    state,
    runOutMs: runOut != null && runOut < remainingMs ? runOut : null,
    basis: "average",
    lookbackMs: null,
  };
}

/** "Based on your last 24 hours" / "Based on the average since this window started". */
export function paceBasis(p: Pace): string {
  if (p.basis === "average" || p.lookbackMs == null) {
    return "Based on the average since this window started.";
  }
  const ms = p.lookbackMs;
  const span =
    ms < 2 * HOUR
      ? `${Math.round(ms / MINUTE)} minutes`
      : ms < 2 * DAY
        ? `${Math.round(ms / HOUR)} hours`
        : `${Math.round(ms / DAY)} days`;
  return `Based on your last ${span}.`;
}

/** The limit that decides how much room an account has, for the "use next" pick. */
export function limitingMeter(meters: Meter[]): Meter | null {
  const known = meters.filter((m) => m.left != null);
  if (!known.length) return null;
  const isShort = (m: Meter) => m.durationMs != null && m.durationMs < DAY;
  const min = (ms: Meter[]) => ms.reduce((a, b) => ((b.left ?? 101) < (a.left ?? 101) ? b : a));
  const shortLow = known.filter((m) => isShort(m) && (m.left ?? 101) <= 10);
  if (shortLow.length) return min(shortLow);
  const long = known.filter((m) => !isShort(m));
  return min(long.length ? long : known);
}

export interface UseNextPick {
  left: number;
  /** "weekly", "monthly", "5-hour", … for the hint. */
  kind: string;
}

/**
 * Per tool with two or more signed-in accounts reporting usage, the account
 * with the most room: the lowest left across its day-or-longer limits, unless
 * a short limit is down to 10% or less. A tie goes to the later run-out.
 */
export function pickNextAccounts(tools: ToolStatus[], now: number): Map<string, UseNextPick> {
  const picks = new Map<string, UseNextPick>();
  for (const t of tools) {
    const scored = t.accounts
      .filter((a) => a.loggedIn)
      .map((a) => ({ a, m: limitingMeter(accountMeters(a)) }))
      .filter((x): x is { a: AccountUsage; m: Meter } => x.m != null);
    if (scored.length < 2) continue;
    const runOut = (m: Meter) => paceOf(m, now)?.runOutMs ?? Number.POSITIVE_INFINITY;
    const best = scored.reduce((a, b) => {
      const la = a.m.left ?? 0;
      const lb = b.m.left ?? 0;
      if (lb !== la) return lb > la ? b : a;
      return runOut(b.m) > runOut(a.m) ? b : a;
    });
    const left = best.m.left ?? 0;
    if (left <= 0) continue;
    const d = best.m.durationMs;
    const kind =
      d === 7 * DAY
        ? "weekly"
        : d != null && d >= 28 * DAY
          ? "monthly"
          : best.m.label.replace(/\s*\(.*\)/, "").toLowerCase();
    picks.set(`${t.tool}:${best.a.id}`, { left, kind });
  }
  return picks;
}

export const PACE_LABEL: Record<
  PaceState,
  { text: string; icon: string; tone: Tone; hint: string }
> = {
  under: {
    text: "under pace",
    icon: "▼",
    tone: "done",
    hint: "Using less than an even share of this window so far.",
  },
  on: {
    text: "on pace",
    icon: "●",
    tone: "neutral",
    hint: "Using about an even share of this window.",
  },
  over: {
    text: "over pace",
    icon: "▲",
    tone: "warn",
    hint: "Using more than an even share of this window so far.",
  },
};

export const BOARD_GRID =
  "md:grid-cols-[minmax(14rem,19rem)_7.5rem_repeat(4,minmax(0,1fr))] md:items-center";

export function UsageBoard({ tools, now }: { tools: ToolStatus[]; now: number }) {
  const rows = tools.flatMap((t) => t.accounts.map((a) => ({ tool: t.tool, account: a })));
  if (!rows.length) return null;
  const picks = pickNextAccounts(tools, now);
  return (
    <Section
      title="Usage left"
      hint="What each account has left. The big number is its tightest limit right now. The thin mark on each bar is where an even pace would be."
    >
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div
          className={cn(
            "hidden gap-x-5 border-b border-l-4 border-border border-l-transparent bg-muted/40 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:grid",
            BOARD_GRID,
          )}
        >
          <div>Account</div>
          <div>Tightest</div>
          <div>5-hour</div>
          <div>Weekly · monthly</div>
          <div className="col-span-2">Other limits</div>
        </div>
        {rows.map(({ tool, account }) => (
          <UsageRow
            key={`${tool}:${account.id}`}
            tool={tool}
            account={account}
            now={now}
            pick={picks.get(`${tool}:${account.id}`) ?? null}
          />
        ))}
      </div>
    </Section>
  );
}

export function UsageRow({
  tool,
  account: a,
  now,
  pick,
}: {
  tool: ToolStatus["tool"];
  account: AccountUsage;
  now: number;
  pick: UseNextPick | null;
}) {
  const meters = accountMeters(a);
  const known = meters.filter((m) => m.left != null);
  const tightest = known.length
    ? known.reduce((min, m) => ((m.left ?? 101) < (min.left ?? 101) ? m : min))
    : null;
  const tightPace = tightest ? paceOf(tightest, now) : null;
  const source = a.source ? SOURCE_LABELS[a.source] : null;
  const bySlot = new Map(meters.map((m) => [m.slot, m] as const));
  const signedOut = !a.loggedIn && !known.length;
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-x-5 gap-y-3 border-b border-l-4 border-border px-4 py-3 last:border-b-0",
        BOARD_GRID,
        signedOut ? TONE.danger.accentBorder : tightest ? "" : TONE.neutral.accentBorder,
      )}
      style={
        tightest ? { borderLeftColor: `oklch(0.72 0.17 ${leftHue(tightest.left)})` } : undefined
      }
    >
      <div className="col-span-2 flex min-w-0 items-center gap-3 md:col-span-1">
        <BrandLogo brand={tool} className="size-6 shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span className="truncate">
              {TOOL_LABELS[tool]}
              {a.plan ? ` · ${titleize(a.plan)}` : ""}
            </span>
            {pick ? (
              <Badge
                tone="act"
                title={`Most room of your ${TOOL_LABELS[tool]} accounts: ${pick.left}% left on its tightest ${pick.kind} limit.`}
              >
                use next
              </Badge>
            ) : null}
          </div>
          <div className="truncate font-medium">{a.email ?? a.id.replace(/^[^:]+:/, "")}</div>
          <AccountChips tool={tool} account={a} />
          {a.stale || (source && a.source !== "direct") ? (
            <div className="mt-1">
              <Badge tone={a.stale ? "warn" : "accent"} title={source?.hint}>
                {a.stale ? `${source?.label ?? "snapshot"} · stale` : `via ${source?.label}`}
              </Badge>
            </div>
          ) : null}
        </div>
      </div>

      <div className="col-span-2 md:col-span-1">
        {tightest ? (
          <div style={hueStyle(tightest.left)}>
            <div className={cn("text-3xl font-semibold leading-none tabular-nums", HUE_TEXT)}>
              {tightest.left}%
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              left · {tightest.label.replace(/\s*\(.*\)/, "").toLowerCase()}
            </div>
            {tightPace ? (
              <Tooltip content={paceBasis(tightPace)} side="top" triggerClassName="flex">
                <PaceTag pace={tightPace} className="mt-0.5 cursor-help" stacked />
              </Tooltip>
            ) : null}
          </div>
        ) : (
          <div className={cn("text-sm font-medium", TONE[signedOut ? "danger" : "neutral"].text)}>
            {signedOut ? "signed out" : "no usage data"}
          </div>
        )}
      </div>

      {([0, 1, 2, 3] as const).map((slot) => {
        const m = bySlot.get(slot);
        return m ? (
          <LeftMeter key={slot} meter={m} now={now} />
        ) : (
          <div key={slot} className="hidden md:block" aria-hidden />
        );
      })}
    </div>
  );
}

export function PaceTag({
  pace,
  className,
  stacked,
}: {
  pace: Pace;
  className?: string;
  stacked?: boolean;
}) {
  const p = PACE_LABEL[pace.state];
  return (
    <div className={cn("text-[11px] font-medium", TONE[p.tone].text, className)}>
      {p.icon} {p.text}
      {pace.basis === "recent" ? (
        <span className="font-normal text-muted-foreground"> (recent)</span>
      ) : null}
      {pace.runOutMs != null ? (
        <span className={cn(TONE.danger.text, stacked && "block")}>
          {stacked ? "" : " · "}out in ~{humanizeDuration(pace.runOutMs)}
        </span>
      ) : null}
    </div>
  );
}

export function LeftMeter({ meter: m, now }: { meter: Meter; now: number }) {
  const pace = paceOf(m, now);
  return (
    <Tooltip
      side="top"
      content={
        <div className="space-y-0.5">
          <div>
            {m.left != null ? `${m.left}% of the ${m.label.toLowerCase()} limit left` : "unknown"}
          </div>
          {pace ? (
            <>
              {pace.expectedLeft != null ? (
                <div className="opacity-80">
                  An even pace would leave {Math.round(pace.expectedLeft)}% now (the thin mark).
                </div>
              ) : null}
              <div className="opacity-80">{PACE_LABEL[pace.state].hint}</div>
              <div className="opacity-80">{paceBasis(pace)}</div>
              {pace.runOutMs != null ? (
                <div className="opacity-80">
                  At this rate it runs out in about {humanizeDuration(pace.runOutMs)}, before it
                  resets.
                </div>
              ) : null}
            </>
          ) : null}
          {m.resetsAt ? (
            <div className="opacity-80">
              resets <FormattedDateTime iso={m.resetsAt} />
            </div>
          ) : null}
        </div>
      }
      triggerClassName="block w-full"
    >
      <div className="w-full cursor-help" style={hueStyle(m.left)}>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="min-w-0 truncate text-muted-foreground">{m.label}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            {m.recent ? <Sparkline points={m.recent.points} /> : null}
            <span className={cn("font-semibold tabular-nums", m.left != null ? HUE_TEXT : "")}>
              {m.left != null ? `${m.left}%` : "?"}
            </span>
          </span>
        </div>
        <div className="relative mt-1.5 h-2 w-full rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", m.left != null ? HUE_BG : TONE.neutral.dot)}
            style={{ width: `${m.left ?? 0}%` }}
          />
          {pace?.expectedLeft != null ? (
            <div
              className="absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-foreground/80"
              style={{ left: `${pace.expectedLeft}%` }}
              aria-hidden
            />
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-muted-foreground">
          {pace ? <PaceTag pace={pace} /> : null}
          {m.resetsAt ? (
            <span>
              {pace ? "· " : ""}
              {resetLabel(m.resetsAt, now)}
            </span>
          ) : null}
        </div>
      </div>
    </Tooltip>
  );
}

/** Remaining-percent trend over the recent lookback: a tiny line, no fill. Needs 3+ points. */
export function Sparkline({ points }: { points: Array<[number, number]> }) {
  if (points.length < 3) return null;
  const W = 56;
  const H = 14;
  const P = 1.5;
  const t0 = points[0]?.[0] ?? 0;
  const span = (points[points.length - 1]?.[0] ?? t0) - t0 || 1;
  const vals = points.map(([, used]) => 100 - used);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  // A floor on the vertical range, so a one-point wobble stays a near-flat line.
  if (hi - lo < 4) {
    const mid = (hi + lo) / 2;
    lo = mid - 2;
    hi = mid + 2;
  }
  const d = points
    .map(([t, used]) => {
      const x = P + ((t - t0) / span) * (W - 2 * P);
      const y = P + (1 - (100 - used - lo) / (hi - lo)) * (H - 2 * P);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="shrink-0 text-muted-foreground"
      aria-hidden="true"
    >
      <polyline
        points={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export const CHIP =
  "inline-flex cursor-help items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-px text-[11px] font-medium";

/** What a reset kind does, for its hover hint. */
export const RESET_KIND_HINT: Record<ResetGrant["kind"], string> = {
  full: "Clears the 5-hour and weekly limits.",
  fable: "Refills the 5-hour limit and gives back what Fable used on the weekly limit.",
};

/** Available resets grouped by kind, soonest expiry first within each. */
export function groupResets(resets: ResetGrant[]) {
  const kinds: ResetGrant["kind"][] = ["full", "fable"];
  return kinds
    .map((kind) => {
      const grants = resets
        .filter((g) => g.kind === kind && g.left > 0)
        .sort((a, b) => (a.expiresAt ?? "9").localeCompare(b.expiresAt ?? "9"));
      const expiries = new Set(grants.map((g) => g.expiresAt?.slice(0, 10) ?? null));
      return {
        kind,
        grants,
        count: grants.reduce((n, g) => n + g.left, 0),
        soonest: grants[0]?.expiresAt ?? null,
        severalDates: expiries.size > 1,
      };
    })
    .filter((g) => g.count > 0);
}

/** Resets, credits and extra-usage spend under the account's email on the board. */
export function AccountChips({
  tool,
  account: a,
}: {
  tool: ToolStatus["tool"];
  account: AccountUsage;
}) {
  const groups = groupResets(a.resets ?? []);
  const credits =
    a.credits?.hasCredits && (a.credits.unlimited || (a.credits.balance ?? 0) > 0)
      ? a.credits
      : null;
  const spend = tool === "claude-code" && a.spend?.limitCents != null ? a.spend : null;
  if (!groups.length && !credits && !spend) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {groups.map((g) => (
        <Tooltip
          key={g.kind}
          side="top"
          content={
            <div className="space-y-0.5">
              {g.grants.map((r) => (
                <div key={`${r.label}:${r.expiresAt ?? ""}`}>
                  {r.left > 1 ? `${r.left}× ` : ""}
                  {r.label}
                  {r.expiresAt ? (
                    <span className="opacity-80">
                      {" · expires "}
                      <FormattedDateTime iso={r.expiresAt} />
                    </span>
                  ) : null}
                  {r.usableNow === false ? (
                    <span className="opacity-80">
                      {` · not usable yet${r.unavailableReason ? ` (${r.unavailableReason.replace(/_/g, " ")})` : ""}`}
                    </span>
                  ) : null}
                </div>
              ))}
              <div className="opacity-80">{RESET_KIND_HINT[g.kind]}</div>
            </div>
          }
        >
          <span className={cn(CHIP, TONE.accent.pill)}>
            {`↻ ${g.count} ${g.kind === "fable" ? "Fable" : "full"} reset${g.count === 1 ? "" : "s"}`}
            {g.soonest ? (
              <>
                {g.severalDates ? " · next exp " : " · exp "}
                <FormattedDateTime iso={g.soonest} template="MMM D" />
              </>
            ) : null}
          </span>
        </Tooltip>
      ))}
      {credits ? (
        <Tooltip side="top" content="Codex credits available beyond the plan's windows.">
          <span className={cn(CHIP, TONE.neutral.pill)}>
            {credits.unlimited
              ? "unlimited credits"
              : `${fmtCompact(credits.balance ?? 0)} credits`}
          </span>
        </Tooltip>
      ) : null}
      {spend ? (
        <Tooltip
          side="top"
          content="Extra usage spent this cycle, against your cap. Billed only after the plan's limits run out."
        >
          <span className={cn(CHIP, TONE.neutral.pill)}>
            {`extra ${fmtUsd(spend.usedCents ?? 0)} / ${fmtUsd(spend.limitCents ?? 0)}`}
          </span>
        </Tooltip>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

/** Cents → "$X.XX". */
export function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Compact large counts for a narrow card: 4_929_355 → "4.9M", 1.38e10 → "13.8B". */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

/**
 * Turn a machine token into a human label: strip a leading "default_", split on
 * underscores, title-case each word, and render a "5x"-style multiplier as "5×".
 * e.g. "pro_plus" → "Pro Plus", "default_claude_max_5x" → "Claude Max 5×".
 */
export function titleize(raw: string): string {
  return raw
    .replace(/^default_/, "")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => {
      const mult = w.match(/^(\d+)x$/i);
      if (mult) return `${mult[1]}×`;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/** "in 5h 24m" for a future instant, "2mo ago" for a past one. */
export function relLabel(iso: string, now: number): string {
  const diff = Date.parse(iso) - now;
  if (Number.isNaN(diff)) return iso;
  const human = humanizeDuration(Math.abs(diff));
  return diff >= 0 ? `in ${human}` : `${human} ago`;
}

/** Token expiry: "in 7h 32m" while valid, "expired 5d ago" once past. */
export function expiryLabel(iso: string, now: number): string {
  const diff = Date.parse(iso) - now;
  if (Number.isNaN(diff)) return iso;
  const human = humanizeDuration(Math.abs(diff));
  return diff >= 0 ? `in ${human}` : `expired ${human} ago`;
}

/** Quota reset: "resets in 3h" while live, "last window 2mo ago" when the snapshot is old. */
export function resetLabel(iso: string, now: number): string {
  const diff = Date.parse(iso) - now;
  if (Number.isNaN(diff)) return `resets ${iso}`;
  const human = humanizeDuration(Math.abs(diff));
  return diff >= 0 ? `resets in ${human}` : `last window ${human} ago`;
}

/** Compact duration: two units under a day (5h 24m), one unit above (3d, 2mo, 1y). */
export function humanizeDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}
