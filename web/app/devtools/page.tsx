import type { ReactNode } from "react";
import { CursorKeyControl } from "@/components/CursorKeyControl";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { HelperAgentsBlock } from "@/components/HelperAgentsBlock";
import { Notice } from "@/components/layout/Notice";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Section } from "@/components/layout/Section";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import {
  type AccountUsage,
  type CursorUsage,
  type DevtoolsReport,
  readDevtoolsReport,
  type ToolStatus,
  type UsageSource,
} from "@/lib/devtools-reader";
import type { HelperLimitReport } from "@/lib/helper-limit";
import { readHelperLimitReport } from "@/lib/helper-limit-reader";
import { TONE, type Tone } from "@/lib/tone";

export const dynamic = "force-dynamic";

const TOOL_LABELS: Record<ToolStatus["tool"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** Per-tool explanations of where each field is read from, surfaced on hover. */
const SOURCES: Record<
  ToolStatus["tool"],
  { dir: string; sessions: string; tokens?: string; plan?: string }
> = {
  "claude-code": {
    dir: "~/.claude and every other Claude config directory",
    sessions: "Session transcripts under each Claude config directory's projects/.",
    tokens:
      "Every assistant message's input + output + cache tokens across transcripts in the window (cache reads dominate). Memoized per transcript, so only changed sessions are re-read.",
    plan: "Seat tier from the account's .claude.json.",
  },
  codex: {
    dir: "~/.codex and every other Codex home",
    sessions: "Threads recorded in ~/.codex/sqlite/state_5.sqlite.",
    tokens:
      "Each session's cumulative total_tokens (cache reads included), summed across its rollout within the window. Matches what Codex's own /status shows.",
    plan: "Plan reported by the usage source, else the sign-in token's claim.",
  },
  cursor: {
    dir: "~/.cursor, the Cursor CLI login and Cursor's state.vscdb",
    sessions: "Chats recorded in Cursor's state.vscdb (composerHeaders).",
    plan: "Stripe membership from Cursor's state.vscdb.",
  },
};

/** Where each usage source reads from, surfaced on the account's source badge. */
const SOURCE_LABELS: Record<UsageSource, { label: string; hint: string }> = {
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

export default async function DevtoolsPage() {
  const [report, helpers]: [DevtoolsReport, HelperLimitReport | null] = await Promise.all([
    readDevtoolsReport(),
    readHelperLimitReport(),
  ]);
  const now = Date.now();

  return (
    <PageShell>
      <PageHeader
        title="Tools"
        description="Coding agents: every Claude Code, Codex, and Cursor account signed in on this machine, with live usage from the first source that answers."
      />

      {report.error ? (
        <Notice tone="danger" title="Could not read agent status">
          {report.error}
        </Notice>
      ) : (
        <>
          <UsageBoard tools={report.tools} now={now} />
          <Section title="Details" className="mt-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {report.tools.map((t) => (
                <ToolCard
                  key={t.tool}
                  tool={t}
                  now={now}
                  windowDays={report.windowDays}
                  helpers={helpers}
                />
              ))}
            </div>
          </Section>
        </>
      )}

      {report.generatedAt && !report.error ? (
        <p className="mt-5 text-xs text-muted-foreground">
          as of <FormattedDateTime iso={report.generatedAt} kind="timestamp" />
        </p>
      ) : null}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// usage board: one row per account, showing what is LEFT so it reads at a glance
// ---------------------------------------------------------------------------

interface Meter {
  label: string;
  /** Percent of the allowance still available, 0-100, or null when unknown. */
  left: number | null;
  resetsAt: string | null;
}

/** Remaining-capacity colour: red at 10% or less, amber at 30% or less, else green. */
function leftTone(left: number | null): Tone {
  if (left == null) return "neutral";
  if (left <= 10) return "danger";
  if (left <= 30) return "warn";
  return "done";
}

function windowName(window: string): string {
  if (window === "5h") return "5-hour";
  const w = window.replace(/\s*·\s*/g, " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
}

function toLeft(usedPercent: number | null): number | null {
  if (usedPercent == null) return null;
  return 100 - Math.max(0, Math.min(100, Math.round(usedPercent)));
}

/** Every limit an account reports, as remaining percentages. */
function accountMeters(a: AccountUsage): Meter[] {
  const out: Meter[] = (a.quota ?? []).map((q) => ({
    label: windowName(q.window),
    left: toLeft(q.usedPercent),
    resetsAt: q.resetsAt,
  }));
  if (a.usage) {
    const reset = a.usage.cycleEnd;
    if (a.usage.totalPercentUsed != null)
      out.push({ label: "Monthly", left: toLeft(a.usage.totalPercentUsed), resetsAt: reset });
    if (a.usage.apiPercentUsed != null)
      out.push({ label: "API models", left: toLeft(a.usage.apiPercentUsed), resetsAt: reset });
    if (a.usage.firstPartyPercentUsed != null)
      out.push({ label: "Auto", left: toLeft(a.usage.firstPartyPercentUsed), resetsAt: reset });
  }
  return out;
}

function UsageBoard({ tools, now }: { tools: ToolStatus[]; now: number }) {
  const rows = tools.flatMap((t) => t.accounts.map((a) => ({ tool: t.tool, account: a })));
  if (!rows.length) return null;
  return (
    <Section
      title="Usage left"
      hint="What each account has left. The big number is its tightest limit right now."
    >
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {rows.map(({ tool, account }) => (
          <UsageRow key={`${tool}:${account.id}`} tool={tool} account={account} now={now} />
        ))}
      </div>
    </Section>
  );
}

function UsageRow({
  tool,
  account: a,
  now,
}: {
  tool: ToolStatus["tool"];
  account: AccountUsage;
  now: number;
}) {
  const meters = accountMeters(a);
  const known = meters.filter((m) => m.left != null);
  const tightest = known.length
    ? known.reduce((min, m) => ((m.left ?? 101) < (min.left ?? 101) ? m : min))
    : null;
  const tone: Tone = !a.loggedIn && !known.length ? "danger" : leftTone(tightest?.left ?? null);
  const source = a.source ? SOURCE_LABELS[a.source] : null;
  return (
    <div
      className={cn(
        "grid gap-x-5 gap-y-3 border-b border-l-4 border-border px-4 py-3 last:border-b-0 md:grid-cols-[minmax(12rem,17rem)_8.5rem_1fr] md:items-center",
        TONE[tone].accentBorder,
      )}
    >
      <div className="min-w-0">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {TOOL_LABELS[tool]}
          {a.plan ? ` · ${titleize(a.plan)}` : ""}
        </div>
        <div className="truncate font-medium">{a.email ?? a.id.replace(/^[^:]+:/, "")}</div>
        {a.stale || (source && a.source !== "direct") ? (
          <div className="mt-1">
            <Badge tone={a.stale ? "warn" : "accent"} title={source?.hint}>
              {a.stale ? `${source?.label ?? "snapshot"} · stale` : `via ${source?.label}`}
            </Badge>
          </div>
        ) : null}
      </div>

      <div>
        {tightest ? (
          <>
            <div className={cn("text-3xl font-semibold leading-none tabular-nums", TONE[tone].text)}>
              {tightest.left}%
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              left · {tightest.label.toLowerCase()}
            </div>
          </>
        ) : (
          <div className={cn("text-sm font-medium", TONE[tone].text)}>
            {a.loggedIn ? "no usage data" : "signed out"}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        {meters.map((m) => (
          <LeftMeter key={m.label} meter={m} now={now} />
        ))}
      </div>
    </div>
  );
}

function LeftMeter({ meter: m, now }: { meter: Meter; now: number }) {
  const tone = leftTone(m.left);
  return (
    <Tooltip
      side="top"
      content={
        <div className="space-y-0.5">
          <div>
            {m.left != null ? `${m.left}% of the ${m.label.toLowerCase()} limit left` : "unknown"}
          </div>
          {m.resetsAt ? (
            <div className="opacity-80">
              resets <FormattedDateTime iso={m.resetsAt} />
            </div>
          ) : null}
        </div>
      }
      triggerClassName="block w-full"
    >
      <div className="w-full cursor-help">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-muted-foreground">{m.label}</span>
          <span className={cn("font-semibold tabular-nums", TONE[tone].text)}>
            {m.left != null ? `${m.left}%` : "?"}
          </span>
        </div>
        <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", TONE[tone].dot)}
            style={{ width: `${m.left ?? 0}%` }}
          />
        </div>
        {m.resetsAt ? (
          <div className="mt-1 text-[11px] text-muted-foreground">
            {resetLabel(m.resetsAt, now)}
          </div>
        ) : null}
      </div>
    </Tooltip>
  );
}

function ToolCard({
  tool,
  now,
  windowDays,
  helpers,
}: {
  tool: ToolStatus;
  now: number;
  windowDays: number | null;
  helpers: HelperLimitReport | null;
}) {
  const src = SOURCES[tool.tool];
  if (!tool.installed) {
    return (
      <section className="rounded-lg border border-border bg-card p-5 opacity-60">
        <CardHeader tool={tool} />
        <p className="mt-3 text-sm text-muted-foreground">
          Not found at {src.dir} on this machine.
        </p>
      </section>
    );
  }
  return (
    <section className="flex flex-col rounded-lg border border-border bg-card p-5">
      <CardHeader tool={tool} />

      <dl className="mt-4 space-y-2 text-sm">
        {!tool.accounts.length && tool.account ? (
          <Row label="Account" value={tool.account} />
        ) : null}
        {tool.sessions != null ? (
          <Row label="Sessions" value={tool.sessions.toLocaleString()} hint={src.sessions} />
        ) : null}
        {tool.lastActivity ? (
          <Row
            label="Last active"
            value={relLabel(tool.lastActivity, now)}
            hint={<FormattedDateTime iso={tool.lastActivity} />}
          />
        ) : null}
        {tool.tokensUsed != null ? (
          <Row
            label={windowDays != null ? `Tokens · ${windowDays}d` : "Tokens"}
            value={fmtCompact(tool.tokensUsed)}
            hint={`${tool.tokensUsed.toLocaleString()} tokens. ${src.tokens ?? ""}`.trim()}
          />
        ) : null}
        {tool.api?.ok && tool.api.cloudAgents ? (
          <Row
            label="Cloud agents"
            value={`${tool.api.cloudAgents.total} · ${tool.api.cloudAgents.active} active`}
            hint={`Cloud Agent runs from cursor.com, via the API key${tool.api.keyName ? ` "${tool.api.keyName}"` : ""}. Individual plans expose no token-cost API.`}
          />
        ) : null}
      </dl>

      {!tool.accounts.length && tool.quota?.length ? (
        <div className="mt-4 space-y-3">
          {tool.quota.map((q) => (
            <QuotaBar
              key={q.window}
              window={q.window}
              pct={q.usedPercent}
              resetsAt={q.resetsAt}
              now={now}
            />
          ))}
        </div>
      ) : null}

      {tool.accounts.map((a) => (
        <AccountBlock key={a.id} account={a} tool={tool.tool} now={now} />
      ))}

      {tool.tool === "claude-code" ? <HelperAgentsBlock report={helpers} /> : null}

      {tool.notes.length ? (
        <ul className="mt-4 space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
          {tool.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      {tool.tool === "cursor" ? (
        <CursorKeyControl
          configured={tool.api != null}
          valid={tool.api?.ok ?? false}
          keyName={tool.api?.keyName ?? null}
        />
      ) : null}
    </section>
  );
}

/** One account: identity, the source that answered, and its usage. */
function AccountBlock({
  account: a,
  tool,
  now,
}: {
  account: AccountUsage;
  tool: ToolStatus["tool"];
  now: number;
}) {
  const src = SOURCES[tool];
  const source = a.source ? SOURCE_LABELS[a.source] : null;
  const stores = a.stores.map((s) => `${s.kind}: ${s.path}${s.loggedIn ? "" : " (signed out)"}`);
  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <Tooltip
          content={
            <div className="space-y-0.5">
              <div>Found in {a.stores.length === 1 ? "1 store" : `${a.stores.length} stores`}:</div>
              {stores.map((s) => (
                <div key={s} className="opacity-80">
                  {s}
                </div>
              ))}
            </div>
          }
          side="top"
        >
          <span className="cursor-help truncate text-sm font-medium">
            {a.email ?? a.id.replace(/^[^:]+:/, "")}
          </span>
        </Tooltip>
        <div className="flex shrink-0 items-center gap-1.5">
          {source ? (
            <Badge
              tone={a.stale ? "warn" : a.source === "direct" ? "done" : "accent"}
              title={
                <div className="space-y-0.5">
                  <div>{source.hint}</div>
                  {a.sourceDetail ? <div className="opacity-80">{a.sourceDetail}</div> : null}
                  {a.asOf ? (
                    <div className="opacity-80">
                      as of <FormattedDateTime iso={a.asOf} />
                    </div>
                  ) : null}
                </div>
              }
            >
              {a.stale ? `${source.label} · stale` : source.label}
            </Badge>
          ) : null}
          <SignInPill loggedIn={a.loggedIn} />
        </div>
      </div>

      <dl className="mt-3 space-y-2 text-sm">
        {a.plan ? (
          <Row
            label="Plan"
            value={titleize(a.plan)}
            hint={
              <>
                Raw value <code>{a.plan}</code>
                {src.plan ? <div className="mt-1 opacity-80">{src.plan}</div> : null}
              </>
            }
          />
        ) : null}
        {a.rateLimitTier ? (
          <Row
            label="Rate tier"
            value={titleize(a.rateLimitTier)}
            hint={
              <>
                Raw value <code>{a.rateLimitTier}</code>
              </>
            }
          />
        ) : null}
        {a.authExpiresAt ? (
          <Row
            label="Auth expires"
            value={expiryLabel(a.authExpiresAt, now)}
            hint={<FormattedDateTime iso={a.authExpiresAt} />}
          />
        ) : null}
        {a.credits?.balance != null && (a.credits.hasCredits || a.credits.unlimited) ? (
          <Row
            label="Credits"
            value={a.credits.unlimited ? "unlimited" : a.credits.balance.toLocaleString()}
            hint="Codex credits available beyond the plan's windows."
          />
        ) : null}
      </dl>

      {a.quota?.length ? (
        <div className="mt-3 space-y-3">
          {a.quota.map((q) => (
            <QuotaBar
              key={q.window}
              window={q.window}
              pct={q.usedPercent}
              resetsAt={q.resetsAt}
              now={now}
              hint={source?.hint}
            />
          ))}
        </div>
      ) : null}

      {a.usage ? <CursorUsageBlock usage={a.usage} now={now} /> : null}

      {a.spend?.limitCents != null ? (
        <dl className="mt-3 space-y-2 text-sm">
          <Row
            label={a.spend.label}
            value={`${fmtUsd(a.spend.usedCents ?? 0)} / ${fmtUsd(a.spend.limitCents)}`}
            hint="Overage spend used this cycle, against your cap. Billed only after included usage runs out."
          />
        </dl>
      ) : null}

      {a.notes.length ? (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {a.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SignInPill({ loggedIn }: { loggedIn: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE[loggedIn ? "done" : "danger"].pill,
      )}
    >
      {loggedIn ? "signed in" : "signed out"}
    </span>
  );
}

function CardHeader({ tool }: { tool: ToolStatus }) {
  return (
    <div className="flex items-center justify-between">
      <Tooltip content={`Read from ${SOURCES[tool.tool].dir}`}>
        <h2 className="cursor-help font-medium">{TOOL_LABELS[tool.tool]}</h2>
      </Tooltip>
      <LoginBadge tool={tool} />
    </div>
  );
}

function LoginBadge({ tool }: { tool: ToolStatus }) {
  const { loggedIn, account, accounts } = tool;
  const tone: Tone = loggedIn === true ? "done" : loggedIn === false ? "danger" : "neutral";
  const label = loggedIn === true ? "signed in" : loggedIn === false ? "signed out" : "unknown";
  const hint =
    loggedIn === true
      ? accounts.length > 1
        ? `${accounts.filter((a) => a.loggedIn).length} of ${accounts.length} accounts signed in.`
        : account
          ? `Signed in as ${account}, per the local credential.`
          : "A local credential is present."
      : loggedIn === false
        ? "No local credential found."
        : "Could not determine sign-in state from local files.";
  return (
    <Tooltip content={hint} side="top">
      <span
        className={cn(
          "cursor-help rounded-full border px-2 py-0.5 text-xs font-medium",
          TONE[tone].pill,
        )}
      >
        {label}
      </span>
    </Tooltip>
  );
}

function Row({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-medium">
        {hint ? (
          <Tooltip content={hint} side="top" align="end">
            <span className="cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-4">
              {value}
            </span>
          </Tooltip>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function QuotaBar({
  window,
  pct,
  resetsAt,
  now,
  hint,
}: {
  window: string;
  pct: number | null;
  resetsAt: string | null;
  now: number;
  hint?: string;
}) {
  // Shows what is LEFT (bar = remaining), matching the usage board above.
  const remaining = toLeft(pct);
  const clamped = remaining != null ? 100 - remaining : null;
  const tone = leftTone(remaining);
  const barColor = TONE[tone].dot;
  return (
    <Tooltip
      side="top"
      content={
        <div className="space-y-0.5">
          <div>
            {remaining != null ? `${remaining}% of the ${windowName(window)} limit left (${clamped}% used)` : "usage unknown"}
          </div>
          {resetsAt ? (
            <div className="opacity-80">
              resets <FormattedDateTime iso={resetsAt} />
            </div>
          ) : null}
          {hint ? <div className="opacity-80">{hint}</div> : null}
        </div>
      }
      triggerClassName="block w-full"
    >
      <div className="w-full cursor-help">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-muted-foreground">{windowName(window)}</span>
          <span className={cn("font-medium tabular-nums", TONE[tone].text)}>
            {remaining != null ? `${remaining}% left` : "unknown"}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${barColor}`}
            style={{ width: `${remaining ?? 0}%` }}
          />
        </div>
        {resetsAt ? (
          <p className="mt-1 text-[11px] text-muted-foreground">{resetLabel(resetsAt, now)}</p>
        ) : null}
      </div>
    </Tooltip>
  );
}

/**
 * Cursor billing-cycle + usage, fetched from cursor.com with the IDE's own
 * session token. The three percentages reuse the QuotaBar; the cycle countdown
 * renders as a row (on-demand spend renders via the shared spend row). Each bar
 * drops the per-bar reset label — they all reset on the same cycle date, shown
 * once in the "Plan resets" row.
 */
function CursorUsageBlock({ usage, now }: { usage: CursorUsage; now: number }) {
  const included = usage.includedLimitCents;
  const includedHint =
    included != null ? `Included allowance: ${fmtUsd(included)} this cycle.` : undefined;
  const bars: Array<{ window: string; pct: number | null; hint?: string }> = [
    { window: "Total", pct: usage.totalPercentUsed, hint: includedHint },
    { window: "API", pct: usage.apiPercentUsed, hint: includedHint },
    { window: "First-party", pct: usage.firstPartyPercentUsed },
  ].filter((b) => b.pct != null);

  return (
    <div className="mt-4 space-y-3">
      {usage.cycleEnd ? (
        <dl className="space-y-2 text-sm">
          <Row
            label="Plan resets"
            value={relLabel(usage.cycleEnd, now)}
            hint={
              <>
                Billing cycle resets <FormattedDateTime iso={usage.cycleEnd} />
                <div className="mt-1 opacity-80">
                  Usage percentages below are for this cycle, from cursor.com.
                </div>
              </>
            }
          />
        </dl>
      ) : null}
      {bars.length ? (
        <div className="space-y-3">
          {bars.map((b) => (
            <QuotaBar
              key={b.window}
              window={b.window}
              pct={b.pct}
              resetsAt={null}
              now={now}
              hint={b.hint}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

/** Cents → "$X.XX". */
function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Compact large counts for a narrow card: 4_929_355 → "4.9M", 1.38e10 → "13.8B". */
function fmtCompact(n: number): string {
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
function titleize(raw: string): string {
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
function relLabel(iso: string, now: number): string {
  const diff = Date.parse(iso) - now;
  if (Number.isNaN(diff)) return iso;
  const human = humanizeDuration(Math.abs(diff));
  return diff >= 0 ? `in ${human}` : `${human} ago`;
}

/** Token expiry: "in 7h 32m" while valid, "expired 5d ago" once past. */
function expiryLabel(iso: string, now: number): string {
  const diff = Date.parse(iso) - now;
  if (Number.isNaN(diff)) return iso;
  const human = humanizeDuration(Math.abs(diff));
  return diff >= 0 ? `in ${human}` : `expired ${human} ago`;
}

/** Quota reset: "resets in 3h" while live, "last window 2mo ago" when the snapshot is old. */
function resetLabel(iso: string, now: number): string {
  const diff = Date.parse(iso) - now;
  if (Number.isNaN(diff)) return `resets ${iso}`;
  const human = humanizeDuration(Math.abs(diff));
  return diff >= 0 ? `resets in ${human}` : `last window ${human} ago`;
}

/** Compact duration: two units under a day (5h 24m), one unit above (3d, 2mo, 1y). */
function humanizeDuration(ms: number): string {
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
