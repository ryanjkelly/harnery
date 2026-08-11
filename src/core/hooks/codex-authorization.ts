import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type CodexHookTrustStatus = "managed" | "trusted" | "untrusted" | "modified";

export type CodexHookAuthorizationStatus =
  | "runnable"
  | "review_required"
  | "disabled"
  | "not_wired"
  | "error";

export interface CodexHookAuthorizationResult {
  status: CodexHookAuthorizationStatus;
  detail: string;
  hookCount: number;
  disabledCount: number;
  trustCounts: Partial<Record<CodexHookTrustStatus, number>>;
}

export interface CodexHookAuthorizationProbeOptions {
  cwd: string;
  codexBin?: string;
  appServerArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface JsonObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function trustStatus(value: unknown): CodexHookTrustStatus | null {
  return value === "managed" || value === "trusted" || value === "untrusted" || value === "modified"
    ? value
    : null;
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}

/**
 * Convert Codex app-server's `hooks/list` response into the one authorization
 * state doctor needs. This is intentionally read-only: hashes are observed but
 * never persisted, and only commands containing Harnery's `agent-hook` binary
 * are included in the result.
 */
export function assessCodexHookList(response: unknown, cwd: string): CodexHookAuthorizationResult {
  if (!isObject(response) || !isObject(response.result) || !Array.isArray(response.result.data)) {
    return {
      status: "error",
      detail: "Codex hooks/list returned an invalid response",
      hookCount: 0,
      disabledCount: 0,
      trustCounts: {},
    };
  }

  const entries = response.result.data.filter(isObject);
  const expected = normalizedPath(cwd);
  const entry =
    entries.find((candidate) => {
      const candidateCwd = candidate.cwd;
      return typeof candidateCwd === "string" && normalizedPath(candidateCwd) === expected;
    }) ?? (entries.length === 1 ? entries[0] : undefined);
  if (!entry) {
    return {
      status: "error",
      detail: "Codex hooks/list omitted the requested workspace",
      hookCount: 0,
      disabledCount: 0,
      trustCounts: {},
    };
  }

  const errors = stringArray(entry.errors);
  if (errors.length > 0) {
    return {
      status: "error",
      detail: `Codex could not load hooks: ${errors.join("; ")}`,
      hookCount: 0,
      disabledCount: 0,
      trustCounts: {},
    };
  }

  const hooks = Array.isArray(entry.hooks) ? entry.hooks.filter(isObject) : [];
  const harneryHooks = hooks.filter(
    (hook) =>
      typeof hook.command === "string" && /(?:^|[\\/\s])agent-hook(?:\s|$)/.test(hook.command),
  );
  if (harneryHooks.length === 0) {
    return {
      status: "not_wired",
      detail: "Codex discovered no Harnery hooks",
      hookCount: 0,
      disabledCount: 0,
      trustCounts: {},
    };
  }

  const counts: Partial<Record<CodexHookTrustStatus, number>> = {};
  let disabledCount = 0;
  for (const hook of harneryHooks) {
    const status = trustStatus(hook.trustStatus);
    if (!status) {
      return {
        status: "error",
        detail: "Codex returned an unknown hook trust state",
        hookCount: harneryHooks.length,
        disabledCount,
        trustCounts: counts,
      };
    }
    counts[status] = (counts[status] ?? 0) + 1;
    if (hook.enabled !== true) disabledCount += 1;
  }

  const reviewCount = (counts.untrusted ?? 0) + (counts.modified ?? 0);
  const warnings = stringArray(entry.warnings);
  const warningSuffix = warnings.length > 0 ? `; ${warnings.length} Codex warning(s)` : "";
  if (reviewCount > 0) {
    return {
      status: "review_required",
      detail:
        `${reviewCount} of ${harneryHooks.length} Harnery hooks require review` +
        ` (${counts.untrusted ?? 0} new, ${counts.modified ?? 0} modified)${warningSuffix}`,
      hookCount: harneryHooks.length,
      disabledCount,
      trustCounts: counts,
    };
  }
  if (disabledCount > 0) {
    return {
      status: "disabled",
      detail: `${disabledCount} of ${harneryHooks.length} trusted Harnery hooks are disabled${warningSuffix}`,
      hookCount: harneryHooks.length,
      disabledCount,
      trustCounts: counts,
    };
  }
  return {
    status: "runnable",
    detail: `${harneryHooks.length} Harnery hooks trusted and enabled${warningSuffix}`,
    hookCount: harneryHooks.length,
    disabledCount: 0,
    trustCounts: counts,
  };
}

/**
 * Ask the active Codex CLI for hook authorization through its app-server
 * protocol. The child is closed as soon as `hooks/list` responds. Harnery never
 * calls the trust-write method and never reads Codex's private config format.
 */
export function probeCodexHookAuthorization(
  options: CodexHookAuthorizationProbeOptions,
): Promise<CodexHookAuthorizationResult> {
  const codexBin = options.codexBin ?? "codex";
  const args = options.appServerArgs ?? ["app-server"];
  const timeoutMs = options.timeoutMs ?? 5_000;

  return new Promise((resolve) => {
    const child = spawn(codexBin, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let stderr = "";

    const finish = (result: CodexHookAuthorizationResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      resolve(result);
    };
    const fail = (detail: string): void =>
      finish({ status: "error", detail, hookCount: 0, disabledCount: 0, trustCounts: {} });

    const timer = setTimeout(() => {
      fail(`Codex hooks/list timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 4_096) stderr += chunk.toString();
    });
    child.stdin.on("error", (error) => fail(`Codex app-server input failed: ${error.message}`));
    child.on("error", (error) => fail(`could not start Codex app-server: ${error.message}`));
    child.on("close", (code) => {
      if (!settled) {
        const suffix = stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : "";
        fail(
          `Codex app-server exited before hooks/list completed (exit ${code ?? "unknown"})${suffix}`,
        );
      }
    });
    lines.on("line", (line) => {
      let message: JsonObject;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isObject(parsed)) return;
        message = parsed;
      } catch {
        return;
      }
      if (message.id === 0) {
        if (message.error) {
          fail("Codex app-server rejected initialization");
          return;
        }
        child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
        child.stdin.write(
          `${JSON.stringify({ method: "hooks/list", id: 1, params: { cwds: [options.cwd] } })}\n`,
        );
        return;
      }
      if (message.id === 1) {
        if (message.error) {
          fail("Codex app-server rejected hooks/list");
          return;
        }
        finish(assessCodexHookList(message, options.cwd));
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        method: "initialize",
        id: 0,
        params: {
          clientInfo: { name: "harnery_doctor", title: "Harnery Doctor", version: "0.0.0" },
        },
      })}\n`,
    );
  });
}
