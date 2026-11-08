/**
 * One plain-English line per coding tool for the Permissions page: how much
 * it may do without asking, as a short level and a sentence. Amber (`warn`)
 * marks a tool with no limits, `danger` a tool whose settings could not be
 * read, and everything else stays neutral.
 */

import type { ComputerStatus, PermissionsReport } from "@/lib/permissions";
import { MEANINGS } from "@/lib/permissions";
import type { Tone } from "@/lib/tone";

export interface ToolSummary {
  /** Short level shown as a badge ("No limits", "Asks first"). */
  level: string;
  tone: Tone;
  /** One sentence answering "what can it do without asking you?". */
  sentence: string;
  /** The raw setting values behind the level, for a tooltip. */
  raw?: string;
}

/** Plain names for the places a setting can come from. */
const SOURCE_LABELS: Record<string, string> = {
  user: "your user settings (all projects)",
  project: "this project's settings",
  "project (shared)": "this project's shared settings",
  "project (this computer)": "this project's settings on this computer only",
  "managed policy": "your organization's policy",
  "Claude Code's default": "Claude Code's built-in default",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ------------------------------------------------------------ computer use

const COMPUTER_LEVELS: Record<string, { level: string; tone: Tone }> = {
  off: { level: "Off", tone: "neutral" },
  "ask-each-task": { level: "Asks each task", tone: "neutral" },
  "ask-once-per-session": { level: "Asks once", tone: "neutral" },
  on: { level: "No limits", tone: "warn" },
};

/** Whether the project lets agents use the desktop at all. */
export function computerAllowed(status: ComputerStatus): boolean {
  return status.enabled !== false && status.project_mode !== "off";
}

export function computerSummary(status?: ComputerStatus, error?: string): ToolSummary {
  if (!status) {
    return {
      level: "Not read",
      tone: "danger",
      sentence: `Could not read the computer-use settings: ${error ?? "no answer"}.`,
    };
  }
  if (!computerAllowed(status)) {
    return {
      level: "Off",
      tone: "neutral",
      sentence: "This project does not let agents use the screen, mouse or keyboard.",
      raw: `mode: ${status.mode}, project default: ${status.project_mode}`,
    };
  }
  const known = COMPUTER_LEVELS[status.mode];
  return {
    level: known?.level ?? status.mode,
    tone: known?.tone ?? "neutral",
    sentence: `${MEANINGS.computerMode[status.mode] ?? `Mode: ${status.mode}.`}${status.sign_in ? " Agents may also sign in to websites for you." : ""}`,
    raw: `mode: ${status.mode} (from ${status.mode_source}), project default: ${status.project_mode}${status.project_sign_in ? `, sign-in: ${status.sign_in ? "on" : "off"}` : ""}`,
  };
}

// ------------------------------------------------------------ Claude Code

/** True when Claude Code skips every permission check right now. */
export function claudeBypasses(c: PermissionsReport["claude"]): boolean {
  return c.effective.defaultMode === "bypassPermissions" && !c.effective.bypassDisabled;
}

export function claudeSummary(c: PermissionsReport["claude"]): ToolSummary {
  const mode = c.effective.defaultMode;
  const allowed = count(c.effective.allow.length, "allowed action");
  const raw = `defaultMode: ${mode}, from ${sourceLabel(c.effective.defaultModeSource)}`;
  if (mode === "bypassPermissions" && c.effective.bypassDisabled) {
    return {
      level: "Asks first",
      tone: "neutral",
      sentence:
        "It is set to never ask, but your organization's policy turns that off, so it asks as usual.",
      raw,
    };
  }
  const byMode: Record<string, Omit<ToolSummary, "raw">> = {
    bypassPermissions: {
      level: "No limits",
      tone: "warn",
      sentence: "Does everything without asking.",
    },
    default: {
      level: "Asks first",
      tone: "neutral",
      sentence: `Asks before editing files or running commands, except its ${allowed}.`,
    },
    acceptEdits: {
      level: "Edits freely",
      tone: "neutral",
      sentence: `Edits files without asking, and asks before commands other than its ${allowed}.`,
    },
    plan: {
      level: "Plans only",
      tone: "neutral",
      sentence: "Only plans; it changes nothing until you approve the plan.",
    },
    auto: {
      level: "Decides itself",
      tone: "neutral",
      sentence: "Decides for itself which steps need your approval.",
    },
    dontAsk: {
      level: "Allowed list only",
      tone: "neutral",
      sentence: `Never asks: it does its ${allowed} and refuses everything else.`,
    },
  };
  const known = byMode[mode];
  return known
    ? { ...known, raw }
    : { level: mode, tone: "neutral", sentence: MEANINGS.claudeMode[mode] ?? "", raw };
}

// ------------------------------------------------------------------ Codex

const CODEX_POLICY: Record<string, { level: string; sentence: string }> = {
  untrusted: {
    level: "Asks first",
    sentence: "Asks before any command it does not consider safe.",
  },
  "on-request": { level: "Decides itself", sentence: "Decides for itself when to ask you." },
  "on-failure": {
    level: "Asks on failure",
    sentence: "Asks only when a command fails inside its sandbox.",
  },
  never: { level: "Never asks", sentence: "Never asks." },
};

const CODEX_SANDBOX: Record<string, string> = {
  "read-only": "It can read files but not change them.",
  "workspace-write": "It can change files inside the project only.",
  "danger-full-access": "It can change any file and use the network.",
};

export function codexSummary(x: PermissionsReport["codex"]): ToolSummary {
  if (!x.available) {
    return {
      level: "Not read",
      tone: "danger",
      sentence: `Codex could not be asked: ${x.error ?? "unavailable"}.`,
    };
  }
  const raw = `approval_policy: ${x.approvalPolicy ?? "(Codex default)"}, sandbox_mode: ${x.sandboxMode ?? "(Codex default)"}`;
  const neverAsks = x.approvalPolicy === "never";
  const noSandbox = x.sandboxMode === "danger-full-access";
  if (!x.approvalPolicy && !x.sandboxMode) {
    return {
      level: "Default",
      tone: "neutral",
      sentence: "Uses Codex's built-in defaults for when to ask and what it may change.",
      raw,
    };
  }
  if (neverAsks && noSandbox) {
    return {
      level: "No limits",
      tone: "warn",
      sentence: "Never asks, and can change any file and use the network.",
      raw,
    };
  }
  const policy = x.approvalPolicy ? CODEX_POLICY[x.approvalPolicy] : undefined;
  const sentence = [
    policy?.sentence ?? (x.approvalPolicy ? `Approval policy: ${x.approvalPolicy}.` : ""),
    x.sandboxMode ? (CODEX_SANDBOX[x.sandboxMode] ?? `Sandbox: ${x.sandboxMode}.`) : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    level: noSandbox ? "No sandbox" : (policy?.level ?? "Codex default"),
    tone: neverAsks || noSandbox ? "warn" : "neutral",
    sentence,
    raw,
  };
}

/** Codex hooks that still need the person's approval. */
export function codexWaitingHooks(x: PermissionsReport["codex"]) {
  return x.hooks.filter((h) => h.trust === "untrusted" || h.trust === "modified");
}

// ----------------------------------------------------------------- Cursor

export function cursorSummary(c: PermissionsReport["cursor"]): ToolSummary {
  if (!c.sources.some((s) => s.exists)) {
    return {
      level: "Not set up",
      tone: "neutral",
      sentence: "Cursor's command-line agent has no settings on this computer.",
    };
  }
  const mode = c.effective.approvalMode;
  const raw = `approvalMode: ${mode ?? "(Cursor default)"}, sandbox: ${c.effective.sandboxMode ?? "(Cursor default)"}`;
  if (mode === "run-everything") {
    return {
      level: "No limits",
      tone: "warn",
      sentence: "Runs every command without asking.",
      raw,
    };
  }
  if (mode === "allowlist") {
    return {
      level: "Asks first",
      tone: "neutral",
      sentence: `Runs ${c.effective.allow.length === 1 ? "the one command" : `the ${c.effective.allow.length} commands`} on its allowed list and asks about the rest.`,
      raw,
    };
  }
  return {
    level: mode ?? "Default",
    tone: "neutral",
    sentence: mode
      ? (MEANINGS.cursorApproval[mode] ?? "")
      : "Uses Cursor's built-in defaults for running commands.",
    raw,
  };
}
