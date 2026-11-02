/**
 * What the coding agents on this computer are allowed to do, read from each
 * tool's own settings: Claude Code's settings files, Codex's effective
 * configuration and hook trust (asked through `codex app-server`), Cursor's
 * CLI configuration, and every live desktop-control approval on this
 * computer. Read-only; it never changes a setting.
 *
 * Only permission-related fields are read back. Settings files also hold
 * account details, environment variables and tokens; none of those leave
 * this module.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stripJsonComments } from "../config.ts";

// ----------------------------------------------------------------- shared

export interface SettingsSource {
  /** Where this file sits in its tool's order, most specific last. */
  scope: string;
  path: string;
  exists: boolean;
  /** Set when the file exists but could not be parsed. */
  error?: string;
}

function readJson(path: string): {
  exists: boolean;
  value?: Record<string, unknown>;
  error?: string;
} {
  if (!existsSync(path)) return { exists: false };
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, error: "not a JSON object" };
    }
    return { exists: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    return { exists: true, error: (err as Error).message };
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export interface Rule {
  rule: string;
  /** The `scope` of the file it came from. */
  source: string;
}

// ------------------------------------------------------------ Claude Code

export interface ClaudeSource extends SettingsSource {
  defaultMode?: string;
  allow: string[];
  ask: string[];
  deny: string[];
  additionalDirectories: string[];
  disableBypassPermissionsMode?: string;
  sandboxEnabled?: boolean;
}

export interface ClaudePermissions {
  configDir: string;
  sources: ClaudeSource[];
  effective: {
    defaultMode: string;
    defaultModeSource: string;
    allow: Rule[];
    ask: Rule[];
    deny: Rule[];
    additionalDirectories: Rule[];
    bypassDisabled: boolean;
    sandboxEnabled: boolean;
  };
}

/** Claude Code's enterprise policy file for this platform. */
export function claudeManagedSettingsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

export function readClaudePermissions(
  projectRoot: string,
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string } = {},
): ClaudePermissions {
  const env = opts.env ?? process.env;
  const configDir = str(env.CLAUDE_CONFIG_DIR) ?? join(opts.home ?? homedir(), ".claude");
  // Lowest precedence first; Claude Code applies the most specific last,
  // and managed policy overrides everything.
  const files: Array<{ scope: string; path: string }> = [
    { scope: "user", path: join(configDir, "settings.json") },
    { scope: "project (shared)", path: join(projectRoot, ".claude", "settings.json") },
    { scope: "project (this computer)", path: join(projectRoot, ".claude", "settings.local.json") },
    { scope: "managed policy", path: claudeManagedSettingsPath(opts.platform) },
  ];
  const sources: ClaudeSource[] = files.map(({ scope, path }) => {
    const read = readJson(path);
    const perms = (read.value?.permissions ?? {}) as Record<string, unknown>;
    const sandbox = (read.value?.sandbox ?? {}) as Record<string, unknown>;
    return {
      scope,
      path,
      exists: read.exists,
      ...(read.error ? { error: read.error } : {}),
      ...(str(perms.defaultMode) ? { defaultMode: str(perms.defaultMode) } : {}),
      allow: strings(perms.allow),
      ask: strings(perms.ask),
      deny: strings(perms.deny),
      additionalDirectories: strings(perms.additionalDirectories),
      ...(str(perms.disableBypassPermissionsMode)
        ? { disableBypassPermissionsMode: str(perms.disableBypassPermissionsMode) }
        : {}),
      ...(typeof sandbox.enabled === "boolean" ? { sandboxEnabled: sandbox.enabled } : {}),
    };
  });

  let defaultMode = "default";
  let defaultModeSource = "Claude Code's default";
  let sandboxEnabled = false;
  for (const s of sources) {
    if (s.defaultMode) {
      defaultMode = s.defaultMode;
      defaultModeSource = s.scope;
    }
    if (s.sandboxEnabled !== undefined) sandboxEnabled = s.sandboxEnabled;
  }
  const collect = (key: "allow" | "ask" | "deny" | "additionalDirectories"): Rule[] =>
    sources.flatMap((s) => s[key].map((rule) => ({ rule, source: s.scope })));
  return {
    configDir,
    sources,
    effective: {
      defaultMode,
      defaultModeSource,
      allow: collect("allow"),
      ask: collect("ask"),
      deny: collect("deny"),
      additionalDirectories: collect("additionalDirectories"),
      bypassDisabled: sources.some((s) => s.disableBypassPermissionsMode === "disable"),
      sandboxEnabled,
    },
  };
}

