import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TSchema } from "@sinclair/typebox";
import { whichBin } from "../../lib/headless/index.ts";
import {
  type SemanticHarness,
  SemanticModelReplyV2Schema,
  type SemanticUsageReceiptV1,
} from "./contract.ts";
import { SEMANTIC_READER_ROUTES, type SemanticReaderRoute } from "./routes.ts";
import type { SemanticReaderResolution } from "./storage.ts";
import {
  estimateVisibleSemanticUsage,
  nativeSemanticUsage,
  unreportedSemanticUsage,
} from "./usage.ts";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;

export interface SemanticAdapterSuccess {
  ok: true;
  text: string;
  resolved_model_id: string;
  model_attestation: "verified" | "requested-only";
  duration_ms: number;
  output_bytes: number;
  usage: SemanticUsageReceiptV1;
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
  usage: SemanticUsageReceiptV1;
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

export { SEMANTIC_READER_ROUTES, type SemanticReaderRoute } from "./routes.ts";

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
        return {
          ok: false,
          reason_code: "harness_unavailable",
          duration_ms: 0,
          usage: unreportedSemanticUsage(),
        };
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
    const outputFileText = invocation.outputFile
      ? readFileSync(invocation.outputFile, "utf8")
      : undefined;
    const parsed = parseSemanticHarnessOutput(route.harness, stdout, outputFileText);
    if (!parsed.text.trim()) throw new Error("empty semantic response");
    if (
      parsed.executedModelId &&
      !modelIdsMatch(parsed.executedModelId, route.invocation_model_id)
    ) {
      return {
        ok: false,
        reason_code: "model_mismatch",
        resolved_model_id: parsed.executedModelId,
        model_attestation: "verified",
        duration_ms: Date.now() - started,
        usage: parsed.usage ?? unreportedSemanticUsage(),
      };
    }
    return {
      ok: true,
      text: parsed.text,
      resolved_model_id: parsed.executedModelId ?? route.invocation_model_id,
      model_attestation: parsed.executedModelId ? "verified" : "requested-only",
      duration_ms: Date.now() - started,
      output_bytes: Buffer.byteLength(parsed.text),
      usage: parsed.usage ?? estimateVisibleSemanticUsage(prompt, parsed.text),
    };
  } catch (error) {
    return {
      ok: false,
      reason_code: classifyFailure(error),
      resolved_model_id: route.invocation_model_id,
      model_attestation: "requested-only",
      duration_ms: Date.now() - started,
      usage: unreportedSemanticUsage(),
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
        "--json",
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
      "stream-json",
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

export interface ParsedSemanticHarnessOutput {
  text: string;
  executedModelId?: string;
  usage?: SemanticUsageReceiptV1;
}

export function parseSemanticHarnessOutput(
  harness: SemanticHarness,
  stdout: string,
  outputFileText?: string,
): ParsedSemanticHarnessOutput {
  if (harness === "codex") return parseCodexOutput(stdout, outputFileText);
  if (harness === "cursor") return parseCursorOutput(stdout);
  try {
    const envelope = JSON.parse(stdout) as {
      is_error?: boolean;
      result?: unknown;
      structured_output?: unknown;
      model?: unknown;
      usage?: unknown;
      modelUsage?: unknown;
      model_usage?: unknown;
    };
    if (envelope.is_error) throw new Error("harness returned an error envelope");
    const structured = envelope.structured_output;
    const modelUsage = objectValue(envelope.modelUsage) ?? objectValue(envelope.model_usage);
    const modelUsageEntries = modelUsage ? Object.entries(modelUsage) : [];
    const executedModelId =
      typeof envelope.model === "string"
        ? envelope.model
        : modelUsageEntries.length === 1
          ? modelUsageEntries[0]![0]
          : undefined;
    const usage = parseClaudeUsage(envelope.usage) ?? aggregateClaudeModelUsage(modelUsageEntries);
    return {
      text:
        structured !== undefined
          ? JSON.stringify(structured)
          : typeof envelope.result === "string"
            ? envelope.result
            : "",
      ...(executedModelId ? { executedModelId } : {}),
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    if (error instanceof SyntaxError) return { text: stdout };
    throw error;
  }
}

function parseCodexOutput(stdout: string, outputFileText?: string): ParsedSemanticHarnessOutput {
  const events = parseJsonLines(stdout);
  const completed = [...events]
    .reverse()
    .find((event) => event.type === "turn.completed" && objectValue(event.usage));
  const usage = completed ? parseCodexUsage(completed.usage) : undefined;
  const streamedText = [...events]
    .reverse()
    .map((event) => objectValue(event.item))
    .find((item) => item?.type === "agent_message" && typeof item.text === "string")?.text;
  return {
    text: outputFileText ?? (typeof streamedText === "string" ? streamedText : ""),
    ...(usage ? { usage } : {}),
  };
}

function parseCursorOutput(stdout: string): ParsedSemanticHarnessOutput {
  const events = parseJsonLines(stdout);
  const init = events.find(
    (event) =>
      event.type === "system" && event.subtype === "init" && typeof event.model === "string",
  );
  const terminal = [...events]
    .reverse()
    .find((event) => event.type === "result" && typeof event.result === "string");
  if (!terminal) {
    try {
      const envelope = JSON.parse(stdout) as Record<string, unknown>;
      if (envelope.is_error) throw new Error("harness returned an error envelope");
      return {
        text: typeof envelope.result === "string" ? envelope.result : "",
        ...(typeof envelope.model === "string" ? { executedModelId: envelope.model } : {}),
        ...(parseCursorUsage(envelope.usage) ? { usage: parseCursorUsage(envelope.usage) } : {}),
      };
    } catch (error) {
      if (error instanceof SyntaxError) return { text: stdout };
      throw error;
    }
  }
  if (terminal.is_error) throw new Error("harness returned an error envelope");
  const usage = parseCursorUsage(terminal.usage);
  return {
    text: terminal.result as string,
    ...(typeof init?.model === "string" ? { executedModelId: init.model } : {}),
    ...(usage ? { usage } : {}),
  };
}

function parseClaudeUsage(value: unknown): SemanticUsageReceiptV1 | undefined {
  const usage = objectValue(value);
  if (!usage) return undefined;
  return nativeSemanticUsage({
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cache_read_input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    output_tokens: usage.output_tokens,
    reasoning_tokens: usage.reasoning_tokens ?? usage.reasoning_output_tokens,
    total_tokens: usage.total_tokens,
  });
}

function aggregateClaudeModelUsage(
  entries: [string, unknown][],
): SemanticUsageReceiptV1 | undefined {
  const values: Record<string, number> = {};
  for (const [, raw] of entries) {
    const usage = objectValue(raw);
    if (!usage) continue;
    addNumber(values, "input_tokens", usage.inputTokens);
    addNumber(values, "cached_input_tokens", usage.cacheReadInputTokens);
    addNumber(values, "cache_creation_input_tokens", usage.cacheCreationInputTokens);
    addNumber(values, "output_tokens", usage.outputTokens);
  }
  return nativeSemanticUsage(values);
}

function parseCodexUsage(value: unknown): SemanticUsageReceiptV1 | undefined {
  const usage = objectValue(value);
  if (!usage) return undefined;
  return nativeSemanticUsage({
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    cache_creation_input_tokens: usage.cache_write_input_tokens,
    output_tokens: usage.output_tokens,
    reasoning_tokens: usage.reasoning_output_tokens,
    total_tokens: usage.total_tokens,
  });
}

function parseCursorUsage(value: unknown): SemanticUsageReceiptV1 | undefined {
  const usage = objectValue(value);
  if (!usage) return undefined;
  return nativeSemanticUsage({
    input_tokens: usage.inputTokens ?? usage.input_tokens,
    cached_input_tokens:
      usage.cacheReadTokens ?? usage.cachedInputTokens ?? usage.cached_input_tokens,
    cache_creation_input_tokens:
      usage.cacheWriteTokens ?? usage.cacheCreationInputTokens ?? usage.cache_write_input_tokens,
    output_tokens: usage.outputTokens ?? usage.output_tokens,
    reasoning_tokens: usage.reasoningTokens ?? usage.reasoning_output_tokens,
    total_tokens: usage.totalTokens ?? usage.total_tokens,
  });
}

function parseJsonLines(raw: string): Record<string, unknown>[] {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return objectValue(value) ? [value as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function addNumber(target: Record<string, number>, field: string, value: unknown): void {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    target[field] = (target[field] ?? 0) + value;
  }
}

function modelIdsMatch(attested: string, requested: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return normalize(attested) === normalize(requested);
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
