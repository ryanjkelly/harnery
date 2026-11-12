import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { BUILTIN_ADAPTER_PROFILES } from "../core/adapters/profiles.ts";
import { resolveBinName } from "../core/config.ts";
import { type HelperLimit, helperLadders, parseHelperLimitWords } from "../core/helper-limit.ts";
import {
  type BuildHelperLimitReportOptions,
  buildHelperLimitReport,
  HELPER_LIMIT_TOOL,
  type HelperLimitReport,
  helperLimitPhrase,
  safeHelperPluginStatus,
} from "../core/helper-limit-report.ts";
import {
  ensureHelperPlugin,
  type HelperPluginChange,
  type HelperPluginStatus,
  helperPluginStatus,
  removeHelperPlugin,
} from "../core/helper-plugin.ts";
import { preferencesPath, writeHelperLimit } from "../core/preferences.ts";

/**
 * `devtools helpers`: show or set the helper limit for Claude Code helper
 * agents and run workers. The limit is the person's own choice for all their
 * projects; a project may commit a default in `.harnery/config.jsonc`.
 */

/** Everything that touches the machine, replaceable for tests. */
export interface HelperCommandDeps {
  preferencesPath?: string;
  usageDir?: string;
  coordRoot?: string | null;
  now?: () => Date;
  pluginStatus?: () => HelperPluginStatus;
  ensurePlugin?: () => HelperPluginChange;
  removePlugin?: () => HelperPluginChange;
}

interface HelpersOpts {
  format: string;
  clear?: boolean;
  install?: boolean;
  uninstall?: boolean;
}

export function registerHelpersCommand(
  parent: Command,
  emit: EmitContext,
  deps: HelperCommandDeps = {},
): void {
  parent
    .command("helpers [words...]")
    .description(
      "Show or set the helper limit for Claude Code (e.g. `opus medium`, `sonnet`, `none`)",
    )
    .option("--clear", "Remove your choice so the project default applies")
    .option("--install", "Install or refresh the Claude Code plugin that applies the limit")
    .option("--uninstall", "Remove the Claude Code plugin")
    .option("--format <type>", "Output format: table, json", "table")
    .action((words: string[] = [], opts: HelpersOpts, command: Command) => {
      runHelpers(
        words,
        { ...opts, format: resolveFormat(command) },
        emit,
        deps,
        commandLine(command),
      );
    });
}

/**
 * `devtools` itself takes `--format`, and Commander hands a `--format` typed
 * after `helpers` to that parent option. Prefer whichever one was typed.
 */
function resolveFormat(command: Command): string {
  if (command.getOptionValueSource("format") === "cli") return command.opts().format;
  const parent = command.parent;
  if (parent?.getOptionValueSource("format") === "cli") return parent.opts().format;
  return command.opts().format ?? "table";
}

/** "<bin> devtools helpers", from the live program name. */
function commandLine(command: Command): string {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const bin = root.name() || resolveBinName(null);
  return `${bin} devtools helpers`;
}

