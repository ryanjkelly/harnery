import { headers } from "next/headers";
import type * as React from "react";
import { AgentChip } from "@/components/AgentChip";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { Notice } from "@/components/layout/Notice";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import {
  ComputerModeControl,
  type ComputerModeOption,
} from "@/components/permissions/ComputerModeControl";
import {
  claudeBypasses,
  claudeSummary,
  codexSummary,
  codexWaitingHooks,
  computerAllowed,
  computerSummary,
  cursorSummary,
  sourceLabel,
} from "@/components/permissions/levels";
import { RuleList } from "@/components/permissions/RuleList";
import { ToolRow } from "@/components/permissions/ToolRow";
import { KeyValueList } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { hostInfo } from "@/lib/config";
import {
  BROWSER_ATTACH_MEANINGS,
  COMPUTER_MODE_LABELS,
  COMPUTER_MODES,
  CONFIRM_SECONDS,
  type ComputerStatus,
  computerModeLooser,
  isComputerMode,
  MEANINGS,
  type PermissionsReport,
  PROJECT_DEFAULT_CHOICE,
  readPermissionsPage,
  requestLocality,
  SIGN_IN_MEANINGS,
} from "@/lib/permissions";
import { TONE } from "@/lib/tone";

export const dynamic = "force-dynamic";

/** Settings that let an agent act with no limit at all: shown in amber. */
const WIDE_OPEN = new Set([
  "on",
  "bypassPermissions",
  "never",
  "danger-full-access",
  "run-everything",
]);

/** A setting in plain words, amber when it has no limit, with its raw value on hover. */
function Value({ raw, children }: { raw?: string; children: React.ReactNode }) {
  const text = (
    <span className={raw && WIDE_OPEN.has(raw) ? TONE.warn.text : undefined}>{children}</span>
  );
  return raw ? (
    <Tooltip content={`Setting: ${raw}`} triggerClassName="cursor-help">
      {text}
    </Tooltip>
  ) : (
    text
  );
}

function Code({ children }: { children: string }) {
  return (
    <code className="whitespace-nowrap rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
      {children}
    </code>
  );
}

const MODE_SOURCE: Record<string, string> = {
  project: "This is the project's default.",
  "user-project": "You chose this for this project.",
  "user-default": "You chose this for all your projects.",
};

// ------------------------------------------------------------ computer use

function modeOptions(status: ComputerStatus): ComputerModeOption[] {
  const current = isComputerMode(status.mode) ? status.mode : "off";
  return COMPUTER_MODES.map((mode) => ({
    value: mode,
    label: COMPUTER_MODE_LABELS[mode],
    meaning: MEANINGS.computerMode[mode] ?? "",
    looser: computerModeLooser(mode, current),
    projectDefault: mode === status.project_mode,
  }));
}

/** "Go back to the project's default", offered only after the person chose a mode for this project. */
function resetOption(status: ComputerStatus): ComputerModeOption | undefined {
  if (status.mode_source !== "user-project") return undefined;
  const current = isComputerMode(status.mode) ? status.mode : "off";
  const projectMode = isComputerMode(status.project_mode) ? status.project_mode : "off";
  return {
    value: PROJECT_DEFAULT_CHOICE,
    label: `Go back to the project's default (${COMPUTER_MODE_LABELS[projectMode]}).`,
    meaning:
      "Removes your choice for this project, so the project's default applies, or your choice for all your projects if you made one.",
    looser: computerModeLooser(projectMode, current),
  };
}

/** Where an off-by-default personal choice (sign-in, browser attach) comes from. */
const SIGN_IN_SOURCE: Record<string, string> = {
  default: "Off unless you turn it on.",
  "user-project": "You chose this for this project.",
  "user-default": "You chose this for all your projects.",
};

/**
 * Whether agents may sign in to websites for this person. Shown only where
 * the project allows it; off until the person turns it on.
 */
