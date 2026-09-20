/**
 * Harnery OpenCode plugin: bridges OpenCode V2 in-process lifecycle hooks to
 * `agent-hook <subcommand> --adapter opencode`, so an interactive OpenCode
 * session (TUI, `opencode run`, the desktop app) produces the same Event Ledger
 * V3 evidence as a Claude Code, Cursor, or Codex session.
 *
 * OpenCode V2 has no settings-file command hooks; its only interception point
 * is a plugin loaded into the shared background service. `harn init --adapter
 * opencode` copies this file, verbatim under a hash-stamped ownership header,
 * to `.opencode/plugins/harnery/index.ts` with a sibling `harnery.json` that
 * names the `agent-hook` launcher. OpenCode auto-discovers that directory, so
 * no `opencode.json` edit is needed.
 *
 * Contract this file keeps, because it is copied into consumer repositories:
 * - self-contained: `node:*` imports only, no relative imports, no Harnery
 *   package imports (the consumer may not have Harnery resolvable from here);
 * - fail-open: a hook that cannot reach `agent-hook` logs and returns, so a
 *   broken bridge never breaks the operator's OpenCode session;
 * - observe-only at turn end: OpenCode has no blocking Stop channel, so the
 *   `stop` verdict is recorded but never re-prompts.
 *
 * Event map (OpenCode → agent-hook subcommand), kept in sync with
 * `OPENCODE_EVENTS` in `src/core/hooks/adapter/events.ts`:
 *   event session.created                 → session-start (child → sub-agent-start)
 *   session.hook("prompt")                → user-prompt-submit
 *   tool.hook("execute.before")           → pre-tool-use (deny → throw)
 *   tool.hook("execute.after")            → post-tool-use | post-tool-use-failure
 *   permission.hook("evaluate")           → permission-request
 *   session.hook("compaction")            → pre-compact
 *   event session.execution.succeeded     → stop (child → sub-agent-stop)
 *   event session.execution.failed        → stop-failure (child → sub-agent-stop)
 *   event session.execution.interrupted   → stop-failure (child → sub-agent-stop)
 *   event session.deleted                 → session-end
 *   shell.hook("create.before")           → stamps OPENCODE_SESSION_ID into the tool shell
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HARNERY_OPENCODE_PLUGIN_ID = "harnery";
export const HARNERY_OPENCODE_CONFIG_FILE = "harnery.json";
export const HARNERY_OPENCODE_CONFIG_SCHEMA = "harnery-opencode-plugin/v1";
/** Env var the shell hook stamps so a coord CLI run as a tool recovers its session. */
export const OPENCODE_SESSION_ENV = "OPENCODE_SESSION_ID";
const ADAPTER = "opencode";
const DEFAULT_TIMEOUT_MS = 20_000;
const CONTEXT_DESCRIPTION = "Harnery coordination context";

// ── OpenCode plugin API (the subset this plugin touches) ─────────────────────

export interface OpenCodeRegistration {
  dispose(): Promise<void>;
}
export interface OpenCodeToolBefore {
  tool: string;
  readonly sessionID: string;
  readonly agent?: string;
  readonly messageID?: string;
  readonly id: string;
  input: unknown;
}
export type OpenCodeToolAfter = {
  readonly tool: string;
  readonly sessionID: string;
  readonly agent?: string;
  readonly messageID?: string;
  readonly id: string;
  readonly input: unknown;
} & (
  | { readonly status: "completed"; result: unknown }
  | { readonly status: "error"; error: unknown }
);
export interface OpenCodeSessionPrompt {
  readonly sessionID: string;
  readonly messageID?: string;
  prompt: { text?: string; [k: string]: unknown };
  metadata?: Record<string, unknown>;
  delivery?: string;
}
export interface OpenCodeSystemPart {
  type: "text";
  text: string;
  [k: string]: unknown;
}
export interface OpenCodeSessionRequest {
  readonly sessionID: string;
  readonly agent?: string;
  readonly model?: { providerID?: string; id?: string; variant?: string };
  system: OpenCodeSystemPart[];
  [k: string]: unknown;
}
export interface OpenCodePermissionEvaluation {
  readonly sessionID: string;
  readonly agent?: string;
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  readonly metadata?: Record<string, unknown>;
  readonly source?: { type?: string; messageID?: string; id?: string };
  effect: "allow" | "ask" | "deny";
  message?: string;
}
export interface OpenCodeShellCreateBefore {
  command: string;
  cwd: string;
  timeout?: number;
  shell?: string;
  env: Record<string, string | undefined>;
}
export interface OpenCodeBusEvent {
  id?: string;
  created?: number;
  type: string;
  location?: { directory?: string };
  data?: Record<string, unknown>;
}
type Hook<T> = (
  name: string,
  callback: (event: T) => Promise<void> | void,
) => Promise<OpenCodeRegistration>;
export interface OpenCodePluginContext {
  readonly location: { directory: string; project?: { id?: string; directory?: string } };
  readonly options?: Record<string, unknown>;
  readonly session: {
    hook: Hook<OpenCodeSessionPrompt | OpenCodeSessionRequest>;
    synthetic(input: { sessionID: string; text: string; description?: string }): Promise<unknown>;
  };
  readonly tool: { hook: Hook<OpenCodeToolBefore | OpenCodeToolAfter> };
  readonly permission: { hook: Hook<OpenCodePermissionEvaluation> };
  readonly shell: { hook: Hook<OpenCodeShellCreateBefore> };
  readonly event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<OpenCodeBusEvent>;
  };
}