function runHelpers(
  words: string[],
  opts: HelpersOpts,
  emit: EmitContext,
  deps: HelperCommandDeps,
  cmdLine: string,
): void {
  const json = opts.format === "json";
  if (json) emit.config({ format: "json" });

  const flags = [
    opts.clear ? "--clear" : null,
    opts.install ? "--install" : null,
    opts.uninstall ? "--uninstall" : null,
  ].filter((flag): flag is string => flag !== null);
  if (flags.length > 1 || (flags.length === 1 && words.length > 0)) {
    emit.error({
      code: "usage",
      message: `use limit words, --clear, --install or --uninstall on their own, not together (got ${[...words, ...flags].join(" ")})`,
      hint: `${cmdLine} opus medium | ${cmdLine} --clear | ${cmdLine} --install`,
    });
    return;
  }

  const prefsPath = deps.preferencesPath ?? preferencesPath();
  const pluginStatus = deps.pluginStatus ?? (() => helperPluginStatus());
  const lead: string[] = [];
  let failure: string | null = null;
  let installedNow = false;

  /** Run a plugin change; returns an error sentence, or null when it worked. */
  const applyChange = (
    run: () => HelperPluginChange,
    verb: "install" | "remove",
  ): string | null => {
    try {
      const change = run();
      lead.push(...change.notes);
      if (change.changed && verb === "install") installedNow = true;
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Harnery could not ${verb} its Claude Code plugin: ${message}`;
    }
  };
  const ensure = deps.ensurePlugin ?? (() => ensureHelperPlugin());

  if (words.length > 0) {
    const profile = BUILTIN_ADAPTER_PROFILES[HELPER_LIMIT_TOOL];
    if (!profile) {
      emit.error({ code: "no_profile", message: `no adapter profile for ${HELPER_LIMIT_TOOL}` });
      return;
    }
    const parsed = parseHelperLimitWords(words, helperLadders(profile));
    if (!parsed.ok) {
      emit.error({
        code: "bad_helper_limit",
        message: parsed.error,
        hint: `${cmdLine} opus medium`,
      });
      return;
    }
    writeHelperLimit(HELPER_LIMIT_TOOL, parsed.limit, prefsPath);
    lead.push(setSentence(parsed.limit));
    const isNone = parsed.limit.max_model === undefined && parsed.limit.max_effort === undefined;
    if (!isNone) {
      const error = applyChange(ensure, "install");
      if (error) failure = `The limit is saved, but ${error}`;
    }
  } else if (opts.clear) {
    writeHelperLimit(HELPER_LIMIT_TOOL, null, prefsPath);
    lead.push("Your own helper limit is removed, so the project default applies if there is one.");
  } else if (opts.install) {
    failure = applyChange(ensure, "install");
  } else if (opts.uninstall) {
    failure = applyChange(deps.removePlugin ?? (() => removeHelperPlugin()), "remove");
  }
  if (installedNow) {
    lead.push("Claude Code sessions that are already open need a restart to pick up the plugin.");
  }

  // Read the plugin status once, for both the report and the version line.
  const status = safeHelperPluginStatus(pluginStatus);
  const buildOptions: BuildHelperLimitReportOptions = {
    preferencesPath: prefsPath,
    pluginStatus: () => {
      if (status.ok) return status.status;
      throw new Error(status.error);
    },
  };
  if (deps.usageDir !== undefined) buildOptions.usageDir = deps.usageDir;
  if (deps.coordRoot !== undefined) buildOptions.coordRoot = deps.coordRoot;
  if (deps.now) buildOptions.now = deps.now();
  const report = buildHelperLimitReport(buildOptions);

  if (json) {
    for (const line of lead) emit.log(line, "info");
    emit.data(report);
  } else {
    const version = status.ok ? status.status.claude_version : null;
    emit.text(renderHelperReport(report, { lead, claudeVersion: version, cmdLine }));
  }
  if (failure) emit.error({ code: "helper_plugin_failed", message: failure });
}

function setSentence(limit: HelperLimit): string {
  const phrase = helperLimitPhrase(limit);
  return phrase
    ? `Helpers now run ${phrase}, in all your projects.`
    : "Helpers now have no limit in any of your projects, even where a project sets a default.";
}

function capitalize(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

function sourceSentence(report: HelperLimitReport, cmdLine: string): string {
  if (report.source === "user") {
    return report.limit
      ? "This is your own choice, for all your projects."
      : "You chose no limit, for all your projects.";
  }
  if (report.source === "project") {
    return `This is the project's default from .harnery/config.jsonc. Set your own with \`${cmdLine} <model> <effort>\`.`;
  }
  return `No limit is set. Set one with \`${cmdLine} <model> <effort>\`, for example \`${cmdLine} opus medium\`.`;
}

function usageSentence(report: HelperLimitReport): string {
  const usage = report.last_24h;
  if (usage.helpers === 0) return "No helpers in the last 24 hours.";
  const models = Object.entries(usage.by_model)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model, count]) => `${capitalize(model)} ${count}`)
    .join(", ");
  const noun = usage.helpers === 1 ? "helper" : "helpers";
  return `Last 24 hours, all projects: ${usage.helpers} ${noun}, ${usage.lowered} lowered. Ran on ${models}.`;
}

/** The plain-sentence report a person reads. */
export function renderHelperReport(
  report: HelperLimitReport,
  context: { lead?: string[]; claudeVersion?: string | null; cmdLine: string },
): string {
  const lines: string[] = [];
  for (const line of context.lead ?? []) lines.push(line);
  if (lines.length) lines.push("");
  lines.push(report.summary);
  lines.push(sourceSentence(report, context.cmdLine));
  if (report.active) {
    lines.push(
      context.claudeVersion ? `Active in Claude Code ${context.claudeVersion}.` : "Active.",
    );
  } else {
    const reason = (report.inactive_reason ?? "unknown reason").replace(/\.+$/, "");
    lines.push(`Not active: ${reason}.`);
  }
  lines.push(`Covered: ${report.coverage.covered.join("; ")}.`);
  lines.push(`Not covered: ${report.coverage.not_covered.join("; ")}.`);
  lines.push(usageSentence(report));
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}