function SignInSetting({
  status,
  bin,
  local,
}: {
  status: ComputerStatus;
  bin: string;
  local: boolean;
}) {
  const on = status.sign_in === true;
  // The person's saved choice, which stays on while their own desktop mode is
  // off; they can still turn it off then, but not on.
  const saved = status.person_sign_in ?? on;
  const desktopOff = !computerAllowed(status) || status.mode === "off";
  const options: ComputerModeOption[] = [
    { value: "off", label: "Off", meaning: SIGN_IN_MEANINGS.off, looser: false },
    {
      value: "on",
      label: "On",
      meaning: SIGN_IN_MEANINGS.on,
      looser: !saved,
      ...(desktopOff ? { unavailable: "Turn computer use on first." } : {}),
    },
  ];
  return (
    <div className="space-y-1.5 border-t border-border pt-3">
      <p className="text-sm font-medium">Signing in to websites for you</p>
      <ComputerModeControl
        options={options}
        selected={saved ? "on" : "off"}
        reset={
          status.sign_in_source === "user-project"
            ? {
                value: PROJECT_DEFAULT_CHOICE,
                label: "Remove your choice for this project.",
                meaning:
                  "Your choice for all your projects applies if you made one; otherwise agent sign-in is off.",
                looser: false,
              }
            : undefined
        }
        disabledReason={
          local ? undefined : "This can be changed only from a browser on this computer."
        }
        confirmSeconds={CONFIRM_SECONDS}
        endpoint="/api/permissions/sign-in"
        field="sign_in"
        legend="Whether agents may sign in to websites for you in this project"
        keepWords="keeps it off"
      />
      <p className="text-xs text-muted-foreground">
        {desktopOff && saved
          ? "You turned this on, but it has no effect while your computer use is off; it comes back when you turn computer use on. Choose Off to remove it."
          : on
            ? SIGN_IN_MEANINGS.on
            : SIGN_IN_MEANINGS.off}{" "}
        {SIGN_IN_SOURCE[status.sign_in_source ?? "default"] ?? ""}
        {" Turning it on asks you to confirm in a pop-up on this computer's screen. Or run "}
        <Code>{`${bin} computer sign-in --help`}</Code>
        {"."}
      </p>
    </div>
  );
}

/**
 * Whether agents may attach to this person's running browser and work in its
 * tabs. Shown only where the project allows it; off until the person turns it
 * on. Separate from signing in.
 */
function BrowserAttachSetting({
  status,
  bin,
  local,
}: {
  status: ComputerStatus;
  bin: string;
  local: boolean;
}) {
  const on = status.browser_attach === true;
  // The person's saved choice, which stays on while their own desktop mode is
  // off; they can still turn it off then, but not on.
  const saved = status.person_browser_attach ?? on;
  const desktopOff = !computerAllowed(status) || status.mode === "off";
  const options: ComputerModeOption[] = [
    { value: "off", label: "Off", meaning: BROWSER_ATTACH_MEANINGS.off, looser: false },
    {
      value: "on",
      label: "On",
      meaning: BROWSER_ATTACH_MEANINGS.on,
      looser: !saved,
      ...(desktopOff ? { unavailable: "Turn computer use on first." } : {}),
    },
  ];
  return (
    <div className="space-y-1.5 border-t border-border pt-3">
      <p className="text-sm font-medium">Working in your browser tabs</p>
      <ComputerModeControl
        options={options}
        selected={saved ? "on" : "off"}
        reset={
          status.browser_attach_source === "user-project"
            ? {
                value: PROJECT_DEFAULT_CHOICE,
                label: "Remove your choice for this project.",
                meaning:
                  "Your choice for all your projects applies if you made one; otherwise working in your browser tabs is off.",
                looser: false,
              }
            : undefined
        }
        disabledReason={
          local ? undefined : "This can be changed only from a browser on this computer."
        }
        confirmSeconds={CONFIRM_SECONDS}
        endpoint="/api/permissions/browser-attach"
        field="browser_attach"
        legend="Whether agents may work in your running browser's tabs in this project"
        keepWords="keeps it off"
      />
      <p className="text-xs text-muted-foreground">
        {desktopOff && saved
          ? "You turned this on, but it has no effect while your computer use is off; it comes back when you turn computer use on. Choose Off to remove it."
          : on
            ? BROWSER_ATTACH_MEANINGS.on
            : BROWSER_ATTACH_MEANINGS.off}{" "}
        {SIGN_IN_SOURCE[status.browser_attach_source ?? "default"] ?? ""}
        {" Turning it on asks you to confirm in a pop-up on this computer's screen. Or run "}
        <Code>{`${bin} computer browser-attach --help`}</Code>
        {"."}
      </p>
    </div>
  );
}

