/**
 * Install state of the Claude Code plugin that applies the helper limit to
 * each helper's model request.
 *
 * The plugin is a personal, machine-wide thing, like the limit itself: it is
 * copied to one stable folder under the user config directory and loaded by
 * Claude Code through `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of each
 * Claude Code user settings file. Project settings cannot load a plugin this
 * way, and a path into one project's checkout would break when it moves.
 *
 * Signatures below are the contract between the plugin, the command and the
 * dashboard; the bodies are filled in by the plugin work.
 */

/** First Claude Code release whose model-request hook accepts a family name. */
export const HELPER_PLUGIN_MIN_CLAUDE_VERSION = "2.1.309";

export interface HelperPluginStatus {
  /** The plugin folder exists and at least one settings file loads it. */
  installed: boolean;
  /** Installed, current, and the local Claude Code is new enough. */
  active: boolean;
  /** Plain-words reason when `active` is false; null when active. */
  reason: string | null;
  /** The stable folder the plugin is copied to. */
  plugin_dir: string;
  /** Claude Code user settings files that load the plugin. */
  settings_files: string[];
  /** Local Claude Code version, or null when it could not be read. */
  claude_version: string | null;
  /** Version of this package the installed copy was built from, if installed. */
  plugin_version: string | null;
}

export interface HelperPluginChange {
  /** True when a file was written or removed. */
  changed: boolean;
  status: HelperPluginStatus;
  /** Plain sentences for the person, such as which settings file changed. */
  notes: string[];
}

export interface HelperPluginOptions {
  /** Override the user config base (tests). */
  configHome?: string;
  /** Override the Claude Code user settings files to manage (tests). */
  settingsFiles?: string[];
  /** Override how the local Claude Code version is read (tests). */
  claudeVersion?: () => string | null;
}

/** `~/.config/harnery/claude-code-plugin` (honors `XDG_CONFIG_HOME`). */
export function helperPluginDir(_options: HelperPluginOptions = {}): string {
  throw new Error("helperPluginDir: not implemented yet");
}

/** Read-only: is the plugin installed, current and usable. Never throws. */
export function helperPluginStatus(_options: HelperPluginOptions = {}): HelperPluginStatus {
  throw new Error("helperPluginStatus: not implemented yet");
}

/**
 * Install the plugin, or refresh a copy from an older version. Idempotent.
 * Changes only the plugin folder and the one `CLAUDE_CODE_PLUGIN_DIRS` entry in
 * each settings file's `env` block; every other setting is kept as it was.
 */
export function ensureHelperPlugin(_options: HelperPluginOptions = {}): HelperPluginChange {
  throw new Error("ensureHelperPlugin: not implemented yet");
}

/** Remove the plugin folder and its settings entries. Idempotent. */
export function removeHelperPlugin(_options: HelperPluginOptions = {}): HelperPluginChange {
  throw new Error("removeHelperPlugin: not implemented yet");
}