// ── Configuration ────────────────────────────────────────────────────────────

export interface HarneryOpenCodeConfig {
  schema: string;
  /** `agent-hook` launcher: repo-relative path (run through `bash`) or the bare `agent-hook` on PATH. */
  agentHook: string;
  /** Project root that `agent-hook` resolves its coord root from (its cwd). */
  projectRoot: string;
  timeoutMs: number;
}

/**
 * Resolve the plugin's config from the sibling `harnery.json`. The plugin lives
 * at `<root>/.opencode/plugins/harnery/index.ts`, so the project root is three
 * directories up; `agentHook` is relative to that root, as `harn init` writes it.
 */
export function loadHarneryOpenCodeConfig(pluginDir: string): HarneryOpenCodeConfig {
  const projectRoot = resolve(pluginDir, "..", "..", "..");
  let agentHook = "agent-hook";
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const path = resolve(pluginDir, HARNERY_OPENCODE_CONFIG_FILE);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        agentHook?: unknown;
        timeoutMs?: unknown;
      };
      if (typeof parsed.agentHook === "string" && parsed.agentHook.length > 0) {
        agentHook = parsed.agentHook;
      }
      if (typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0) {
        timeoutMs = parsed.timeoutMs;
      }
    } catch {
      /* unreadable config → PATH launcher, default timeout */
    }
  }
  return { schema: HARNERY_OPENCODE_CONFIG_SCHEMA, agentHook, projectRoot, timeoutMs };
}

/** argv for one bridge call, mirroring `hookCommand` in `src/core/hooks/adapter/wiring.ts`. */
export function agentHookArgv(config: HarneryOpenCodeConfig, subcommand: string): string[] {
  const tail = [subcommand, "--adapter", ADAPTER];
  if (config.agentHook === "agent-hook") return ["agent-hook", ...tail];
  const launcher = isAbsolute(config.agentHook)
    ? config.agentHook
    : resolve(config.projectRoot, config.agentHook);
  return ["bash", launcher, ...tail];
}

/**
 * Directories a tool shell needs so the project's bare launchers resolve: its
 * own `bin/`, plus whichever Bun install directory exists (a project launcher is
 * commonly a shim that execs `bun`). Only existing directories are returned, so
 * a PATH is never padded with dead entries.
 */
export function shellPathDirs(projectRoot: string, home = homedir()): string[] {
  const dirs = [join(projectRoot, "bin")];
  for (const bin of [join(home, ".bun", "bin"), "/usr/local/bin", "/opt/homebrew/bin"]) {
    if (existsSync(join(bin, "bun"))) dirs.push(bin);
  }
  return dirs.filter((dir) => existsSync(dir));
}

/**
 * Prepend {@link shellPathDirs} to a tool shell's PATH, preserving order and
 * skipping entries already present. An OpenCode server can start from a
 * GUI-launched environment whose PATH lacks the project's own tools, which would
 * make an otherwise-valid `bin/<launcher>` call fail as "command not found".
 */
