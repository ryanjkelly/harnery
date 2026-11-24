import type { ReactNode } from "react";
import { BrandLogo } from "@/components/BrandLogo";
import { CursorKeyControl } from "@/components/CursorKeyControl";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { HelperAgentsBlock } from "@/components/HelperAgentsBlock";
import { Notice } from "@/components/layout/Notice";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Section } from "@/components/layout/Section";
import {
  expiryLabel,
  fmtCompact,
  fmtUsd,
  HUE_BG,
  HUE_TEXT,
  hueStyle,
  RESET_KIND_HINT,
  relLabel,
  resetLabel,
  SOURCE_LABELS,
  TOOL_LABELS,
  titleize,
  toLeft,
  windowName,
} from "@/components/UsageBoard";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import {
  type AccountUsage,
  type CursorUsage,
  type DevtoolsReport,
  readDevtoolsReport,
  type ToolStatus,
} from "@/lib/devtools-reader";
import type { HelperLimitReport } from "@/lib/helper-limit";
import { readHelperLimitReport } from "@/lib/helper-limit-reader";
import { TONE, type Tone } from "@/lib/tone";

export const dynamic = "force-dynamic";

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
        description="Coding agents: every Claude Code, Codex, and Cursor account signed in on this machine, with plan details, sign-in state and usage. The at-a-glance view lives on the Usage page."
      />

      {report.error ? (
        <Notice tone="danger" title="Could not read agent status">
          {report.error}
        </Notice>
      ) : (
        <Section title="Details">
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
      )}

      {report.generatedAt && !report.error ? (
        <p className="mt-5 text-xs text-muted-foreground">
          as of <FormattedDateTime iso={report.generatedAt} kind="timestamp" />
        </p>
      ) : null}
    </PageShell>
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

      {a.resets?.length ? (
        <div className="mt-3 text-sm">
          <div className="text-muted-foreground">Resets</div>
          <ul className="mt-1 space-y-1 text-xs">
            {a.resets.map((g) => (
              <li
                key={`${g.kind}:${g.label}:${g.expiresAt ?? ""}`}
                className="flex items-baseline justify-between gap-3"
              >
                <Tooltip
                  content={
                    <div className="space-y-0.5">
                      <div>{g.label}</div>
                      <div className="opacity-80">{RESET_KIND_HINT[g.kind]}</div>
                    </div>
                  }
                  side="top"
                  triggerClassName="block min-w-0 flex-1"
                >
                  <span className="block cursor-help truncate">{g.label}</span>
                </Tooltip>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {`${g.left} left`}
                  {g.expiresAt ? (
                    <>
                      {" · exp "}
                      <FormattedDateTime iso={g.expiresAt} kind="date" />
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
        <h2 className="flex cursor-help items-center gap-2 font-medium">
          <BrandLogo brand={tool.tool} />
          {TOOL_LABELS[tool.tool]}
        </h2>
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
  const barColor = remaining != null ? HUE_BG : TONE.neutral.dot;
  return (
    <Tooltip
      side="top"
      content={
        <div className="space-y-0.5">
          <div>
            {remaining != null
              ? `${remaining}% of the ${windowName(window)} limit left (${clamped}% used)`
              : "usage unknown"}
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
      <div className="w-full cursor-help" style={hueStyle(remaining)}>
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-muted-foreground">{windowName(window)}</span>
          <span className={cn("font-medium tabular-nums", remaining != null ? HUE_TEXT : "")}>
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
    { window: "Auto (Cursor models)", pct: usage.firstPartyPercentUsed },
    { window: "API (other models)", pct: usage.apiPercentUsed, hint: includedHint },
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
