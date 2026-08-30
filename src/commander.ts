/**
 * `createHarneryProgram` is the composition point.
 *
 * harn (this package's CLI) calls this with `binName: 'harn'`.
 * Consumer CLIs call this with their own binName, register their
 * domain-specific subcommands, and then use `parseAsync()`.
 *
 * The returned Commander program initially contains lightweight top-level
 * metadata. `parseAsync()` materializes only the selected implementation.
 * Consumers that inspect the complete nested tree must first call
 * `loadAllLazyCommands(program)`.
 *
 * Future commands wire in via `registerXxxCommand(program)` calls below.
 * Each subdirectory under src/commands/ exports its `register…` function
 * (Commander pattern).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  type LazyCommandBundle,
  type LazyCommandDefinition,
  loadAllLazyCommands,
  registerLazyCommandBundles,
} from "./lazy-commands.ts";

export {
  type LazyCommandBundle,
  type LazyCommandDefinition,
  loadAllLazyCommands,
  loadLazyCommand,
  onLazyCommandLoaded,
  registerLazyCommandBundles,
} from "./lazy-commands.ts";

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

/** One row in a `harn env` section report. */
export interface EnvCheck {
  label: string;
  value: string;
  status?: "ok" | "missing" | "warn" | "info";
}

/**
 * A `harn env` section: an async probe returning its rows. Hosts register extra
 * sections (e.g. cloud-provider connectivity) via `context.envSections`; harnery
 * core ships only the generic sections (runtimes, docker, git).
 */