export function prependShellPath(
  env: Record<string, string | undefined>,
  projectRoot: string,
  home = homedir(),
): void {
  const current = env.PATH ?? process.env.PATH ?? "";
  const parts = current.split(delimiter).filter((part) => part.length > 0);
  const additions = shellPathDirs(projectRoot, home).filter((dir) => !parts.includes(dir));
  env.PATH = [...additions, ...parts].join(delimiter);
}

// ── Payload translation (pure; unit-tested) ──────────────────────────────────

export type HookPayload = Record<string, unknown>;

/**
 * OpenCode names tools in lowercase (`shell`, `read`, `edit`); Harnery's
 * parsers key command extraction on `Bash`/`Shell` and target hashing on the
 * capitalized Claude Code names, so capitalize and map `shell` → `Shell`.
 */
export function harneryToolName(tool: string | undefined): string {
  if (!tool) return "unknown";
  if (tool === "shell" || tool === "bash") return tool === "shell" ? "Shell" : "Bash";
  return tool.charAt(0).toUpperCase() + tool.slice(1);
}

function modelLabel(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const m = model as { providerID?: unknown; id?: unknown; variant?: unknown };
  if (typeof m.id !== "string") return undefined;
  const base = typeof m.providerID === "string" ? `${m.providerID}/${m.id}` : m.id;
  return typeof m.variant === "string" && m.variant ? `${base}#${m.variant}` : base;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function sessionStartPayload(data: Record<string, unknown>, cwd: string): HookPayload {
  return {
    hook_event_name: "SessionStart",
    session_id: data.sessionID,
    cwd: str(data.directory) ?? cwd,
    source: "startup",
    ...(str(data.parentID) ? { parent_session_id: data.parentID } : {}),
    ...(modelLabel(data.model) ? { model: modelLabel(data.model) } : {}),
  };
}

export function subagentStartPayload(data: Record<string, unknown>, cwd: string): HookPayload {
  return {
    hook_event_name: "SubagentStart",
    session_id: data.parentID,
    parent_session_id: data.parentID,
    subagent_id: data.sessionID,
    agent_type: str(data.agent) ?? "subagent",
    cwd: str(data.directory) ?? cwd,
  };
}

export function promptPayload(event: OpenCodeSessionPrompt, cwd: string): HookPayload {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: event.sessionID,
    cwd,
    ...(event.messageID ? { turn_id: event.messageID } : {}),
    ...(typeof event.prompt?.text === "string" ? { prompt: event.prompt.text } : {}),
  };
}

export function toolBeforePayload(event: OpenCodeToolBefore, cwd: string): HookPayload {
  return {
    hook_event_name: "PreToolUse",
    session_id: event.sessionID,
    cwd,
    ...(event.messageID ? { turn_id: event.messageID } : {}),
    tool_name: harneryToolName(event.tool),
    tool_input: event.input ?? null,
    tool_use_id: event.id,
  };
}

export function toolAfterPayload(
  event: OpenCodeToolAfter,
  cwd: string,
): { subcommand: "post-tool-use" | "post-tool-use-failure"; payload: HookPayload } {
  const base = {
    session_id: event.sessionID,
    cwd,
    ...(event.messageID ? { turn_id: event.messageID } : {}),
    tool_name: harneryToolName(event.tool),
    tool_input: event.input ?? null,
    tool_use_id: event.id,
  };
  if (event.status === "error") {
    return {
      subcommand: "post-tool-use-failure",
      payload: {
        hook_event_name: "PostToolUseFailure",
        ...base,
        tool_response: errorText(event.error),
        reason: errorText(event.error),
      },
    };
  }
  return {
    subcommand: "post-tool-use",
    payload: {
      hook_event_name: "PostToolUse",
      ...base,
      tool_response: toolResultText(event.result),
    },
  };
}

/** Flatten an OpenCode `Tool.Result` to the text agent-hook summarizes. */
export function toolResultText(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as { output?: unknown; content?: unknown };
  if (typeof r.output === "string") return r.output;
  if (typeof r.content === "string") return r.content;
  if (Array.isArray(r.content)) {
    const texts = r.content
      .map((part) =>
        part && typeof part === "object" ? (part as { text?: unknown }).text : undefined,
      )
      .filter((t): t is string => typeof t === "string");
    if (texts.length > 0) return texts.join("\n");
  }
  return result;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return typeof error === "string" ? error : JSON.stringify(error ?? null);
}

