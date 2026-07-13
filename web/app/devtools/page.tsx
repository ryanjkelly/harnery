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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar scannedDir={coordRoot()} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <header className="mb-4">
          <h1 className="text-lg font-semibold">Coding agents</h1>
          <p className="text-sm text-muted-foreground">
            Local status of Claude Code, Codex, and Cursor on this machine. Read from files on disk
            only — no network, no vendor API.
          </p>
        </header>

        {report.error ? (
          <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
            Could not read devtools status: {report.error}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {report.tools.map((t) => (
              <ToolCard key={t.tool} tool={t} />
            ))}
          </div>
        )}

        {report.generatedAt && !report.error ? (
          <p className="mt-4 text-xs text-muted-foreground">
            as of <FormattedDateTime iso={report.generatedAt} kind="timestamp" />
          </p>
        ) : null}
      </main>
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolStatus }) {
  if (!tool.installed) {
    return (
      <section className="rounded-lg border border-border bg-card p-4 opacity-70">
        <CardHeader tool={tool} />
        <p className="mt-2 text-sm text-muted-foreground">Not installed on this machine.</p>
      </section>
    );
  }
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <CardHeader tool={tool} />
      <dl className="mt-3 space-y-1.5 text-sm">
        {tool.account ? <Row label="Account" value={tool.account} /> : null}
        {tool.plan ? <Row label="Plan" value={tool.plan} /> : null}
        {tool.rateLimitTier ? <Row label="Rate tier" value={tool.rateLimitTier} /> : null}
        {tool.authExpiresAt ? (
          <Row label="Auth expires" value={<FormattedDateTime iso={tool.authExpiresAt} />} />
        ) : null}
        {tool.sessions != null ? <Row label="Sessions" value={String(tool.sessions)} /> : null}
        {tool.lastActivity ? (
          <Row label="Last active" value={<FormattedDateTime iso={tool.lastActivity} />} />
        ) : null}
        {tool.tokensUsed != null ? (
          <Row label="Tokens" value={tool.tokensUsed.toLocaleString()} />
        ) : null}
      </dl>

      {tool.quota?.length ? (
        <div className="mt-3 space-y-2">
          {tool.quota.map((q) => (
            <QuotaBar key={q.window} window={q.window} pct={q.usedPercent} resetsAt={q.resetsAt} />
          ))}
        </div>
      ) : null}

      {tool.notes.length ? (
        <ul className="mt-3 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
          {tool.notes.map((n) => (
            <li key={n}>· {n}</li>
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
  if (loggedIn === true)
    return (
      <span className="rounded-full bg-positive-soft px-2 py-0.5 text-xs font-medium text-positive">
        logged in
      </span>
    );
  if (loggedIn === false)
    return (
      <span className="rounded-full bg-negative-soft px-2 py-0.5 text-xs font-medium text-negative">
        logged out
      </span>
    );
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      unknown
    </span>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function QuotaBar({
  window,
  pct,
  resetsAt,
}: {
  window: string;
  pct: number | null;
  resetsAt: string | null;
}) {
  const clamped = pct != null ? Math.max(0, Math.min(100, pct)) : null;
  // Color grammar: green under load, amber past two-thirds, red past 90%.
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
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${barColor}`} style={{ width: `${clamped ?? 0}%` }} />
      </div>
      {resetsAt ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          resets <FormattedDateTime iso={resetsAt} kind="timestamp" />
        </p>
      ) : null}
    </div>
  );
}
