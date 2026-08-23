import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TSchema } from "@sinclair/typebox";
import { whichBin } from "../../lib/headless/index.ts";
import {
  type SemanticConfiguredModel,
  type SemanticHarness,
  SemanticModelReplyV2Schema,
} from "./contract.ts";
import type { SemanticReaderResolution } from "./storage.ts";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;

export interface SemanticReaderRoute {
  harness: SemanticHarness;
  binary: string;
  configured_model: SemanticConfiguredModel;
  invocation_model_id: string;
}

export interface SemanticAdapterSuccess {
  ok: true;
  text: string;
  resolved_model_id: string;
  model_attestation: "verified" | "requested-only";
  duration_ms: number;
  output_bytes: number;
}

export interface SemanticAdapterFailure {
  ok: false;
  reason_code:
    | "harness_unavailable"
    | "authentication_unavailable"
    | "model_unavailable"
    | "model_mismatch";
  resolved_model_id?: string;
  model_attestation?: "verified" | "requested-only";
  duration_ms: number;
}

export type SemanticAdapterResult = SemanticAdapterSuccess | SemanticAdapterFailure;

export interface SemanticAdapter {
  readonly route: SemanticReaderRoute;
  discover(now?: () => Date): SemanticReaderResolution;
  invoke(
    prompt: string,
    timeoutMs?: number,
    responseSchema?: TSchema,
  ): Promise<SemanticAdapterResult>;
}

export const SEMANTIC_READER_ROUTES: Record<SemanticHarness, SemanticReaderRoute> = {
  "claude-code": {
    harness: "claude-code",
    binary: "claude",
    configured_model: "haiku-4.5",
    invocation_model_id: "claude-haiku-4-5-20251001",
  },
  codex: {
    harness: "codex",
    binary: "codex",
    configured_model: "gpt-5.6-luna",
    invocation_model_id: "gpt-5.6-luna",
  },
  cursor: {
    harness: "cursor",
    binary: "cursor-agent",
    configured_model: "composer-2.5",
    invocation_model_id: "composer-2.5",
  },
};

export function createSemanticAdapters(): Record<SemanticHarness, SemanticAdapter> {
  return {
    "claude-code": createAdapter(SEMANTIC_READER_ROUTES["claude-code"]),
    codex: createAdapter(SEMANTIC_READER_ROUTES.codex),
    cursor: createAdapter(SEMANTIC_READER_ROUTES.cursor),
  };
}

export function discoverSemanticReaders(
  adapters: Record<SemanticHarness, SemanticAdapter> = createSemanticAdapters(),
): Record<SemanticHarness, SemanticReaderResolution> {
  return {
    "claude-code": adapters["claude-code"].discover(),
    codex: adapters.codex.discover(),
    cursor: adapters.cursor.discover(),
  };
}

function createAdapter(route: SemanticReaderRoute): SemanticAdapter {
  return {
    route,
    discover(now = () => new Date()) {
      const installed = whichBin(route.binary) !== undefined;
      return {
        harness: route.harness,
        configured_model: route.configured_model,
        ...(installed
          ? {
              resolved_model_id: route.invocation_model_id,
              model_attestation: "requested-only" as const,
              available: true,
            }
          : { available: false, reason_code: "harness_unavailable" as const }),
        discovered_at: now().toISOString(),
      };
    },
    async invoke(
      prompt,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      responseSchema = SemanticModelReplyV2Schema,
    ) {
      if (!whichBin(route.binary)) {
        return { ok: false, reason_code: "harness_unavailable", duration_ms: 0 };
      }
      return await invokeRoute(route, prompt, timeoutMs, responseSchema);
    },
  };
}

async function invokeRoute(
  route: SemanticReaderRoute,
  prompt: string,
  timeoutMs: number,
  responseSchema: TSchema,
): Promise<SemanticAdapterResult> {
  const dir = mkdtempSync(join(tmpdir(), "harnery-semantic-"));
  const started = Date.now();
  try {
    const invocation = buildInvocation(route, prompt, dir, responseSchema);
    const pending = execFileAsync(route.binary, invocation.args, {
      cwd: dir,
      env: semanticChildEnv(),
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    const raw = invocation.outputFile ? readFileSync(invocation.outputFile, "utf8") : stdout;
    const parsed = parseHarnessOutput(route.harness, raw);
    if (!parsed.text.trim()) throw new Error("empty semantic response");
    if (parsed.executedModelId && parsed.executedModelId !== route.invocation_model_id) {
      return {
        ok: false,
        reason_code: "model_mismatch",
        resolved_model_id: parsed.executedModelId,
        model_attestation: "verified",
        duration_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      text: parsed.text,
      resolved_model_id: parsed.executedModelId ?? route.invocation_model_id,
      model_attestation: parsed.executedModelId ? "verified" : "requested-only",
      duration_ms: Date.now() - started,
      output_bytes: Buffer.byteLength(parsed.text),
    };
  } catch (error) {
    return {
      ok: false,
      reason_code: classifyFailure(error),
      resolved_model_id: route.invocation_model_id,
      model_attestation: "requested-only",
      duration_ms: Date.now() - started,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function buildInvocation(
  route: SemanticReaderRoute,
  prompt: string,
  dir: string,
  responseSchema: TSchema,
): { args: string[]; outputFile?: string } {
  if (route.harness === "claude-code") {
    return {
      args: [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(responseSchema),
        "--model",
        route.invocation_model_id,
        "--effort",
        "low",
        "--max-turns",
        "1",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--safe-mode",
        "--no-session-persistence",
      ],
    };
  }
  if (route.harness === "codex") {
    const outputFile = join(dir, "last-message.json");
    return {
      outputFile,
      args: [
        "exec",
        "--model",
        route.invocation_model_id,
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--output-last-message",
        outputFile,
        "--cd",
        dir,
        prompt,
      ],
    };
  }
  return {
    args: [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--mode",
      "ask",
      "--sandbox",
      "enabled",
      "--trust",
      "--model",
      route.invocation_model_id,
    ],
  };
}

function parseHarnessOutput(
  harness: SemanticHarness,
  raw: string,
): { text: string; executedModelId?: string } {
  if (harness === "codex") return { text: raw };
  try {
    const envelope = JSON.parse(raw) as {
      is_error?: boolean;
      result?: unknown;
      model?: unknown;
    };
    if (envelope.is_error) throw new Error("harness returned an error envelope");
    return {
      text: typeof envelope.result === "string" ? envelope.result : "",
      ...(typeof envelope.model === "string" ? { executedModelId: envelope.model } : {}),
    };
  } catch (error) {
    if (error instanceof SyntaxError) return { text: raw };
    throw error;
  }
}

function semanticChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("HARNERY_") || key === "CODEX_THREAD_ID" || key === "CLAUDECODE") {
      delete env[key];
    }
  }
  return env;
}

function classifyFailure(error: unknown): SemanticAdapterFailure["reason_code"] {
  const value = error as NodeJS.ErrnoException;
  if (value.code === "ENOENT") return "harness_unavailable";
  const message = value.message ?? String(error);
  if (/auth|login|credential|unauthorized|forbidden/i.test(message)) {
    return "authentication_unavailable";
  }
  if (/model.*(?:not found|unknown|unavailable|unsupported)|invalid.*model/i.test(message)) {
    return "model_unavailable";
  }
  return "model_unavailable";
}
