/**
 * Canonical hook-wiring spec per adapter: which settings file to write, which
 * event key maps to which `agent-hook <subcommand>`, and how each adapter encodes
 * a command hook. Single source of truth for `harn init` (and any future docs /
 * installers) so the wired set can't drift from what agent-hook actually handles.
 *
 * The event lists + entry shapes mirror exactly what a fully-wired project uses
 * for each adapter (Claude Code `.claude/settings.json`, Cursor `.cursor/hooks.json`,
 * Codex `.codex/hooks.json`).
 */

export type { Adapter as AdapterId } from "../events/schema.ts";

import type { Adapter as AdapterId } from "../events/schema.ts";

export interface HookEvent {
  /** Key under the adapter settings file's `hooks` map (e.g. `SessionStart`, `preToolUse`). */
  settingsKey: string;
  /** agent-hook subcommand to invoke for this event. */
  subcommand: string;
}

/**
 * How a adapter encodes a single command hook under `hooks.<settingsKey>`:
 * - `claude`: `[{ hooks: [{ type: "command", command }] }]` (Claude Code + Codex)
 * - `cursor`: `[{ command }]` (Cursor: flat entry, no inner `hooks` array)
 */
export type HookEntryShape = "claude" | "cursor";

export interface AdapterSpec {
  /** Settings file to wire, relative to the project root. */
  settingsFile: string;
  /** Events this adapter fires, mapped to agent-hook subcommands. */
  events: HookEvent[];
  /** Per-entry encoding under the root `hooks` object. */
  entryShape: HookEntryShape;
  /** When set, ensure this top-level `version` key in the file (Cursor requires `1`). */
  rootVersion?: number;
  /** Adapter-owned entries from older specs that `init` should remove during migration. */
  legacyEvents?: HookEvent[];
  /** Strict top-level settings keys accepted by this adapter, when its parser is closed. */
  allowedTopLevelKeys?: string[];
  /** Strict hook event keys accepted by this adapter, including events harnery does not wire. */
  allowedEventKeys?: string[];
  /**
   * Env var the adapter exports to hook processes carrying the project root
   * (e.g. Claude Code's CLAUDE_PROJECT_DIR). When set, `init` anchors the
   * agent-hook path on it so the hook still spawns when the process cwd has
   * wandered (the session shell `cd`ing into a subdirectory or off-repo).
   */
  projectDirEnv?: string;
}

/** Claude Code: `.claude/settings.json`. */
export const CLAUDE_CODE_EVENTS: HookEvent[] = [
  { settingsKey: "SessionStart", subcommand: "session-start" },
  { settingsKey: "UserPromptSubmit", subcommand: "user-prompt-submit" },
  { settingsKey: "Stop", subcommand: "stop" },
  { settingsKey: "StopFailure", subcommand: "stop-failure" },
  { settingsKey: "SessionEnd", subcommand: "session-end" },
  { settingsKey: "SubagentStart", subcommand: "sub-agent-start" },
  { settingsKey: "SubagentStop", subcommand: "sub-agent-stop" },
  { settingsKey: "PreToolUse", subcommand: "pre-tool-use" },
  { settingsKey: "PostToolUse", subcommand: "post-tool-use" },
  { settingsKey: "PostToolUseFailure", subcommand: "post-tool-use-failure" },
  { settingsKey: "PreCompact", subcommand: "pre-compact" },
];

/**
 * Cursor: `.cursor/hooks.json`. camelCase event keys; flat `{ command }` entries;
 * no `StopFailure` event, but a distinct `beforeShellExecution` (shell-mutation warn).
 */
export const CURSOR_EVENTS: HookEvent[] = [
  { settingsKey: "sessionStart", subcommand: "session-start" },
  { settingsKey: "sessionEnd", subcommand: "session-end" },
  { settingsKey: "preToolUse", subcommand: "pre-tool-use" },
  { settingsKey: "beforeShellExecution", subcommand: "before-shell-execution" },
  { settingsKey: "postToolUse", subcommand: "post-tool-use" },
  { settingsKey: "postToolUseFailure", subcommand: "post-tool-use-failure" },
  { settingsKey: "subagentStart", subcommand: "sub-agent-start" },
  { settingsKey: "subagentStop", subcommand: "sub-agent-stop" },
  { settingsKey: "beforeSubmitPrompt", subcommand: "user-prompt-submit" },
  { settingsKey: "stop", subcommand: "stop" },
];

/** Codex events that harnery uses from the current native lifecycle surface. */
export const CODEX_EVENTS: HookEvent[] = [
  { settingsKey: "SessionStart", subcommand: "session-start" },
  { settingsKey: "PreToolUse", subcommand: "pre-tool-use" },
  { settingsKey: "PostToolUse", subcommand: "post-tool-use" },
  { settingsKey: "UserPromptSubmit", subcommand: "user-prompt-submit" },
  { settingsKey: "SubagentStart", subcommand: "sub-agent-start" },
  { settingsKey: "SubagentStop", subcommand: "sub-agent-stop" },
  { settingsKey: "PreCompact", subcommand: "pre-compact" },
  { settingsKey: "PostCompact", subcommand: "post-compact" },
  { settingsKey: "Stop", subcommand: "stop" },
];

/** Entries written by harnery before Codex adopted a strict native hook schema. */
export const LEGACY_CODEX_EVENTS: HookEvent[] = [
  { settingsKey: "SessionEnd", subcommand: "session-end" },
  { settingsKey: "PostToolUseFailure", subcommand: "post-tool-use-failure" },
  { settingsKey: "StopFailure", subcommand: "stop-failure" },
];

/** Every hook key accepted by Codex 0.144, including events harnery does not consume. */
export const CODEX_ALLOWED_EVENT_KEYS = [
  "SessionStart",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
];

/** Every supported adapter, fully wireable by `harn init`. */
export const ADAPTER_SPECS: Record<AdapterId, AdapterSpec> = {
  "claude-code": {
    settingsFile: ".claude/settings.json",
    events: CLAUDE_CODE_EVENTS,
    entryShape: "claude",
    projectDirEnv: "CLAUDE_PROJECT_DIR",
  },
  cursor: {
    settingsFile: ".cursor/hooks.json",
    events: CURSOR_EVENTS,
    entryShape: "cursor",
    rootVersion: 1,
  },
  codex: {
    settingsFile: ".codex/hooks.json",
    events: CODEX_EVENTS,
    entryShape: "claude",
    legacyEvents: LEGACY_CODEX_EVENTS,
    allowedTopLevelKeys: ["description", "hooks"],
    allowedEventKeys: CODEX_ALLOWED_EVENT_KEYS,
  },
};