export function permissionPayload(event: OpenCodePermissionEvaluation, cwd: string): HookPayload {
  return {
    hook_event_name: "PermissionRequest",
    session_id: event.sessionID,
    cwd,
    tool_name: harneryToolName(event.action),
    tool_input: {
      resources: [...event.resources],
      ...(event.message ? { description: event.message } : {}),
      effect: event.effect,
    },
    ...(event.source?.id ? { tool_use_id: event.source.id } : {}),
  };
}

export function compactionPayload(event: OpenCodeSessionRequest, cwd: string): HookPayload {
  return {
    hook_event_name: "PreCompact",
    session_id: event.sessionID,
    cwd,
    trigger: "auto",
    ...(modelLabel(event.model) ? { model: modelLabel(event.model) } : {}),
  };
}

export function turnEndPayload(
  type:
    | "session.execution.succeeded"
    | "session.execution.failed"
    | "session.execution.interrupted",
  data: Record<string, unknown>,
  cwd: string,
  child: boolean,
): { subcommand: "stop" | "stop-failure" | "sub-agent-stop"; payload: HookPayload } {
  const ok = type === "session.execution.succeeded";
  const status = ok ? "ok" : type === "session.execution.failed" ? "error" : "interrupted";
  const reason = ok ? undefined : (str(data.reason) ?? errorText(data.error));
  if (child) {
    return {
      subcommand: "sub-agent-stop",
      payload: {
        hook_event_name: "SubagentStop",
        session_id: data.sessionID,
        cwd,
        exit_status: status,
        ...(reason ? { reason } : {}),
      },
    };
  }
  if (ok) {
    return {
      subcommand: "stop",
      payload: {
        hook_event_name: "Stop",
        session_id: data.sessionID,
        cwd,
        stop_hook_active: false,
      },
    };
  }
  return {
    subcommand: "stop-failure",
    payload: {
      hook_event_name: "StopFailure",
      session_id: data.sessionID,
      cwd,
      ...(reason ? { reason } : {}),
    },
  };
}

export function sessionEndPayload(data: Record<string, unknown>, cwd: string): HookPayload {
  return {
    hook_event_name: "SessionEnd",
    session_id: data.sessionID,
    cwd,
    clean_exit: true,
    reason: "deleted",
  };
}

// ── agent-hook stdout interpretation (pure; unit-tested) ─────────────────────

export interface HookOutcome {
  /** `additionalContext` text agent-hook asked to inject, if any. */
  context?: string;
  /** A PreToolUse deny reason, if agent-hook blocked the call. */
  deny?: string;
}

/** Read the Claude-shaped `hookSpecificOutput` envelope agent-hook writes for this adapter. */
export function interpretHookStdout(stdout: string): HookOutcome {
  const outcome: HookOutcome = {};
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let json: { hookSpecificOutput?: Record<string, unknown> };
    try {
      json = JSON.parse(trimmed) as typeof json;
    } catch {
      continue;
    }
    const out = json.hookSpecificOutput;
    if (!out) continue;
    if (typeof out.additionalContext === "string" && out.additionalContext) {
      outcome.context = outcome.context
        ? `${outcome.context}\n\n${out.additionalContext}`
        : out.additionalContext;
    }
    if (out.permissionDecision === "deny") {
      outcome.deny =
        typeof out.permissionDecisionReason === "string" && out.permissionDecisionReason
          ? out.permissionDecisionReason
          : "Blocked by Harnery coordination guard.";
    }
  }
  return outcome;
}

// ── Bridge runtime ───────────────────────────────────────────────────────────

export interface BridgeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}
export type Bridge = (subcommand: string, payload: HookPayload) => Promise<BridgeResult>;

/** Spawn `agent-hook` with the payload on stdin. Never throws. */
export function createAgentHookBridge(config: HarneryOpenCodeConfig): Bridge {
  return (subcommand, payload) =>
    new Promise<BridgeResult>((resolvePromise) => {
      const [bin, ...args] = agentHookArgv(config, subcommand);
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const finish = (result: BridgeResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(result);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin!, args, {
          cwd: config.projectRoot,
          env: { ...process.env, HARNERY_AGENT_COORD_PLATFORM: ADAPTER },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        finish({ exitCode: null, stdout, stderr, timedOut, error: errorText(error) });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, config.timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) =>
        finish({ exitCode: null, stdout, stderr, timedOut, error: errorText(error) }),
      );
      child.on("close", (code) => finish({ exitCode: code, stdout, stderr, timedOut }));
      try {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(JSON.stringify(payload));
      } catch (error) {
        finish({ exitCode: null, stdout, stderr, timedOut, error: errorText(error) });
      }
    });
}

