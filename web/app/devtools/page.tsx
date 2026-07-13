import type { ReactNode } from "react";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { NavBar } from "@/components/NavBar";
import { coordRoot } from "@/lib/coord-reader";
import { type DevtoolsReport, readDevtoolsReport, type ToolStatus } from "@/lib/devtools-reader";

export const dynamic = "force-dynamic";

const TOOL_LABELS: Record<ToolStatus["tool"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

export default async function DevtoolsPage() {
  const report: DevtoolsReport = await readDevtoolsReport();
  const now = Date.now();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar scannedDir={coordRoot()} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <header className="mb-5">
          <h1 className="text-lg font-semibold">Coding agents</h1>
          <p className="text-sm text-muted-foreground">
            Where Claude Code, Codex, and Cursor stand on this machine, read straight from local
            files. Nothing leaves the box.
          </p>
        </header>

        {report.error ? (
          <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
            Could not read agent status: {report.error}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {report.tools.map((t) => (
              <ToolCard key={t.tool} tool={t} now={now} />
            ))}
          </div>
        )}

        {report.generatedAt && !report.error ? (
          <p className="mt-5 text-xs text-muted-foreground">
            as of <FormattedDateTime iso={report.generatedAt} kind="timestamp" />
          </p>
        ) : null}
      </main>
    </div>
  );
}

function ToolCard({ tool, now }: { tool: ToolStatus; now: number }) {
  if (!tool.installed) {
    return (
      <section className="rounded-lg border border-border bg-card p-5 opacity-60">
        <CardHeader tool={tool} />
        <p className="mt-3 text-sm text-muted-foreground">Not installed on this machine.</p>
      </section>
    );
  }
  return (
    <section className="flex flex-col rounded-lg border border-border bg-card p-5">
      <CardHeader tool={tool} />

      <dl className="mt-4 space-y-2 text-sm">
        {tool.account ? <Row label="Account" value={tool.account} /> : null}
        {tool.plan ? <Row label="Plan" value={titleize(tool.plan)} /> : null}
        {tool.rateLimitTier ? <Row label="Rate tier" value={titleize(tool.rateLimitTier)} /> : null}
        {tool.authExpiresAt ? (
          <Row label="Auth expires" value={expiryLabel(tool.authExpiresAt, now)} />
        ) : null}
        {tool.sessions != null ? (
          <Row label="Sessions" value={tool.sessions.toLocaleString()} />
        ) : null}
        {tool.lastActivity ? (
          <Row label="Last active" value={relLabel(tool.lastActivity, now)} />
        ) : null}
        {tool.tokensUsed != null ? (
          <Row label="Tokens" value={tool.tokensUsed.toLocaleString()} />
        ) : null}
      </dl>

      {tool.quota?.length ? (
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

      {tool.notes.length ? (
        <ul className="mt-4 space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
          {tool.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CardHeader({ tool }: { tool: ToolStatus }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="font-medium">{TOOL_LABELS[tool.tool]}</h2>
      <LoginBadge loggedIn={tool.loggedIn} />
    </div>
  );
}

function LoginBadge({ loggedIn }: { loggedIn: boolean | null }) {
  const styles =
    loggedIn === true
      ? "bg-positive-soft text-positive"
      : loggedIn === false
        ? "bg-negative-soft text-negative"
        : "bg-muted text-muted-foreground";
  const label = loggedIn === true ? "signed in" : loggedIn === false ? "signed out" : "unknown";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>{label}</span>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-medium">{value}</dd>
    </div>
  );
}

function QuotaBar({
  window,
  pct,
  resetsAt,
  now,
}: {
  window: string;
  pct: number | null;
  resetsAt: string | null;
  now: number;
}) {
  const clamped = pct != null ? Math.max(0, Math.min(100, Math.round(pct))) : null;
  // Color grammar: emerald under load, amber past two-thirds, red past 90%.
  const barColor =
    clamped == null
      ? "bg-muted-foreground/40"
      : clamped >= 90
        ? "bg-negative"
        : clamped >= 66
          ? "bg-revenue"
          : "bg-positive";
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{window} quota</span>
        <span className="font-medium tabular-nums">
          {clamped != null ? `${clamped}%` : "unknown"}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${clamped ?? 0}%` }} />
      </div>
      {resetsAt ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{resetLabel(resetsAt, now)}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

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
