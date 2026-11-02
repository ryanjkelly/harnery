import { headers } from "next/headers";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { NavBar } from "@/components/NavBar";
import {
  ComputerModeControl,
  type ComputerModeOption,
} from "@/components/permissions/ComputerModeControl";
import { Badge } from "@/components/ui/badge";
import { hostInfo } from "@/lib/config";
import { coordRoot } from "@/lib/coord-reader";
import {
  COMPUTER_MODE_LABELS,
  COMPUTER_MODES,
  CONFIRM_SECONDS,
  type ComputerModeChoice,
  type ComputerStatus,
  computerModeLooser,
  isComputerMode,
  MEANINGS,
  type PermissionsReport,
  PROJECT_DEFAULT_CHOICE,
  readPermissionsPage,
  requestLocality,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

/** Settings that let an agent act with no limit at all: worth a second look. */
const WIDE_OPEN = new Set([
  "on",
  "bypassPermissions",
  "never",
  "danger-full-access",
  "run-everything",
]);

function Setting({
  label,
  value,
  meaning,
  source,
}: {
  label: string;
  value: string;
  meaning?: string;
  source?: string;
}) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 py-2 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={WIDE_OPEN.has(value) ? "warning" : "outline"}
            className="font-mono text-[11px]"
          >
            {value}
          </Badge>
          {source ? (
            <span className="text-xs text-muted-foreground">{`from ${source}`}</span>
          ) : null}
        </div>
        {meaning ? <p className="mt-1 text-sm">{meaning}</p> : null}
      </div>
    </div>
  );
}