function ComputerRow({
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
  const summary = computerSummary(status, error);
  if (!status) {
    return (
      <ToolRow
        id="computer"
        name="Computer use"
        summary={summary}
        change={
          <>
            {"Run "}
            <Code>{`${bin} computer status`}</Code>
            {" in a terminal for details."}
          </>
        }
      />
    );
  }
  const allowed = computerAllowed(status);
  const approvals = report?.desktopApprovals ?? [];
  const drivers = status.drivers
    .map((d) => {
      const state = !d.installed
        ? "not installed"
        : d.daemon
          ? d.daemon.running
            ? "running"
            : "stopped"
          : "installed";
      return `${d.id} ${d.version} (${state})`;
    })
    .join(", ");
  return (
    <ToolRow
      id="computer"
      name="Computer use"
      summary={summary}
      defaultOpen
      change={
        allowed ? (
          <>
            {"You can also ask your agent, or run "}
            <Code>{`${bin} computer mode --help`}</Code>
            {". Your mode applies to you, on this computer, for this project."}
          </>
        ) : (
          "The project's .harnery/config.jsonc decides whether agents may use the desktop at all."
        )
      }
    >
      {allowed ? (
        <div className="space-y-1.5">
          <ComputerModeControl
            options={modeOptions(status)}
            selected={isComputerMode(status.mode) ? status.mode : PROJECT_DEFAULT_CHOICE}
            reset={resetOption(status)}
            disabledReason={
              local ? undefined : "Your mode can be changed only from a browser on this computer."
            }
            confirmSeconds={CONFIRM_SECONDS}
          />
          <p className="text-xs text-muted-foreground">
            {MODE_SOURCE[status.mode_source] ?? ""}
            {" Loosening it asks you to confirm in a pop-up on this computer's screen."}
          </p>
        </div>
      ) : null}
      {status.project_sign_in ? <SignInSetting status={status} bin={bin} local={local} /> : null}
      {status.project_browser_attach ? (
        <BrowserAttachSetting status={status} bin={bin} local={local} />
      ) : null}
      <KeyValueList
        className="text-xs"
        items={[
          [
            "Using the desktop",
            status.lease?.owner_label ? (
              <AgentChip key="lease" name={status.lease.owner_label} />
            ) : (
              "Nobody right now."
            ),
          ],
          approvals.length > 0 && [
            "Approved",
            <ul key="approvals" className="space-y-0.5">
              {approvals.map((a) => (
                <li key={`${a.agent}:${a.grantedAt}`}>
                  <AgentChip name={a.agent} />
                  {`: ${a.purpose}. Ends `}
                  <FormattedDateTime iso={a.expiresAt} />
                </li>
              ))}
            </ul>,
          ],
          drivers.length > 0 && [
            "Drivers",
            <span key="drivers" className="font-mono">
              {drivers}
            </span>,
          ],
        ]}
      />
    </ToolRow>
  );
}

// ------------------------------------------------------------ Claude Code

function ClaudeRow({ report }: { report: PermissionsReport }) {
  const c = report.claude;
  const e = c.effective;
  const bypass = claudeBypasses(c);
  const errors = c.sources.filter((s) => s.error);
  const userSettings = c.sources.find((s) => s.scope === "user")?.path;
  return (
    <ToolRow
      id="claude"
      name="Claude Code"
      summary={claudeSummary(c)}
      change={
        <>
          {"To change this, ask your agent to edit "}
          <Code>.claude/settings.json</Code>
          {" (shared with everyone) or "}
          <Code>.claude/settings.local.json</Code>
          {" (this computer only), or use "}
          <Code>/permissions</Code>
          {" inside Claude Code."}
          {userSettings ? (
            <>
              {" Your own settings were read from "}
              <Code>{userSettings}</Code>
              {
                "; a Claude Code session started with a different CLAUDE_CONFIG_DIR uses that folder instead."
              }
            </>
          ) : null}
        </>
      }
    >
      <KeyValueList
        items={[
          [
            "Mode",
            <Value key="mode" raw={e.defaultMode}>
              {`${MEANINGS.claudeMode[e.defaultMode] ?? e.defaultMode} Set in ${sourceLabel(e.defaultModeSource)}.`}
            </Value>,
          ],
          [
            "Safeguards",
            `${e.sandboxEnabled ? "Commands run in Claude Code's sandbox." : "No command sandbox."}${e.bypassDisabled ? " Your organization's policy turns off the never-ask mode." : ""}`,
          ],
        ]}
      />
      <p className="text-xs text-muted-foreground">
        {bypass
          ? "Because Claude Code is set to never ask, the rules below do not apply right now. "
          : ""}
        {
          "A mode chosen when Claude Code starts (a launch flag or the desktop app's own setting) overrides these files and does not show here."
        }
      </p>
      <div className="space-y-2">
        <RuleList title="Allowed without asking" rules={e.allow} inactive={bypass} />
        <RuleList title="Always asks first" rules={e.ask} inactive={bypass} />
        <RuleList title="Never allowed" rules={e.deny} />
        <RuleList title="Folders outside the project it may use" rules={e.additionalDirectories} />
        {e.ask.length === 0 && e.deny.length === 0 ? (
          <p className="text-muted-foreground">
            {"No rules make it always ask first or block anything."}
          </p>
        ) : null}
      </div>
      {errors.length ? (
        <p className={TONE.danger.text}>
          {errors.map((s) => `Could not read ${s.path}: ${s.error}`).join(" ")}
        </p>
      ) : null}
    </ToolRow>
  );
}

// ------------------------------------------------------------------ Codex

function CodexRow({ report, bin }: { report: PermissionsReport; bin: string }) {
  const x = report.codex;
  if (!x.available) {
    return (
      <ToolRow
        id="codex"
        name="Codex"
        summary={codexSummary(x)}
        change={
          <>
            {"Run "}
            <Code>{`${bin} permissions`}</Code>
            {" in a terminal to retry."}
          </>
        }
      />
    );
  }
  const waiting = codexWaitingHooks(x);
  return (
    <ToolRow
      id="codex"
      name="Codex"
      summary={codexSummary(x)}
      change={
        <>
          {"To change this, ask your agent to edit "}
          <Code>~/.codex/config.toml</Code>
          {", or use Codex's settings. The project's setup refreshes hook approvals."}
        </>
      }
    >
      <KeyValueList
        items={[
          [
            "When it asks",
            x.approvalPolicy ? (
              <Value key="policy" raw={x.approvalPolicy}>
                {MEANINGS.codexPolicy[x.approvalPolicy] ?? x.approvalPolicy}
              </Value>
            ) : (
              "Codex's built-in default."
            ),
          ],
          [
            "What it may change",
            x.sandboxMode ? (
              <Value key="sandbox" raw={x.sandboxMode}>
                {MEANINGS.codexSandbox[x.sandboxMode] ?? x.sandboxMode}
              </Value>
            ) : (
              "Codex's built-in default."
            ),
          ],
          [
            "This project",
            x.projectTrust === "trusted"
              ? "Trusted, so Codex runs the project's hooks."
              : "Not trusted, so Codex ignores the project's hooks.",
          ],
          [
            "Hooks",
            x.hooks.length === 0 ? (
              "Codex lists no hooks for this project."
            ) : waiting.length === 0 ? (
              `All ${x.hooks.length} coordination hooks are approved.`
            ) : (
              <ul key="hooks" className="space-y-0.5">
                {waiting.map((h) => (
                  <li key={`${h.event}:${h.command ?? ""}`}>
                    <span className="font-mono text-xs">{h.event}</span>
                    <span
                      className={TONE.act.text}
                    >{` ${MEANINGS.codexHookTrust[h.trust] ?? h.trust}`}</span>
                  </li>
                ))}
              </ul>
            ),
          ],
        ]}
      />
    </ToolRow>
  );
}

// ----------------------------------------------------------------- Cursor

function CursorRow({ report }: { report: PermissionsReport }) {
  const c = report.cursor;
  const e = c.effective;
  const summary = cursorSummary(c);
  if (!c.sources.some((s) => s.exists)) {
    return (
      <ToolRow
        id="cursor"
        name="Cursor"
        summary={summary}
        change="Its settings appear here once Cursor's command-line agent has been used on this computer."
      />
    );
  }
  return (
    <ToolRow
      id="cursor"
      name="Cursor"
      summary={summary}
      change={
        <>
          {"To change this, ask your agent to edit "}
          <Code>~/.cursor/cli-config.json</Code>
          {", or use Cursor's settings."}
        </>
      }
    >
      <KeyValueList
        items={[
          [
            "Commands",
            e.approvalMode ? (
              <Value key="approval" raw={e.approvalMode}>
                {MEANINGS.cursorApproval[e.approvalMode] ?? e.approvalMode}
              </Value>
            ) : (
              "Cursor's built-in default."
            ),
          ],
          [
            "Sandbox",
            e.sandboxMode ? (
              <Value key="sandbox" raw={e.sandboxMode}>
                {MEANINGS.cursorSandbox[e.sandboxMode] ?? e.sandboxMode}
              </Value>
            ) : (
              "Cursor's built-in default."
            ),
          ],
        ]}
      />
      <div className="space-y-2">
        <RuleList title="Allowed without asking" rules={e.allow} />
        <RuleList title="Never allowed" rules={e.deny} />
      </div>
    </ToolRow>
  );
}

export default async function PermissionsPage() {
  const { permissions, permissionsError, computer, computerError } = await readPermissionsPage();
  const bin = hostInfo().binName;
  const local = requestLocality(await headers()).local;
  return (
    <PageShell width="narrow">
      <PageHeader
        title="Permissions"
        description={
          <>
            {
              "What each coding agent on this computer may do without asking you. Amber marks no limits. Open a row for details and how to change it."
            }
            {permissions ? (
              <span className="mt-1 block text-xs">
                {"Read "}
                <FormattedDateTime iso={permissions.generatedAt} />
              </span>
            ) : null}
          </>
        }
      />
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        <ComputerRow
          status={computer}
          error={computerError}
          report={permissions}
          bin={bin}
          local={local}
        />
        {permissions ? (
          <>
            <ClaudeRow report={permissions} />
            <CodexRow report={permissions} bin={bin} />
            <CursorRow report={permissions} />
          </>
        ) : null}
      </div>
      {permissions ? null : (
        <Notice tone="danger" className="mt-4">
          {`Could not read the coding tools' settings: ${permissionsError ?? "no answer"}`}
        </Notice>
      )}
    </PageShell>
  );
}