export type EnvSection = () => Promise<EnvCheck[]>;

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
   * Extra `harn env` sections keyed by name (e.g. `{ gcp, bq }`). Merged into
   * the built-in generic sections (runtimes, docker, git), so a host can expose
   * `harn env <name>` for its own environment probes without harnery core
   * carrying provider-specific checks. harn standalone ships none.
   */
  envSections?: Record<string, EnvSection>;
  /**
   * Extra directory names for `grep` to exclude by default — host-generated
   * mirrors, vendored trees, and similar directories that only ever produce
   * duplicate or noisy matches. Names match at any depth (same semantics as
   * grep's `--exclude-dir`). Applied alongside the built-in skip list and
   * disabled together with it by `--no-default-excludes`. harn standalone
   * ships none.
   */
  grepExcludeDirs?: readonly string[];
  /**
   * Optional callback that returns extra HTTP headers to attach to outbound
   * `fetch` calls based on the target URL. Useful for consumers that need
   * to inject auth or bypass headers on certain hostnames (e.g. private
   * zones behind a WAF). harn standalone skips the callback entirely.
   */
  extraHeaders?: (url: string) => Record<string, string>;
  /**
   * Host-injected vision-model call for `browse --check-critique`. harnery
   * ships no model client or API key; a consumer wires this to its own
   * multimodal provider (OpenAI/Anthropic/etc). Given one page tile + the
   * rubric, it returns that tile's findings. When omitted, `--check-critique`
   * reports `skipped` rather than a false pass.
   */
  critiqueProvider?: import("./lib/browser/critique.ts").CritiqueProvider;
  /** Load a host vision provider only when browse critique is requested. */
  critiqueProviderLoader?: () => Promise<
    import("./lib/browser/critique.ts").CritiqueProvider | undefined
  >;
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
   * Filenames permitted at the host project's `docs/` root (parent repo only).
   * When set, `harn docs lint` flags any other `.md`/`.json` file sitting
   * loose at `docs/` root (rule `docs-root-file`) — topic docs belong in
   * `docs/<topic>/` subdirs. Names are matched exactly (basename). When
   * omitted or empty, the rule is a no-op, so standalone `harn` and consumers
   * that don't opt in are unaffected. Submodule `docs/` roots are never
   * checked (their entry tiers differ from the parent's).
   */
  docsRootAllowlist?: readonly string[];
  /**
   * Construction-time storage families, logger bindings, and explicit host
   * exclusions. Harnery validates these against its source-owned catalog;
   * hosts cannot replace or weaken Harnery descriptors at runtime.
   */
  storage?: import("./core/storage/contract.ts").HarneryHostStorageRegistration;
  /** Maintenance implementations registered at construction time by storage owners. */
  storageMaintenanceProviders?: readonly import("./core/storage/maintenance.ts").HarneryMaintenanceProvider[];
  /** Private inbox implementation. Omission keeps the commands visible but unavailable to invoke. */
  coordinationInbox?: import("./core/inbox/service.ts").HarneryInboxService;
  /** Adapter-native conversation providers. Omission keeps explicit history access unavailable. */
  conversations?: {
    catalog: import("./core/conversations/catalog.ts").HarneryConversationCatalog;
    projectScopeId: string;
    records?: () => readonly import("./core/conversations/contract.ts").HarneryConversationRecordV1[];
  };
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

/** Mount Harnery's storage and log commands below an arbitrary host namespace. */
export interface HarneryLogStorageCommandOptions
  extends Pick<HarneryContextOpts, "emit" | "context"> {
  commands?: readonly ("storage" | "logs")[];
}

export async function registerHarneryLogStorageCommands(
  parent: Command,
  options: HarneryLogStorageCommandOptions = {},
): Promise<Command> {
  const emit = options.emit ?? defaultEmit;
  const commands = new Set(options.commands ?? ["storage", "logs"]);
  if (commands.has("storage")) {
    const { registerStorageCommand } = await import("./commands/storage.ts");
    registerStorageCommand(parent, emit, options.context);
  }
  if (commands.has("logs")) {
    const { registerLogsCommand } = await import("./commands/logs.ts");
    registerLogsCommand(parent, emit, options.context);
  }
  return parent;
}

export function createHarneryProgram(opts: HarneryContextOpts = {}): Command {
  const program = new Command();
  const emit = opts.emit ?? defaultEmit;
  const skip = new Set(opts.skipCommands ?? []);
  const binName = opts.binName ?? "harn";

  program
    .name(binName)
    .description("Multi-agent coordination + adapter adapters + portable CLI utilities.")
    .version(readVersion());

  const bundles = harneryCommandBundles({ emit, context: opts.context, binName }).filter((bundle) =>
    bundle.commands.every((command) => !skip.has(commandName(command.command))),
  );
  registerLazyCommandBundles(program, bundles);

  return program;
}

interface CommandBundleContext {
  emit: EmitContext;
  context: HarneryProgramContext | undefined;
  binName: string;
}

function lazy(
  command: string,
  description: string,
  load: LazyCommandBundle["load"],
  options: Omit<LazyCommandDefinition, "command" | "description"> = {},
): LazyCommandBundle {
  return { commands: [{ command, description, ...options }], load };
}

function harneryCommandBundles({
  emit,
  context,
  binName,
}: CommandBundleContext): LazyCommandBundle[] {
  return [
    lazy(
      "tokens <files...>",
      "Count tokens in text/markdown files (offline, uses o200k_base as Claude proxy)",
      async (program) =>
        (await import("./commands/tokens.ts")).registerTokensCommand(program, emit),
      { hasOptions: true },
    ),
    lazy(
      "eml <file>",
      "Parse a Gmail .eml file into a clean chronological markdown thread",
      async (program) => (await import("./commands/eml.ts")).registerEmlCommand(program, emit),
      { hasOptions: true },
    ),
    lazy(
      "env [section]",
      "Show environment status (runtimes, docker, git; hosts can add sections)",
      async (program) =>
        (await import("./commands/env.ts")).registerEnvCommand(program, emit, context),
    ),
    lazy(
      "presence",
      "Presence: mobile/office state (get/set/clear/detect) + cross-machine session presence (publish/fetch/peers)",
      async (program) =>
        (await import("./commands/presence.ts")).registerPresenceCommand(program, emit),
    ),
    lazy(
      "relay",
      "Self-host the presence relay (see also relay/worker/ for the Cloudflare host)",
      async (program) => (await import("./commands/relay.ts")).registerRelayCommand(program, emit),
    ),
    lazy(
      "config-get <file> <key>",
      "Extract a single value from a JSON/YAML config file by dotted-path. Bracket notation supported: `config-get tsconfig.json compilerOptions.paths`.",
      async (program) =>
        (await import("./commands/config-get.ts")).registerConfigGetCommand(program, emit),
      { hasOptions: true },
    ),
    lazy(
      "file-history <path>",
      "Concise per-file git history: summary stats + N most-recent commits with line impact.",
      async (program) =>
        (await import("./commands/file-history.ts")).registerFileHistoryCommand(program, emit),
      { hasOptions: true },
    ),
    lazy(
      "outline <file>",
      `Print the structural skeleton of a code file (imports + top-level decls + line numbers). Supports TS/JS/TSX/JSX (AST), PHP/Python (regex). Use \`${binName} toc\` for markdown.`,
      async (program) =>
        (await import("./commands/outline.ts")).registerOutlineCommand(program, emit, binName),
      { hasOptions: true },
    ),
    lazy(
      "toc <file>",
      "Print the markdown header outline (level + text + line number).",
      async (program) => (await import("./commands/toc.ts")).registerTocCommand(program, emit),
      { hasOptions: true },
    ),
    lazy(
      "section <file> <header...>",
      "Extract one section from a markdown file by header substring (case-insensitive by default). Joins multi-word args into one query string.",
      async (program) => (await import("./commands/toc.ts")).registerSectionCommand(program, emit),
      { hasOptions: true },
    ),
    lazy(
      "callers <symbol>",
      "Find references to a symbol across the monorepo with kind classification (call / import / type / decl / ref). Heuristic: filters out declarations + single-line comments by default; opt back in with --include-decl / --include-comments.",
      async (program) =>
        (await import("./commands/callers.ts")).registerCallersCommand(program, emit, context),
      { hasOptions: true },
    ),
    lazy(
      "edit-batch <old> <new> <files...>",
      "Coordinated find/replace across N files (literal by default; --regex for pattern). Atomic per-file. Use --dry-run to preview.",
      async (program) =>
        (await import("./commands/edit-batch.ts")).registerEditBatchCommand(program, emit),
      { hasOptions: true },
    ),
    lazy(
      "grep <pattern> [paths...]",
      "Monorepo-aware code search (ripgrep when available, GNU grep fallback). Skips dist/.next/node_modules/.git/... by default. Use --repo, --all-repos, --lang for scoping; --and/--without for file-level composition. Regex by default; -F for literal.",
      async (program) =>
        (await import("./commands/grep.ts")).registerGrepCommand(program, emit, context),
      { hasOptions: true },
    ),
    lazy(
      "adapter",
      "Inspect registered adapter capabilities and run their conformance bench.",
      async (program) =>
        (await import("./commands/adapter.ts")).registerAdapterCommand(program, emit),
    ),
    lazy("policy", "Inspect host-enforced workflow policy documents.", async (program) =>
      (await import("./commands/policy.ts")).registerPolicyCommand(program, emit),
    ),
    lazy(
      "cookies",
      "Manage the shared browser cookie store (default: ~/.cache/harnery/cookies.json). Format is CDP-native (compatible with Playwright/agent-browser).",
      async (program) =>
        (await import("./commands/cookies.ts")).registerCookiesCommand(program, emit),
      { hasOptions: true },
    ),
    lazy(
      "fetch <url>",
      `HTTP GET (or --method) with cookie-jar attach + persist. Default jar is ~/.cache/harnery/cookies.json (shared with ${binName} cookies / ${binName} browse).`,
      async (program) =>
        (await import("./commands/fetch.ts")).registerFetchCommand(program, emit, context),
      { hasOptions: true },
    ),
    lazy("files", "Mint browser links for files served by the local dashboard", async (program) =>
      (await import("./commands/files.ts")).registerFilesCommand(program, emit, context),
    ),
    lazy(
      "read [html-file]",
      `Extract clean readable markdown from HTML. Reads from file or stdin (use '-'). Pair with \`${binName} fetch\` or \`${binName} browse\` for scrape-to-markdown.`,
      async (program) =>
        (await import("./commands/read.ts")).registerReadCommand(program, emit, binName),
      { hasOptions: true },
    ),
    lazy(
      "browse <url>",
      "Headless Chromium with persistent profile + cookie jar. Default writes a trio of files (last.png, last.html, last.json) for the LLM iteration loop; --snapshot/--html/--json switch to stdout-print mode.",
      async (program) =>
        (await import("./commands/browse.ts")).registerBrowseCommand(
          program,
          emit,
          context,
          binName,
        ),
      { hasOptions: true },
    ),
    lazy(
      "browse-session",
      "Control an opted-in headed browse session through an owner-only descriptor",
      async (program) =>
        (await import("./commands/browse-session.ts")).registerBrowseSessionCommand(program, emit),
    ),
    lazy(
      "browse-ai <url>",
      `agent-browser (Vercel Labs) wrapper: accessibility-tree snapshots with element refs (@e1, @e2) for LLM consumption. Daemon-mode: successive calls reuse the same browser instance. Sister to ${binName} browse (Playwright).`,
      async (program) =>
        (await import("./commands/browse-ai.ts")).registerBrowseAiCommand(program, emit),
      { hasOptions: true },
    ),
    {
      commands: [
        {
          command: "completion",
          description:
            "Shell tab-completion. Emit a script per shell or install to the standard location.",
        },
        {
          command: "__complete <provider> [partial]",
          description: "Internal: dynamic-value completion callback for the shell",
          hidden: true,
        },
        {
          command: "__complete-line <cword> [words...]",
          description: "Internal: full-line completion callback for the dynamic shell shim",
          hidden: true,
        },
      ],
      load: async (program) => {
        await loadAllLazyCommands(program);
        (await import("./commands/completion.ts")).registerCompletionCommand(
          program,
          emit,
          context,
        );
      },
    },
    lazy(
      "checkpoint",
      "Durable context-continuity capsules: create one, show the latest, or report continuity phase.",
      async (program) =>
        (await import("./commands/checkpoint.ts")).registerCheckpointCommand(
          program,
          emit,
          context,
        ),
      { hasOptions: true },
    ),
    lazy(
      "journal",
      "Per-agent markdown journal: append-only timestamped entries. Survives in-session compaction, archived at session end, pruned after 7 days.",
      async (program) =>
        (await import("./commands/journal.ts")).registerJournalCommand(program, emit),
    ),
    lazy(
      "ledger-v3",
      "Inspect or initialize the universal event-ledger V3 epoch",
      async (program) =>
        (await import("./commands/ledger-v3.ts")).registerLedgerV3Command(program, emit, context),
    ),
    lazy(
      "semantic",
      "Build and inspect evidence-cited semantic readings of active V3 generations",
      async (program) =>
        (await import("./commands/semantic.ts")).registerSemanticCommand(program, emit, context),
    ),
    lazy(
      "storage",
      "Inspect registered Harnery storage without reading file bodies",
      async (program) =>
        (await import("./commands/storage.ts")).registerStorageCommand(program, emit, context),
    ),
    lazy("logs", "List and query bounded Harnery log families", async (program) =>
      (await import("./commands/logs.ts")).registerLogsCommand(program, emit, context),
    ),
    lazy("inbox", "Inspect private coordination inbox state", async (program) =>
      (await import("./commands/inbox.ts")).registerInboxCommand(
        program,
        emit,
        context?.coordinationInbox,
      ),
    ),
    lazy(
      "messages",
      "Queue a durable coordination message; dry-run unless --yes",
      async (program) =>
        (await import("./commands/messages.ts")).registerMessagesCommand(
          program,
          emit,
          context?.coordinationInbox,
        ),
      { hasOptions: true },
    ),
    lazy("conversations", "Query conversation evidence", async (program) => {
      const { registerConversationsCommand } = await import("./commands/conversations.ts");
      registerConversationsCommand(
        program,
        emit,
        context?.conversations?.catalog,
        context?.conversations
          ? {
              project_scope_id: context.conversations.projectScopeId,
              ...(context.conversations.records ? { records: context.conversations.records } : {}),
            }
          : undefined,
      );
    }),
    lazy("events", "Inspect the canonical event ledger", async (program) =>
      (await import("./commands/events.ts")).registerEventsCommand(program, emit, context),
    ),
    lazy(
      "artifacts",
      "Manage repository-local working artifacts under .harnery/artifacts/",
      async (program) =>
        (await import("./commands/artifacts.ts")).registerArtifactsCommand(program, emit, context),
      { aliases: ["artifact"] },
    ),
    lazy(
      "decision",
      "Decision docket: file a decision an agent would otherwise escalate, deliberate it, resolve with cited evidence, review async.",
      async (program) =>
        (await import("./commands/decision.ts")).registerDecisionCommand(program, emit),
      { aliases: ["decisions"] },
    ),
    lazy(
      "devtools",
      "Local status of the AI coding agents (Claude Code, Codex, Cursor)",
      async (program) =>
        (await import("./commands/devtools.ts")).registerDevtoolsCommand(program, emit),
      { hasOptions: true },
    ),
    lazy(
      "tunnel",
      "Provider-backed tunnel(s) in front of a local upstream (default upstream: 127.0.0.1:8001). Run several at once with --name <instance>.",
      async (program) =>
        (await import("./commands/tunnel.ts")).registerTunnelCommand(program, emit, context),
    ),
    lazy(
      "docs",
      "Documentation tooling: freshness report, metadata, lint, sweep, index",
      async (program) =>
        (await import("./commands/docs.ts")).registerDocsCommand(program, emit, context),
      { hasOptions: true },
    ),
    lazy(
      "agents",
      "The live agent sessions in this project: who is running now, what they hold, and their coordination state (whoami / list / status / health).",
      async (program) =>
        (await import("./commands/agents.ts")).registerAgentsCommand(
          program,
          emit,
          context,
          binName,
        ),
    ),
    lazy(
      "council",
      "Multi-agent deliberation: convene a temporary group around an objective, run N rounds of contribution, emit a transcript.",
      async (program) => (await import("./commands/agents.ts")).registerCouncilCommands(program),
    ),
    lazy(
      "doctor",
      "Verify the runtime + optional deps harnery commands expect. Exits 0 unless a required dep (Node, git) is missing.",
      async (program) =>
        (await import("./commands/doctor.ts")).registerDoctorCommand(program, emit),
      { hasOptions: true },
    ),
    lazy(
      "instructions",
      "Inspect and version the repo-authored instruction bundle loaded by each adapter.",
      async (program) =>
        (await import("./commands/instructions.ts")).registerInstructionsCommand(program, emit),
    ),
    lazy(
      "init",
      "Bootstrap harnery in this project: create .harnery/, wire the adapter hooks, and inject the agent-facing instructions block + skills (idempotent; safe to re-run). Use --dry-run to preview, --check to report drift without writing (exit 0 fresh / 2 drift / 1 error).",
      async (program) =>
        (await import("./commands/init.ts")).registerInitCommand(program, emit, binName),
      { hasOptions: true },
    ),
    lazy(
      "deinit",
      "Reverse `harn init`: remove harnery's hook entries from the adapter settings file (keeps any others). Pass --purge-state to also delete the .harnery/ coord root (on a terminal it asks first). Idempotent; use --dry-run to preview.",
      async (program) =>
        (await import("./commands/deinit.ts")).registerDeinitCommand(program, emit, binName),
      { hasOptions: true },
    ),
    lazy(
      "backup",
      "restic-backed snapshots of .harnery/ (multi-machine recovery insurance)",
      async (program) =>
        (await import("./commands/backup.ts")).registerBackupCommand(program, emit),
    ),
    lazy(
      "claude-desktop",
      "Claude desktop-app session index: list and mirror sessions across accounts",
      async (program) =>
        (await import("./commands/claude-desktop.ts")).registerClaudeDesktopCommand(
          program,
          emit,
          context,
        ),
    ),
    lazy(
      "sync",
      "Cross-machine sync of curated .harnery/ subset (identities, archived journals, council manifests) via rclone. Google Drive is the expected remote; any rclone backend works.",
      async (program) => (await import("./commands/sync.ts")).registerSyncCommand(program, emit),
    ),
    {
      commands: [
        {
          command: "run",
          description:
            "Execute one bounded, schema-gated multi-subagent script. Subagents spawn as headless adapter-CLI subprocesses, born coordination-registered.",
        },
        { command: "approval", description: "Inspect and resolve durable run-policy approvals." },
      ],
      load: async (program) =>
        (await import("./commands/workflow.ts")).registerWorkflowCommand(program, emit),
    },
    lazy("work", "Track durable objectives across bounded workflow attempts.", async (program) =>
      (await import("./commands/work.ts")).registerWorkCommand(program, emit),
    ),
    lazy(
      "governor",
      "Run a bounded specialist team over a durable-work dependency graph.",
      async (program) =>
        (await import("./commands/governor.ts")).registerGovernorCommand(program, emit),
    ),
    lazy("web", "Standalone read-only dashboard for harnery's coord state", async (program) =>
      (await import("./commands/web.ts")).registerWebCommand(program, emit),
    ),
  ];
}

function commandName(signature: string): string {
  return signature.trim().split(/\s/, 1)[0] ?? signature;
}

function readVersion(): string {
  // Resolve package.json by walking up from this module. Works under Bun (this
  // file runs from src/) and Node (from dist/): package.json sits at the
  // package root above both. Falls back to "0.0.0" if it can't be found rather
  // than crashing `--version`.
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg.name === "harnery" && typeof pkg.version === "string") return pkg.version;
      } catch {
        // no package.json at this level, or not ours; keep walking up
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url unavailable or fs error; fall through
  }
  return "0.0.0";
}