function Rules({
  title,
  rules,
  empty,
}: {
  title: string;
  rules: Array<{ rule: string; source: string }>;
  empty: string;
}) {
  return (
    <div className="py-2 text-sm">
      <div className="mb-1 text-muted-foreground">{title}</div>
      {rules.length === 0 ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {rules.map((r) => (
            <li key={`${r.source}:${r.rule}`} className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.rule}</code>
              <span className="text-xs text-muted-foreground">{r.source}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({
  title,
  summary,
  change,
  children,
}: {
  title: string;
  summary?: string;
  change: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {summary ? <p className="mt-1 text-sm text-muted-foreground">{summary}</p> : null}
      <div className="mt-2 divide-y divide-border">{children}</div>
      <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">{change}</p>
    </section>
  );
}

const MODE_SOURCE: Record<string, string> = {
  project: "the project's default",
  "user-project": "your own choice for this project",
  "user-default": "your own choice for all your projects",
};

/** The choices the page offers, with what each would mean for this person now. */
function modeOptions(status: ComputerStatus): ComputerModeOption[] {
  const current = isComputerMode(status.mode) ? status.mode : "off";
  const projectMode = isComputerMode(status.project_mode) ? status.project_mode : "off";
  const clearMeaning =
    status.mode_source === "user-default"
      ? `Make no separate choice for this project, so your choice for all your projects (${status.mode}) applies.`
      : status.mode_source === "user-project"
        ? `Remove your choice for this project, so the project's default (${projectMode}) applies, or your choice for all your projects if you made one.`
        : `Follow the project's default (${projectMode}).`;
  return [
    ...COMPUTER_MODES.map((mode) => ({
      value: mode as ComputerModeChoice,
      label: COMPUTER_MODE_LABELS[mode],
      meaning: MEANINGS.computerMode[mode] ?? "",
      looser: computerModeLooser(mode, current),
    })),
    {
      value: PROJECT_DEFAULT_CHOICE,
      label: "Use the default",
      meaning: clearMeaning,
      looser: status.mode_source === "user-project" && computerModeLooser(projectMode, current),
    },
  ];
}

function ComputerSection({
  status,
  error,
  report,
  bin,
  local,
}: {
  status?: ComputerStatus;
  error?: string;
  report?: PermissionsReport;
  bin: string;
  local: boolean;
}) {
  const approvals = report?.desktopApprovals ?? [];
  if (!status) {
    return (
      <Section title="Computer use" change={`Run \`${bin} computer status\` for details.`}>
        <p className="py-2 text-sm text-muted-foreground">{`Could not read the computer-use settings: ${error ?? "no answer"}`}</p>
      </Section>
    );
  }
  const yours = status.mode_source !== "project";
  const projectAllows = status.project_mode !== "off";
  const cliHint = `run \`${bin} computer mode <off | ask-each-task | ask-once-per-session | on>\` (or \`--clear\`)`;
  const change = !projectAllows
    ? `This project's own settings (.harnery/config.jsonc) decide whether agents may use the desktop at all; until it allows that, there is no personal mode to choose.`
    : local
      ? `Choose your own mode above, ask your agent (for example "set my computer-use mode to ask once per session"), or ${cliHint}. It applies to you on this computer, for this project. Loosening it shows you a confirmation pop-up first.`
      : `Your own mode can be changed only from a browser on this computer. There, choose it on this page, ask your agent, or ${cliHint}. Loosening it shows you a confirmation pop-up first.`;
  return (
    <Section
      title="Computer use (the screen, mouse and keyboard)"
      summary={
        projectAllows
          ? "Whether agents may use this computer's desktop, and how they ask."
          : "This project does not allow agents to use the desktop."
      }
      change={change}
    >
      <Setting
        label="Your mode"
        value={status.mode}
        meaning={MEANINGS.computerMode[status.mode]}
        source={MODE_SOURCE[status.mode_source] ?? status.mode_source}
      />
      {yours ? (
        <Setting
          label="Project default"
          value={status.project_mode}
          meaning={MEANINGS.computerMode[status.project_mode]}
        />
      ) : null}
      {projectAllows && local ? (
        <ComputerModeControl
          options={modeOptions(status)}
          selected={
            status.mode_source === "user-project" && isComputerMode(status.mode)
              ? status.mode
              : PROJECT_DEFAULT_CHOICE
          }
          confirmSeconds={CONFIRM_SECONDS}
        />
      ) : null}
      <div className="py-2 text-sm">
        <div className="mb-1 text-muted-foreground">Approvals in effect</div>
        {approvals.length === 0 ? (
          <p className="text-muted-foreground">
            None. No agent is currently approved to use the desktop.
          </p>
        ) : (
          <ul className="space-y-1">
            {approvals.map((a) => (
              <li key={`${a.agent}:${a.grantedAt}`}>
                <span className="font-medium">{`agent-${a.agent}`}</span>
                <span>{`: ${a.purpose}. Ends `}</span>
                <FormattedDateTime iso={a.expiresAt} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="py-2 text-sm">
        <div className="mb-1 text-muted-foreground">Using the desktop now</div>
        <p>{status.lease?.owner_label ? `agent-${status.lease.owner_label}` : "Nobody."}</p>
      </div>
      <div className="py-2 text-sm">
        <div className="mb-1 text-muted-foreground">Desktop drivers</div>
        <ul className="space-y-1">
          {status.drivers.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{`${d.id} ${d.version}`}</span>
              <Badge variant={d.installed ? "success" : "muted"} className="text-[10px]">
                {d.installed ? "installed" : "not installed"}
              </Badge>
              {d.daemon ? (
                <Badge variant={d.daemon.running ? "success" : "muted"} className="text-[10px]">
                  {d.daemon.running ? "running" : "stopped"}
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

function ClaudeSection({ report }: { report: PermissionsReport }) {
  const c = report.claude;
  const found = c.sources.filter((s) => s.exists);
  return (
    <Section
      title="Claude Code"
      summary={`Read from ${found.length ? found.map((s) => s.scope).join(", ") : "no settings file"}. Settings files cannot show a mode chosen when Claude was started (a launch flag or the desktop app's own permission setting), which wins over these.`}
      change="To change these, ask your agent to update the project's .claude/settings.json (shared with everyone) or .claude/settings.local.json (this computer only), or use /permissions inside Claude Code."
    >
      <Setting
        label="Permission mode"
        value={c.effective.defaultMode}
        meaning={MEANINGS.claudeMode[c.effective.defaultMode]}
        source={c.effective.defaultModeSource}
      />
      <Rules
        title="Allowed without asking"
        rules={c.effective.allow}
        empty="Nothing beyond Claude Code's built-in safe actions."
      />
      <Rules title="Always asks first" rules={c.effective.ask} empty="No extra rules." />
      <Rules title="Never allowed" rules={c.effective.deny} empty="No rules." />
      {c.effective.additionalDirectories.length ? (
        <Rules
          title="Folders outside the project it may use"
          rules={c.effective.additionalDirectories}
          empty=""
        />
      ) : null}
      <div className="py-2 text-sm">
        <div className="mb-1 text-muted-foreground">Safeguards</div>
        <p>
          {c.effective.sandboxEnabled
            ? "Commands run in Claude Code's sandbox."
            : "No command sandbox."}{" "}
          {c.effective.bypassDisabled ? "The no-questions-asked mode is turned off by policy." : ""}
        </p>
      </div>
      {c.sources.some((s) => s.error) ? (
        <p className="py-2 text-sm text-destructive">
          {c.sources
            .filter((s) => s.error)
            .map((s) => `Could not read ${s.path}: ${s.error}`)
            .join(" ")}
        </p>
      ) : null}
    </Section>
  );
}

function CodexSection({ report, bin }: { report: PermissionsReport; bin: string }) {
  const x = report.codex;
  if (!x.available) {
    return (
      <Section title="Codex" change={`Run \`${bin} permissions\` in a terminal to retry.`}>
        <p className="py-2 text-sm text-muted-foreground">{`Codex was not asked: ${x.error ?? "unavailable"}.`}</p>
      </Section>
    );
  }
  const waiting = x.hooks.filter((h) => h.trust === "untrusted" || h.trust === "modified");
  return (
    <Section
      title="Codex"
      summary="Codex's own answer for this project (its effective settings, not just the file)."
      change="To change these, ask your agent to update ~/.codex/config.toml, or use Codex's settings. Hook approvals are refreshed by the project's setup."
    >
      <Setting
        label="Asks before acting"
        value={x.approvalPolicy ?? "Codex default"}
        meaning={x.approvalPolicy ? MEANINGS.codexPolicy[x.approvalPolicy] : undefined}
      />
      <Setting
        label="Sandbox"
        value={x.sandboxMode ?? "Codex default"}
        meaning={x.sandboxMode ? MEANINGS.codexSandbox[x.sandboxMode] : undefined}
      />
      <Setting
        label="This project"
        value={x.projectTrust ?? "not trusted"}
        meaning={
          x.projectTrust === "trusted"
            ? "Codex treats this folder as trusted and runs its hooks."
            : "Codex has not been told to trust this folder, so it ignores the project's hooks."
        }
      />
      <div className="py-2 text-sm">
        <div className="mb-1 text-muted-foreground">Coordination hooks</div>
        {x.hooks.length === 0 ? (
          <p className="text-muted-foreground">Codex lists no hooks for this project.</p>
        ) : waiting.length === 0 ? (
          <p>{`All ${x.hooks.length} hooks are approved.`}</p>
        ) : (
          <ul className="space-y-1">
            {waiting.map((h) => (
              <li
                key={`${h.event}:${h.command ?? ""}`}
                className="flex flex-wrap items-center gap-2"
              >
                <Badge variant="info" className="text-[10px]">
                  {MEANINGS.codexHookTrust[h.trust] ?? h.trust}
                </Badge>
                <span className="font-mono text-xs">{h.event}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function CursorSection({ report }: { report: PermissionsReport }) {
  const c = report.cursor;
  if (!c.sources.some((s) => s.exists)) {
    return (
      <Section
        title="Cursor"
        change="Cursor's settings appear here once its CLI has been used on this computer."
      >
        <p className="py-2 text-sm text-muted-foreground">No Cursor settings on this computer.</p>
      </Section>
    );
  }
  return (
    <Section
      title="Cursor"
      summary="Cursor's command-line agent, which also runs peer reviews."
      change="To change these, ask your agent to update ~/.cursor/cli-config.json, or use Cursor's settings."
    >
      <Setting
        label="Running commands"
        value={c.effective.approvalMode ?? "Cursor default"}
        meaning={
          c.effective.approvalMode ? MEANINGS.cursorApproval[c.effective.approvalMode] : undefined
        }
      />
      <Setting
        label="Sandbox"
        value={c.effective.sandboxMode ?? "Cursor default"}
        meaning={
          c.effective.sandboxMode ? MEANINGS.cursorSandbox[c.effective.sandboxMode] : undefined
        }
      />
      <Rules title="Allowed without asking" rules={c.effective.allow} empty="No rules." />
      <Rules title="Never allowed" rules={c.effective.deny} empty="No rules." />
    </Section>
  );
}

export default async function PermissionsPage() {
  const { permissions, permissionsError, computer, computerError } = await readPermissionsPage();
  const bin = hostInfo().binName;
  const local = requestLocality(await headers()).local;
  return (
    <div>
      <NavBar scannedDir={coordRoot()} />
      <main className="mx-auto max-w-4xl px-4 py-6">
        <header className="mb-5">
          <h1 className="text-lg font-semibold">Permissions</h1>
          <p className="text-sm text-muted-foreground">
            {
              "What the coding agents on this computer are allowed to do, read from each tool's own settings. The one thing you can change here is your own computer-use mode, and only from a browser on this computer; each other section says how to change it. Amber marks a setting with no limits."
            }
          </p>
          {permissions ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {"Read "}
              <FormattedDateTime iso={permissions.generatedAt} />
            </p>
          ) : null}
        </header>
        <div className="space-y-4">
          <ComputerSection
            status={computer}
            error={computerError}
            report={permissions}
            bin={bin}
            local={local}
          />
          {permissions ? (
            <>
              <ClaudeSection report={permissions} />
              <CodexSection report={permissions} bin={bin} />
              <CursorSection report={permissions} />
            </>
          ) : (
            <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
              {`Could not read the coding tools' settings: ${permissionsError ?? "no answer"}`}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