export interface PluginDependencies {
  bridge?: Bridge;
  config?: HarneryOpenCodeConfig;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  /** Override the plugin directory (tests); defaults to this file's directory. */
  pluginDir?: string;
}

function defaultPluginDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

function fileLogger(
  projectRoot: string,
): (event: string, detail?: Record<string, unknown>) => void {
  const dir = resolve(projectRoot, ".harnery", "debug");
  const file = resolve(dir, "opencode-plugin.ndjson");
  return (event, detail) => {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        file,
        `${JSON.stringify({ ts: new Date().toISOString(), event, ...detail })}\n`,
      );
    } catch {
      /* logging is best-effort */
    }
  };
}

/**
 * Build the plugin definition. `deps` exist for tests: a fake bridge records
 * the payloads instead of spawning `agent-hook`.
 */
export function createHarneryOpenCodePlugin(deps: PluginDependencies = {}) {
  return {
    id: HARNERY_OPENCODE_PLUGIN_ID,
    async setup(ctx: OpenCodePluginContext): Promise<() => Promise<void>> {
      const pluginDir = deps.pluginDir ?? defaultPluginDir();
      const config = deps.config ?? loadHarneryOpenCodeConfig(pluginDir);
      // agent-hook resolves its coord root from cwd, so the bridge runs from
      // the project root. Prefer OpenCode's own location for the payload cwd.
      const cwd = ctx.location?.directory || config.projectRoot;
      const log = deps.log ?? fileLogger(config.projectRoot);
      const bridge = deps.bridge ?? createAgentHookBridge(config);
      /** Child (subagent) sessions seen on the bus, so turn ends map to sub-agent-stop. */
      const children = new Set<string>();
      /** Per-turn context agent-hook asked to inject, pushed into every model call's system prompt. */
      const turnContext = new Map<string, string>();
      /** shell command → session id, so the shell hook (which carries no session) can stamp the env. */
      const pendingShells = new Map<string, string>();
      let lastToolSession: string | undefined;

      const run = async (subcommand: string, payload: HookPayload): Promise<HookOutcome> => {
        const result = await bridge(subcommand, payload);
        if (result.error || result.timedOut || (result.exitCode !== 0 && result.exitCode !== 2)) {
          log("bridge_failure", {
            subcommand,
            exit_code: result.exitCode,
            timed_out: result.timedOut,
            error: result.error,
            stderr: result.stderr.slice(0, 2000),
          });
          return {};
        }
        // Exit 2 is Claude Code's Stop-block channel. OpenCode cannot block a
        // turn, so the verdict is recorded (agent-hook already wrote it) and
        // the reason is kept in the plugin log only.
        if (result.exitCode === 2) {
          log("stop_verdict_observed", { subcommand, stderr: result.stderr.slice(0, 2000) });
        }
        return interpretHookStdout(result.stdout);
      };

      const inject = async (sessionID: string, text: string): Promise<void> => {
        if (!text) return;
        try {
          await ctx.session.synthetic({ sessionID, text, description: CONTEXT_DESCRIPTION });
        } catch (error) {
          log("synthetic_failure", { session_id: sessionID, error: errorText(error) });
        }
      };

      const registrations: OpenCodeRegistration[] = [];
      const register = async <T>(
        hook: Hook<T>,
        name: string,
        cb: (event: T) => Promise<void> | void,
      ) => {
        registrations.push(
          await hook(name, async (event) => {
            try {
              await cb(event);
            } catch (error) {
              if (error instanceof HarneryDeny) throw error;
              log("handler_failure", { hook: name, error: errorText(error) });
            }
          }),
        );
      };

      await register<OpenCodeSessionPrompt>(
        ctx.session.hook as Hook<OpenCodeSessionPrompt>,
        "prompt",
        async (event) => {
          const outcome = await run("user-prompt-submit", promptPayload(event, cwd));
          if (outcome.context) turnContext.set(event.sessionID, outcome.context);
          else turnContext.delete(event.sessionID);
        },
      );
      await register<OpenCodeSessionRequest>(
        ctx.session.hook as Hook<OpenCodeSessionRequest>,
        "context",
        (event) => {
          const text = turnContext.get(event.sessionID);
          if (text && Array.isArray(event.system)) event.system.push({ type: "text", text });
        },
      );
      await register<OpenCodeSessionRequest>(
        ctx.session.hook as Hook<OpenCodeSessionRequest>,
        "compaction",
        async (event) => {
          await run("pre-compact", compactionPayload(event, cwd));
        },
      );
      await register<OpenCodeToolBefore>(
        ctx.tool.hook as Hook<OpenCodeToolBefore>,
        "execute.before",
        async (event) => {
          lastToolSession = event.sessionID;
          const command =
            event.input && typeof event.input === "object"
              ? (event.input as { command?: unknown }).command
              : undefined;
          if (typeof command === "string") pendingShells.set(command, event.sessionID);
          const outcome = await run("pre-tool-use", toolBeforePayload(event, cwd));
          if (outcome.deny) throw new HarneryDeny(outcome.deny);
        },
      );
      await register<OpenCodeToolAfter>(
        ctx.tool.hook as Hook<OpenCodeToolAfter>,
        "execute.after",
        async (event) => {
          const { subcommand, payload } = toolAfterPayload(event, cwd);
          await run(subcommand, payload);
        },
      );
      await register<OpenCodePermissionEvaluation>(
        ctx.permission.hook,
        "evaluate",
        async (event) => {
          await run("permission-request", permissionPayload(event, cwd));
        },
      );
      await register<OpenCodeShellCreateBefore>(ctx.shell.hook, "create.before", (event) => {
        const sessionID = pendingShells.get(event.command) ?? lastToolSession;
        if (typeof event.command === "string") pendingShells.delete(event.command);
        if (!event.env) return;
        // PATH is session-independent, so stamp it even for a shell the plugin
        // cannot attribute to a session.
        prependShellPath(event.env, config.projectRoot);
        if (!sessionID) return;
        event.env[OPENCODE_SESSION_ENV] = sessionID;
        event.env.HARNERY_AGENT_COORD_PLATFORM = ADAPTER;
      });

      const controller = new AbortController();
      const handleBus = async (event: OpenCodeBusEvent): Promise<void> => {
        if (
          event.location?.directory &&
          ctx.location?.directory &&
          event.location.directory !== ctx.location.directory
        ) {
          return;
        }
        const data = event.data ?? {};
        const sessionID = str(data.sessionID);
        if (!sessionID) return;
        switch (event.type) {
          case "session.created": {
            if (str(data.parentID)) {
              children.add(sessionID);
              const outcome = await run("sub-agent-start", subagentStartPayload(data, cwd));
              if (outcome.context) await inject(sessionID, outcome.context);
              return;
            }
            const outcome = await run("session-start", sessionStartPayload(data, cwd));
            if (outcome.context) await inject(sessionID, outcome.context);
            return;
          }
          case "session.execution.succeeded":
          case "session.execution.failed":
          case "session.execution.interrupted": {
            turnContext.delete(sessionID);
            const { subcommand, payload } = turnEndPayload(
              event.type,
              data,
              cwd,
              children.has(sessionID),
            );
            await run(subcommand, payload);
            return;
          }
          case "session.deleted": {
            turnContext.delete(sessionID);
            children.delete(sessionID);
            await run("session-end", sessionEndPayload(data, cwd));
            return;
          }
          default:
            return;
        }
      };
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
              await handleBus(event);
            } catch (error) {
              log("bus_handler_failure", { type: event.type, error: errorText(error) });
            }
          }
        } catch (error) {
          if (!controller.signal.aborted)
            log("bus_subscription_ended", { error: errorText(error) });
        }
      })();

      log("plugin_ready", { project_root: config.projectRoot, agent_hook: config.agentHook, cwd });

      return async () => {
        controller.abort();
        for (const registration of registrations.splice(0)) {
          try {
            await registration.dispose();
          } catch {
            /* disposing on shutdown */
          }
        }
      };
    },
  };
}

/** Thrown from `execute.before` to reject a tool call; OpenCode surfaces the message to the model. */
export class HarneryDeny extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "HarneryDeny";
  }
}

export default createHarneryOpenCodePlugin();