// ----------------------------------------------------------------- Cursor

export interface CursorSource extends SettingsSource {
  allow: string[];
  deny: string[];
  approvalMode?: string;
  sandboxMode?: string;
  sandboxNetwork?: string;
  autoAcceptWebSearch?: boolean;
}

export interface CursorPermissions {
  sources: CursorSource[];
  effective: {
    approvalMode?: string;
    sandboxMode?: string;
    allow: Rule[];
    deny: Rule[];
    autoAcceptWebSearch?: boolean;
  };
}

export function readCursorPermissions(
  projectRoot: string,
  opts: { home?: string } = {},
): CursorPermissions {
  const files = [
    { scope: "user", path: join(opts.home ?? homedir(), ".cursor", "cli-config.json") },
    { scope: "project", path: join(projectRoot, ".cursor", "cli.json") },
  ];
  const sources: CursorSource[] = files.map(({ scope, path }) => {
    const read = readJson(path);
    const v = read.value ?? {};
    const perms = (v.permissions ?? {}) as Record<string, unknown>;
    const sandbox = (v.sandbox ?? {}) as Record<string, unknown>;
    return {
      scope,
      path,
      exists: read.exists,
      ...(read.error ? { error: read.error } : {}),
      allow: strings(perms.allow),
      deny: strings(perms.deny),
      ...(str(v.approvalMode) ? { approvalMode: str(v.approvalMode) } : {}),
      ...(str(sandbox.mode) ? { sandboxMode: str(sandbox.mode) } : {}),
      ...(str(sandbox.networkAccess) ? { sandboxNetwork: str(sandbox.networkAccess) } : {}),
      ...(typeof v.autoAcceptWebSearch === "boolean"
        ? { autoAcceptWebSearch: v.autoAcceptWebSearch }
        : {}),
    };
  });
  const effective: CursorPermissions["effective"] = {
    allow: sources.flatMap((s) => s.allow.map((rule) => ({ rule, source: s.scope }))),
    deny: sources.flatMap((s) => s.deny.map((rule) => ({ rule, source: s.scope }))),
  };
  for (const s of sources) {
    if (s.approvalMode) effective.approvalMode = s.approvalMode;
    if (s.sandboxMode) effective.sandboxMode = s.sandboxMode;
    if (s.autoAcceptWebSearch !== undefined) effective.autoAcceptWebSearch = s.autoAcceptWebSearch;
  }
  return { sources, effective };
}

// ------------------------------------------------------------------ Codex

export interface CodexHook {
  event: string;
  command?: string;
  trust: string;
}

export interface CodexPermissions {
  /** False when Codex could not be asked; `error` says why. */
  available: boolean;
  error?: string;
  approvalPolicy?: string;
  sandboxMode?: string;
  networkAccess?: boolean;
  projectTrust?: string;
  hooks: CodexHook[];
}

