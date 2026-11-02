/**
 * Data and plain-English wording for the Permissions page: what the coding
 * agents on this computer may do. Read through `harn permissions --json` and
 * `harn computer status --json`, so the page shows what the CLI reports.
 */

import type { PermissionsReport } from "../../src/core/permissions";
import { runHarn } from "./run-harn";

export type { PermissionsReport };

export interface ComputerStatus {
  enabled: boolean;
  mode: string;
  project_mode: string;
  mode_source: string;
  config_error?: string;
  host: { kind: string; reason?: string; note?: string };
  default_driver: string | null;
  drivers: Array<{
    id: string;
    version: string;
    summary: string;
    installed: string | null;
    daemon: { running: boolean; detail?: string } | null;
  }>;
  lease: {
    owner_label?: string;
    owner_id?: string;
    acquired_at?: string;
    expires_at?: string;
  } | null;
}

/** The line that says what went wrong, not Node's closing version banner or a stack frame. */
function errorLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Node\.js v\d/.test(l) && !/^at /.test(l));
  return lines.find((l) => /error/i.test(l)) ?? lines.pop() ?? "";
}

async function json<T>(args: string[], timeoutMs: number): Promise<{ value?: T; error?: string }> {
  const result = await runHarn(args, { timeoutMs });
  try {
    return { value: JSON.parse(result.stdout) as T };
  } catch {
    return { error: errorLine(result.stderr) || `harn ${args.join(" ")} gave no answer` };
  }
}

export async function readPermissionsPage(): Promise<{
  permissions?: PermissionsReport;
  permissionsError?: string;
  computer?: ComputerStatus;
  computerError?: string;
}> {
  const [permissions, computer] = await Promise.all([
    json<PermissionsReport>(["permissions", "--json"], 45_000),
    json<ComputerStatus>(["computer", "status", "--json"], 30_000),
  ]);
  return {
    permissions: permissions.value,
    permissionsError: permissions.error,
    computer: computer.value,
    computerError: computer.error,
  };
}

/** What each setting value means for the person, in one sentence. */
export const MEANINGS = {
  computerMode: {
    off: "Agents cannot use this computer's screen, mouse or keyboard.",
    "ask-each-task":
      "An agent asks you with a Yes/No pop-up before each task on the screen; the approval ends with the task.",
    "ask-once-per-session":
      "An agent asks you once; that approval lasts for the rest of its session.",
    on: "Agents use the screen without asking.",
  } as Record<string, string>,
  claudeMode: {
    default:
      "Claude Code asks before editing files or running commands that are not on its allowed list.",
    acceptEdits:
      "Claude Code edits files without asking, and asks before running commands not on its allowed list.",
    plan: "Claude Code only plans; it does not edit files or run commands until you approve the plan.",
    auto: "Claude Code decides for itself which steps need your approval.",
    dontAsk: "Claude Code never asks; anything not on its allowed list is refused.",
    bypassPermissions: "Claude Code does everything without asking.",
  } as Record<string, string>,
  codexPolicy: {
    untrusted: "Codex asks before running any command it does not consider safe.",
    "on-request": "Codex decides when to ask you.",
    "on-failure": "Codex asks only when a command fails inside its sandbox.",
    never: "Codex never asks.",
  } as Record<string, string>,
  codexSandbox: {
    "read-only": "Codex can read files but not change them.",
    "workspace-write": "Codex can change files inside the project only.",
    "danger-full-access": "Codex can change any file and use the network, with no sandbox.",
  } as Record<string, string>,
  codexHookTrust: {
    trusted: "approved",
    untrusted: "waiting for approval",
    modified: "changed since it was approved",
    managed: "set by an administrator",
  } as Record<string, string>,
  cursorApproval: {
    allowlist: "Cursor runs commands on its allowed list and asks about the rest.",
    "run-everything": "Cursor runs every command without asking.",
  } as Record<string, string>,
  cursorSandbox: {
    disabled: "Cursor's commands run without a sandbox.",
    enabled: "Cursor's commands run in a sandbox.",
  } as Record<string, string>,
};
