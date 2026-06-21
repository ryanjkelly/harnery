/**
 * `createHarneryProgram` is the composition point.
 *
 * harn (this package's CLI) calls this with `binName: 'harn'`.
 * Consumer CLIs call this with their own binName, then `.addCommand()`
 * their domain-specific subcommands and `parseAsync()`.
 *
 * The returned Commander program is harnery's full command tree. Adding
 * a command with the same name on the consumer side overrides it, which is
 * useful for project-specific overlays but uncommon.
 *
 * Future commands wire in via `registerXxxCommand(program)` calls below.
 * Each subdirectory under src/commands/ exports its `register…` function
 * (Commander pattern).
 */

import { Command } from "commander";
import { registerAgentsCommand } from "./commands/agents.ts";
import { registerBackupCommand } from "./commands/backup.ts";
import { registerBrowseCommand } from "./commands/browse.ts";
import { registerBrowseAiCommand } from "./commands/browse-ai.ts";
import { registerCallersCommand } from "./commands/callers.ts";
import { registerCompletionCommand } from "./commands/completion.ts";
import { registerConfigGetCommand } from "./commands/config-get.ts";
import { registerContextCommand } from "./commands/context.ts";
import { registerCookiesCommand } from "./commands/cookies.ts";
import { registerDocsCommand } from "./commands/docs.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { registerEditBatchCommand } from "./commands/edit-batch.ts";
import { registerEmlCommand } from "./commands/eml.ts";
import { registerEnvCommand } from "./commands/env.ts";
import { registerFetchCommand } from "./commands/fetch.ts";
import { registerFileHistoryCommand } from "./commands/file-history.ts";
import { registerGrepCommand } from "./commands/grep.ts";
import { registerInitCommand } from "./commands/init.ts";
import { registerOutlineCommand } from "./commands/outline.ts";
import { registerPresenceCommand } from "./commands/presence.ts";
import { registerReadCommand } from "./commands/read.ts";
import { registerScratchCommand } from "./commands/scratch.ts";
import { registerSessionCommand } from "./commands/session.ts";
import { registerSyncCommand } from "./commands/sync.ts";
import { registerSectionCommand, registerTocCommand } from "./commands/toc.ts";
import { registerTokensCommand } from "./commands/tokens.ts";
import { registerTunnelCommand } from "./commands/tunnel.ts";
import { registerUninstallCommand } from "./commands/uninstall.ts";
import { registerWebCommand } from "./commands/web.ts";

export interface HarneryContextOpts {
  /**
   * The binary name shown in --help output. Defaults to "harn". Consumer
   * CLIs pass their own, e.g. `binName: "mycli"`.
   */
  binName?: string;

  /**
   * Project-scoped context. Commands that touch state (.harnery/agents/,
   * .harnery/config.jsonc) consult this to resolve paths + project identity.
   * Optional: harn standalone runs without it.
   */
  context?: HarneryProgramContext;

  /**
   * Adapter that lets consumers route structured emissions into their own
   * OutputContext (e.g. an AsyncLocalStorage-bound writer). When omitted,
   * harn standalone falls back to a default JSON-to-stdout emitter (see
   * `defaultEmit` below).
   */
  emit?: EmitContext;

  /**
   * Top-level command names harnery should NOT register. Use when a
   * consumer wants to replace harnery's implementation with its own
   * (Commander throws on duplicate registration). Example: the host CLI has
   * a project-specific `harn web` (docker stack shim) and passes
   * `skipCommands: ["web"]` so harnery's generic `web` doesn't collide.
   */
  skipCommands?: readonly string[];
}

export interface HarneryProgramContext {
  /** Project name (e.g., "my-monorepo"). Used in user-facing log lines + telemetry tags. */
  projectName?: string;
  /** Override the monorepo-root resolver. Default: walk up looking for `.harnery/`. */
  resolveCoordRoot?: () => string | null;
  /**
   * Absolute path to the monorepo root. Commands like `env` use this as the
   * default `cwd` for `git` invocations. When omitted, commands fall back to
   * `process.cwd()`.
   */
  repoRoot?: string;
  /**
   * Submodule directory names relative to `repoRoot`. Consumed by `env` to
   * report N/M initialized. When omitted, the `env` command skips the
   * submodule row.
   */
  submodules?: readonly string[];
  /**
   * Optional callback that returns extra HTTP headers to attach to outbound
   * `fetch` calls based on the target URL. Useful for consumers that need
   * to inject auth or bypass headers on certain hostnames (e.g. private
   * zones behind a WAF). harn standalone skips the callback entirely.
   */
  extraHeaders?: (url: string) => Record<string, string>;
  /**
   * Shell-completion provider-key lookup. Consumers wire this to a function
   * mapping (commandPath, option/positional) to a provider key, so that
   * `--workspace` / `--env` etc. tab-complete dynamically against
   * consumer-specific data sources. harn standalone falls back to no-op
   * (static completion only).
   */
  completionLookup?: (key: {
    commandPath: string;
    option?: string;
    positional?: number;
  }) => string | undefined;
  /**
   * Shell-completion provider runner. Invoked by the hidden `__complete`
   * subcommand at tab-time to produce the actual list of completions for
   * a given provider key.
   */
  completionRunner?: (key: string, partial: string) => Promise<string[]>;
  /**
   * Extra path prefixes that should be excluded from `harn docs lint`
   * convention checks (auto-generated API reference dumps, vendored
   * content directories, etc.). Combined with harnery's built-in
   * exclusions (`.claude/`, `.harnery/`, `.codex/`, `.cursor/`).
   */
  extraDocsExcludedPrefixes?: readonly string[];
  /**
   * Default Host header for `tunnel up` when `--vhost` is omitted: a literal
   * host, or a resolver evaluated at start time (e.g. read a dev stack's
   * configured hostname so the tunnel lands on the right vhost). When unset, or
   * the resolver returns null, the tunnel falls back to harnery's built-in
   * default (`localhost`).
   */
  tunnelDefaultVhost?: string | (() => string | null | undefined);
}

