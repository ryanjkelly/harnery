import { type ChildProcess, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Adapter } from "../../adapter.ts";
import { hostPromptContextConfig } from "../../config.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "../../events/v3/fingerprint-keys.ts";
import { codexWslWorkspaceLinuxPath } from "../codex-wsl-bridge.ts";
import {
  buildPromptContextRequest,
  type PromptContextAuditV1,
  type PromptContextDelivery,
  type PromptContextResultV1,
  promptContextDelivery,
  validatePromptContextResult,
} from "./contract.ts";

const EXTENSION_RELATIVE_PATH = [
  "scripts",
  "hooks",
  "harness",
  "extensions",
  "prompt-context",
] as const;

const PROVIDER_ENV_ALLOWLIST = [
  "COLORTERM",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

const RESULT_KEYS = [
  "context",
  "failed",
  "matched",
  "provider_id",
  "reason_codes",
  "schema",
  "succeeded",
] as const;

export interface RunPromptContextInput {
  coordRoot: string;
  adapter: Adapter;
  sessionId: string;
  turnId: string;
  cwd: string;
  prompt: string;
  /** Test and embedding seam. Production callers should omit this. */
  sourceEnv?: NodeJS.ProcessEnv;
}

export interface PromptContextRunResult {
  context: string | null;
  delivery: PromptContextDelivery;
  audit: PromptContextAuditV1;
}

interface ChildResult {
  kind: "closed" | "error" | "oversized" | "timeout";
  stdout?: Buffer;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

/**
 * Run one project-owned prompt-context provider behind Harnery's normalized
 * prompt hook. Every provider failure returns metadata instead of throwing so
 * optional context can never make the user's turn unusable.
 */
export async function runPromptContext(
  input: RunPromptContextInput,
): Promise<PromptContextRunResult> {
  const startedAt = Date.now();
  const delivery = promptContextDelivery(input.adapter);
  const finish = (
    status: PromptContextAuditV1["status"],
    fields: Omit<PromptContextAuditV1, "status" | "delivery" | "elapsed_ms"> = {},
    context: string | null = null,
  ): PromptContextRunResult => ({
    context,
    delivery,
    audit: {
      status,
      delivery,
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      ...fields,
    },
  });

  try {
    const coordRoot = realDirectory(input.coordRoot);
    const config = hostPromptContextConfig(coordRoot);
    if (!config?.enabled) return finish("disabled");
    if (!input.prompt.trim()) return finish("no_prompt");

    const executable = join(coordRoot, ...EXTENSION_RELATIVE_PATH);
    if (!isRegularFile(executable)) return finish("missing_extension");

    const reportedCwd =
      input.adapter === "codex"
        ? (codexWslWorkspaceLinuxPath(coordRoot, input.cwd) ?? input.cwd)
        : input.cwd;
    const cwd = realDirectory(reportedCwd);
    const request = buildPromptContextRequest({
      adapter: input.adapter,
      sessionId: input.sessionId,
      turnId: input.turnId,
      cwd,
      prompt: input.prompt,
    });
    const child = await runExtension({
      executable,
      cwd,
      stdin: `${JSON.stringify(request)}\n`,
      env: providerEnvironment(input.sourceEnv ?? process.env),
      timeoutMs: config.timeoutMs,
      maxOutputBytes: config.maxOutputBytes,
    });

    if (child.kind === "timeout") return finish("timeout");
    if (child.kind === "oversized") return finish("oversized_result");
    if (child.kind === "error") return finish("missing_extension");
    if (child.signal) return finish("signal");
    if (child.code !== 0) return finish("nonzero_exit");

    const stdout = child.stdout ?? Buffer.alloc(0);
    const outputBytes = stdout.byteLength;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.toString("utf8"));
    } catch {
      return finish("invalid_result", { output_bytes: outputBytes });
    }
    if (!hasExactResultKeys(parsed)) {
      return finish("invalid_result", { output_bytes: outputBytes });
    }
    const validated = validatePromptContextResult(parsed);
    if (!validated.ok) return finish("invalid_result", { output_bytes: outputBytes });

    const auditFields = providerAudit(validated.value, outputBytes);
    if (!validated.value.context) return finish("empty", auditFields);

    const contextFingerprint = fingerprintContext(coordRoot, validated.value.context);
    return finish(
      "delivered",
      { ...auditFields, context_fingerprint: contextFingerprint },
      validated.value.context,
    );
  } catch {
    return finish("invalid_result");
  }
}

function providerAudit(
  result: PromptContextResultV1,
  outputBytes: number,
): Omit<PromptContextAuditV1, "status" | "delivery" | "elapsed_ms"> {
  return {
    provider_id: result.provider_id,
    matched: result.matched,
    succeeded: result.succeeded,
    failed: result.failed,
    reason_codes: [...result.reason_codes],
    output_bytes: outputBytes,
  };
}

function fingerprintContext(coordRoot: string, context: string): string {
  const store = loadOrCreateFingerprintKeyStoreV3(coordRoot);
  const epoch = store.epochs.find((candidate) => candidate.epoch_id === store.active_epoch_id);
  if (!epoch) throw new Error("active fingerprint key is unavailable");
  const key = Buffer.from(epoch.key_base64url, "base64url");
  const digest = createHmac("sha256", key)
    .update("harnery:prompt-context:v1\0", "utf8")
    .update(context.normalize("NFC"), "utf8")
    .digest("hex");
  return `hmac-sha256:${digest}`;
}

function providerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PROVIDER_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function hasExactResultKeys(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === RESULT_KEYS.length && keys.every((key, index) => key === RESULT_KEYS[index])
  );
}

function realDirectory(path: string): string {
  const real = realpathSync(resolve(path));
  if (!statSync(real).isDirectory()) throw new Error("workspace is not a directory");
  return real;
}

function isRegularFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function runExtension(options: {
  executable: string;
  cwd: string;
  stdin: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<ChildResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    let timedOut = false;
    let oversized = false;
    let stdoutBytes = 0;
    const stdout: Buffer[] = [];

    const finish = (result: ChildResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const child = spawn(options.executable, [], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killExtension(child);
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > options.maxOutputBytes) {
        oversized = true;
        killExtension(child);
        return;
      }
      stdout.push(bytes);
    });
    child.stdin.on("error", () => {
      // The process outcome below remains authoritative. Broken input is
      // represented as a nonzero exit, signal, or invalid empty result.
    });
    child.on("error", () => finish({ kind: "error" }));
    child.on("close", (code, signal) => {
      if (timedOut) return finish({ kind: "timeout" });
      if (oversized) return finish({ kind: "oversized" });
      return finish({ kind: "closed", stdout: Buffer.concat(stdout), code, signal });
    });
    child.stdin.end(options.stdin);
  });
}

function killExtension(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The process may have exited between the output/timeout boundary and
      // this signal. Fall through to the ordinary child handle.
    }
  }
  child.kill("SIGKILL");
}