/** Normalize a path the way Codex keys its `projects` table (case, `\\?\`, slashes). */
export function codexProjectKey(path: string): string {
  return path
    .replace(/^\\\\\?\\/, "")
    .replaceAll("/", "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

/** Turn `config/read` and `hooks/list` answers into the permission summary. Pure. */
export function summarizeCodex(
  projectRoot: string,
  config: unknown,
  hooksList: unknown,
): CodexPermissions {
  const c = ((config as { config?: unknown })?.config ?? {}) as Record<string, unknown>;
  const write = (c.sandbox_workspace_write ?? {}) as Record<string, unknown>;
  const projects = (c.projects ?? {}) as Record<string, { trust_level?: unknown }>;
  const want = codexProjectKey(projectRoot);
  let projectTrust: string | undefined;
  for (const [key, value] of Object.entries(projects)) {
    if (codexProjectKey(key) === want) projectTrust = str(value?.trust_level);
  }
  const entries = ((hooksList as { data?: unknown })?.data ?? []) as Array<{ hooks?: unknown }>;
  const hooks: CodexHook[] = entries.flatMap((entry) =>
    ((entry.hooks ?? []) as Array<Record<string, unknown>>).map((h) => ({
      event: str(h.eventName) ?? "unknown",
      ...(str(h.command) ? { command: str(h.command) } : {}),
      trust: str(h.trustStatus) ?? "unknown",
    })),
  );
  return {
    available: true,
    ...(str(c.approval_policy) ? { approvalPolicy: str(c.approval_policy) } : {}),
    ...(str(c.sandbox_mode) ? { sandboxMode: str(c.sandbox_mode) } : {}),
    ...(typeof write.network_access === "boolean" ? { networkAccess: write.network_access } : {}),
    ...(projectTrust ? { projectTrust } : {}),
    hooks,
  };
}

/**
 * Ask Codex itself (`codex app-server`) for its effective configuration and
 * this project's hook trust, so the answer matches what Codex enforces.
 */
export function readCodexPermissions(
  projectRoot: string,
  opts: { timeoutMs?: number; bin?: string } = {},
): Promise<CodexPermissions> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const unavailable = (error: string): CodexPermissions => ({ available: false, error, hooks: [] });
  return new Promise((done) => {
    let settled = false;
    const finish = (value: CodexPermissions) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      done(value);
    };
    // Windows npm installs Codex as a .cmd shim, which only a shell can start.
    // The arguments are fixed, so the shell sees no outside input.
    const child = spawn(opts.bin ?? "codex", ["app-server"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
    const timer = setTimeout(() => finish(unavailable("Codex did not answer in time")), timeoutMs);
    const pending = new Map<
      number,
      (message: { result?: unknown; error?: { message?: string } }) => void
    >();
    let nextId = 0;
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
          const message = JSON.parse(line) as {
            id?: number;
            result?: unknown;
            error?: { message?: string };
          };
          if (typeof message.id === "number") pending.get(message.id)?.(message);
        } catch {
          /* not a JSON-RPC line */
        }
      }
    });
    child.on("error", () => finish(unavailable("Codex is not installed or not on PATH")));
    child.on("exit", () => finish(unavailable("Codex's app-server exited")));
    const request = (method: string, params?: unknown) =>
      new Promise<unknown>((ok, fail) => {
        const id = ++nextId;
        pending.set(id, (message) => {
          pending.delete(id);
          if (message.error) fail(new Error(message.error.message ?? `${method} failed`));
          else ok(message.result);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    void (async () => {
      try {
        await request("initialize", { clientInfo: { name: "harnery-permissions", version: "1" } });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
        const config = await request("config/read", { includeLayers: false, cwd: projectRoot });
        const hooks = await request("hooks/list", { cwds: [projectRoot] });
        finish(summarizeCodex(projectRoot, config, hooks));
      } catch (err) {
        finish(unavailable((err as Error).message));
      }
    })();
  });
}

// --------------------------------------------------- desktop approvals

export interface LiveApproval {
  agent: string;
  project?: string;
  kind: string;
  purpose: string;
  grantedAt: string;
  expiresAt: string;
}

// ----------------------------------------------------------------- report

export interface PermissionsReport {
  projectRoot: string;
  generatedAt: string;
  claude: ClaudePermissions;
  codex: CodexPermissions;
  cursor: CursorPermissions;
  desktopApprovals: LiveApproval[];
}

export async function collectPermissions(
  projectRoot: string,
  opts: { codex?: boolean; approvals?: () => LiveApproval[] } = {},
): Promise<PermissionsReport> {
  const root = resolve(projectRoot);
  const codex =
    opts.codex === false
      ? { available: false, error: "skipped", hooks: [] }
      : await readCodexPermissions(root);
  return {
    projectRoot: root,
    generatedAt: new Date().toISOString(),
    claude: readClaudePermissions(root),
    codex,
    cursor: readCursorPermissions(root),
    desktopApprovals: opts.approvals?.() ?? [],
  };
}