/**
 * Minimum emission surface harnery commands need to talk to a host CLI's
 * OutputContext. Intentionally tiny: just the methods commands actually
 * call. Designed to grow additively: consumers that want richer output
 * routing implement these methods; everyone else gets `defaultEmit`'s
 * JSON-to-stdout fallback.
 */
export interface EmitContext {
  config(opts: { format?: string }): void;
  data(payload: unknown): void;
  rows(rows: Record<string, unknown>[]): void;
  text(s: string): void;
  file(path: string, summary: Record<string, unknown>): void;
  error(err: { code: string; message: string; hint?: string } | Error | unknown): void;
  log(msg: string, level?: "debug" | "info" | "warn" | "error"): void;
  setExitCode(n: number): void;
}

export const defaultEmit: EmitContext = {
  config() {
    // No-op for harn standalone: there's only one format (JSON) and it's
    // already the default. Consumer adapters route this to their own
    // output-context configurator.
  },
  data(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  },
  rows(rows) {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
  },
  text(s) {
    process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  },
  file(path, summary) {
    process.stdout.write(`${JSON.stringify({ ok: true, file: path, ...summary })}\n`);
  },
  error(err) {
    const payload =
      err instanceof Error
        ? { code: err.name || "error", message: err.message }
        : typeof err === "object" && err !== null
          ? err
          : { code: "error", message: String(err) };
    process.stderr.write(`${JSON.stringify({ error: payload })}\n`);
    process.exitCode = 1;
  },
  log(msg, level = "info") {
    process.stderr.write(`[${level}] ${msg}\n`);
  },
  setExitCode(n) {
    process.exitCode = n;
  },
};

export function createHarneryProgram(opts: HarneryContextOpts = {}): Command {
  const program = new Command();
  const emit = opts.emit ?? defaultEmit;
  const skip = new Set(opts.skipCommands ?? []);
  const include = (name: string) => !skip.has(name);

  program
    .name(opts.binName ?? "harn")
    .description("Multi-agent coordination + harness adapters + portable CLI utilities.")
    .version(readVersion());

  registerTokensCommand(program, emit);
  registerEmlCommand(program, emit);
  registerEnvCommand(program, emit, opts.context);
  registerPresenceCommand(program, emit);
  registerConfigGetCommand(program, emit);
  registerFileHistoryCommand(program, emit);
  registerOutlineCommand(program, emit);
  registerTocCommand(program, emit);
  registerSectionCommand(program, emit);
  registerCallersCommand(program, emit, opts.context);
  registerEditBatchCommand(program, emit);
  registerGrepCommand(program, emit, opts.context);
  registerCookiesCommand(program, emit);
  registerFetchCommand(program, emit, opts.context);
  registerReadCommand(program, emit);
  registerBrowseCommand(program, emit, opts.context);
  registerBrowseAiCommand(program, emit);
  registerSessionCommand(program, emit);
  registerCompletionCommand(program, emit, opts.context);
  registerContextCommand(program, emit, opts.context);
  registerScratchCommand(program, emit);
  registerTunnelCommand(program, emit, opts.context);
  registerDocsCommand(program, emit, opts.context);
  registerAgentsCommand(program, emit);
  registerDoctorCommand(program, emit);
  registerInitCommand(program, emit, opts.binName);
  registerUninstallCommand(program, emit);
  registerBackupCommand(program, emit);
  registerSyncCommand(program, emit);
  if (include("web")) registerWebCommand(program, emit);

  return program;
}

function readVersion(): string {
  // Static for the empty scaffold. Will be replaced by a build-time substitution
  // (or a JSON import) once we have any command shipping.
  return "0.1.0";
}
