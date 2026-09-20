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

export type { Adapter as AdapterId } from "../../adapter.ts";

import type { Adapter as AdapterId } from "../../adapter.ts";

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

/**
 * How `harn init` installs this adapter's lifecycle capture:
 * - `settings-hooks` (default): merge `agent-hook <subcommand>` command hooks
 *   into a settings file's `hooks` map (Claude Code, Codex, Cursor).
 * - `opencode-plugin`: OpenCode V2 has no command-hook file; interception is an
 *   in-process plugin. `init` installs a Harnery plugin and registers it in
 *   `opencode.json` `plugins`, and wiring inspection checks that registration
 *   rather than a `hooks` map. The plugin bridges each lifecycle hook to
 *   `agent-hook <subcommand> --adapter opencode`, so `events` still names the
 *   subcommands it delivers.
 */
export type AdapterInstallMode = "settings-hooks" | "opencode-plugin";

export interface AdapterSpec {
  /** Settings file to wire, relative to the project root. */
  settingsFile: string;
  /** Events this adapter fires, mapped to agent-hook subcommands. */
  events: HookEvent[];
  /** Per-entry encoding under the root `hooks` object. */
  entryShape: HookEntryShape;
  /** Install mechanism; absent means the default settings-file command hooks. */
  installMode?: AdapterInstallMode;
  /** For `opencode-plugin`: the plugin identifier registered in `plugins`. */
  pluginId?: string;
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
  { settingsKey: "PermissionRequest", subcommand: "permission-request" },
  { settingsKey: "Stop", subcommand: "stop" },
  { settingsKey: "StopFailure", subcommand: "stop-failure" },
  { settingsKey: "SessionEnd", subcommand: "session-end" },
  { settingsKey: "SubagentStart", subcommand: "sub-agent-start" },
  { settingsKey: "SubagentStop", subcommand: "sub-agent-stop" },
  { settingsKey: "PreToolUse", subcommand: "pre-tool-use" },
  { settingsKey: "PostToolUse", subcommand: "post-tool-use" },
  { settingsKey: "PostToolUseFailure", subcommand: "post-tool-use-failure" },
  { settingsKey: "PreCompact", subcommand: "pre-compact" },
  { settingsKey: "PostCompact", subcommand: "post-compact" },
];

/**
 * Cursor: `.cursor/hooks.json`. camelCase event keys; flat `{ command }` entries;
 * no `StopFailure` event. Generic tool hooks remain useful in the IDE, while
 * shell-specific hooks are also installed because remote/CLI modes do not
 * dispatch generic tool hooks consistently. V3 deduplicates overlapping shell
 * deliveries by a private command fingerprint.
 */
export const CURSOR_EVENTS: HookEvent[] = [
  { settingsKey: "sessionStart", subcommand: "session-start" },
  { settingsKey: "sessionEnd", subcommand: "session-end" },
  { settingsKey: "preToolUse", subcommand: "pre-tool-use" },
  { settingsKey: "postToolUse", subcommand: "post-tool-use" },
  { settingsKey: "postToolUseFailure", subcommand: "post-tool-use-failure" },
  { settingsKey: "beforeShellExecution", subcommand: "before-shell-execution" },
  { settingsKey: "afterShellExecution", subcommand: "after-shell-execution" },
  { settingsKey: "subagentStart", subcommand: "sub-agent-start" },
  { settingsKey: "subagentStop", subcommand: "sub-agent-stop" },
  { settingsKey: "beforeSubmitPrompt", subcommand: "user-prompt-submit" },
  { settingsKey: "afterAgentResponse", subcommand: "after-agent-response" },
  { settingsKey: "preCompact", subcommand: "pre-compact" },
  { settingsKey: "stop", subcommand: "stop" },
];

/** Codex events that harnery uses from the current native lifecycle surface. */
export const CODEX_EVENTS: HookEvent[] = [
  { settingsKey: "SessionStart", subcommand: "session-start" },
  { settingsKey: "PreToolUse", subcommand: "pre-tool-use" },
  { settingsKey: "PermissionRequest", subcommand: "permission-request" },
  { settingsKey: "PostToolUse", subcommand: "post-tool-use" },
  { settingsKey: "UserPromptSubmit", subcommand: "user-prompt-submit" },
  { settingsKey: "SubagentStart", subcommand: "sub-agent-start" },
  { settingsKey: "SubagentStop", subcommand: "sub-agent-stop" },
  { settingsKey: "PreCompact", subcommand: "pre-compact" },
  { settingsKey: "PostCompact", subcommand: "post-compact" },
  { settingsKey: "Stop", subcommand: "stop" },
  { settingsKey: "SessionEnd", subcommand: "session-end" },
];

/** Entries written by harnery before Codex adopted a strict native hook schema. */
export const LEGACY_CODEX_EVENTS: HookEvent[] = [
  { settingsKey: "PostToolUseFailure", subcommand: "post-tool-use-failure" },
  { settingsKey: "StopFailure", subcommand: "stop-failure" },
];

/**
 * OpenCode V2: delivered by the Harnery OpenCode plugin, which registers
 * in-process hooks and bridges each to `agent-hook <subcommand> --adapter
 * opencode`. There is no settings-file `hooks` map; `settingsKey` here is the
 * originating OpenCode plugin hook, kept for documentation. `post-compact` is
 * omitted because OpenCode post-compaction recovery is not yet certified.
 */
export const OPENCODE_EVENTS: HookEvent[] = [
  { settingsKey: "session.created", subcommand: "session-start" },
  { settingsKey: "session.hook:prompt", subcommand: "user-prompt-submit" },
  { settingsKey: "tool.hook:execute.before", subcommand: "pre-tool-use" },
  { settingsKey: "tool.hook:execute.after", subcommand: "post-tool-use" },
  { settingsKey: "tool.hook:execute.after:error", subcommand: "post-tool-use-failure" },
  { settingsKey: "permission.hook:evaluate", subcommand: "permission-request" },
  { settingsKey: "event:session.created:child", subcommand: "sub-agent-start" },
  { settingsKey: "event:session.execution.succeeded:child", subcommand: "sub-agent-stop" },
  { settingsKey: "event:session.execution.succeeded", subcommand: "stop" },
  { settingsKey: "event:session.deleted", subcommand: "session-end" },
  { settingsKey: "session.hook:compaction", subcommand: "pre-compact" },
];

/** Every hook key accepted by Codex's current native hook schema. */
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
  "SessionEnd",
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
  opencode: {
    settingsFile: "opencode.json",
    events: OPENCODE_EVENTS,
    // entryShape is unused for the plugin install mode but required by the type;
    // the plugin, not a hooks-map entry, carries the wiring.
    entryShape: "claude",
    installMode: "opencode-plugin",
    pluginId: "@harnery/opencode",
  },
};
