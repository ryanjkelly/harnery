/**
 * Private, short-lived details for failed tool calls.
 *
 * The canonical `tool.completed` event records only that a call failed. It
 * never carries tool input or output text (see ADR 0278). This side store keeps
 * what a person needs to diagnose the failure: a bounded, redacted excerpt of
 * the error and of the call's input (the shell command, path, or arguments).
 * Records are keyed by the canonical event id, live in owner-only daily files
 * under `.harnery/private/tool-failures/`, and expire after 14 days.
 *
 * Writing is best-effort: a failure here must never break the hook path.
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { sanitizeDiagnosticValue } from "../../diagnostics/sanitize.ts";
import { stateDirMode, stateFileMode } from "../../storage/modes.ts";

export const TOOL_FAILURE_DETAILS_RELATIVE_ROOT = ".harnery/private/tool-failures";
export const TOOL_FAILURE_DETAILS_MAX_AGE_DAYS = 14;
export const TOOL_FAILURE_DETAILS_MAX_DAY_BYTES = 16 * 1_024 * 1_024;
export const TOOL_FAILURE_ERROR_MAX_CHARS = 2_000;
export const TOOL_FAILURE_INPUT_MAX_CHARS = 1_000;

const DAY_MS = 24 * 60 * 60 * 1_000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal escape sequences
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export interface ToolFailureDetailV3 {
  schema: "harnery.tool-failure-detail/v1";
  event_id: string;
  recorded_at: string;
  instance_id: string | null;
  tool: string;
  /** Redacted, bounded summary of the call's input: the command, path, or arguments. */
  input: string | null;
  /** Redacted, bounded excerpt of the error the harness reported. */
  error: string | null;
  /** Characters of error text before truncation, so a reader knows what was cut. */
  error_chars: number;
}

export interface ToolFailureDetailInputV3 {
  event_id: string;
  instance_id?: string | null;
  tool_name: string;
  tool_input?: unknown;
  tool_response?: unknown;
  /** The adapter's raw payload; Claude Code puts the failure text in `error`. */
  raw?: Record<string, unknown>;
  recorded_at?: string;
}

export function toolFailureDetailsRoot(coordRoot: string): string {
  return join(resolve(coordRoot), TOOL_FAILURE_DETAILS_RELATIVE_ROOT);
}

/** Build the stored record. Exported for tests; callers use the recorder. */
export function buildToolFailureDetailV3(
  coordRoot: string,
  input: ToolFailureDetailInputV3,
): ToolFailureDetailV3 {
  const rawError = errorText(input);
  const cleanedError = rawError === null ? null : clean(coordRoot, rawError);
  return {
    schema: "harnery.tool-failure-detail/v1",
    event_id: input.event_id,
    recorded_at: input.recorded_at ?? new Date().toISOString(),
    instance_id: input.instance_id ?? null,
    tool: input.tool_name.slice(0, 128),
    input: summarizeInput(coordRoot, input.tool_input),
    error: cleanedError === null ? null : headAndTail(cleanedError, TOOL_FAILURE_ERROR_MAX_CHARS),
    error_chars: cleanedError?.length ?? 0,
  };
}

/** Append one failure detail. Returns the file written, or undefined when skipped. */
export function recordToolFailureDetailV3(
  coordRoot: string,
  input: ToolFailureDetailInputV3,
  now: Date = new Date(),
): string | undefined {
  try {
    const root = toolFailureDetailsRoot(coordRoot);
    mkdirSync(root, { recursive: true, mode: stateDirMode() });
    chmodSync(root, stateDirMode());
    pruneExpired(root, now);
    const path = join(root, `${now.toISOString().slice(0, 10)}.jsonl`);
    if (existsSync(path) && statSync(path).size >= TOOL_FAILURE_DETAILS_MAX_DAY_BYTES) {
      return undefined;
    }
    if (!existsSync(path)) closeSync(openSync(path, "a", stateFileMode()));
    const record = buildToolFailureDetailV3(coordRoot, {
      ...input,
      recorded_at: input.recorded_at ?? now.toISOString(),
    });
    // One short line per append keeps concurrent writers from interleaving.
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
    return path;
  } catch {
    return undefined;
  }
}

/** Read retained details for the given canonical event ids. */
export function readToolFailureDetailsV3(
  coordRoot: string,
  eventIds: ReadonlySet<string>,
): Map<string, ToolFailureDetailV3> {
  const found = new Map<string, ToolFailureDetailV3>();
  if (eventIds.size === 0) return found;
  const root = toolFailureDetailsRoot(coordRoot);
  if (!existsSync(root)) return found;
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => DAY_FILE.test(name));
  } catch {
    return found;
  }
  for (const name of names.sort()) {
    let text: string;
    try {
      text = readFileSync(join(root, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as ToolFailureDetailV3;
        if (record?.schema === "harnery.tool-failure-detail/v1" && eventIds.has(record.event_id)) {
          found.set(record.event_id, record);
        }
      } catch {
        // A torn or foreign line is skipped; the rest of the file stays readable.
      }
    }
  }
  return found;
}

function pruneExpired(root: string, now: Date): void {
  const cutoff = now.getTime() - TOOL_FAILURE_DETAILS_MAX_AGE_DAYS * DAY_MS;
  for (const name of readdirSync(root)) {
    const match = DAY_FILE.exec(name);
    if (!match) continue;
    const dayEnd = Date.parse(`${match[1]}T00:00:00Z`) + DAY_MS;
    if (Number.isNaN(dayEnd) || dayEnd > cutoff) continue;
    try {
      unlinkSync(join(root, name));
    } catch {
      // Another writer may have pruned it first.
    }
  }
}

function errorText(input: ToolFailureDetailInputV3): string | null {
  const raw = input.raw ?? {};
  // Harnesses name the failure field differently (`error`, `error_message`, …).
  // Take the most specific string field first, then the tool response.
  const fromRaw = pickErrorField(raw);
  if (fromRaw) return fromRaw;
  const response = input.tool_response;
  if (typeof response === "string" && response.trim()) return response;
  if (response && typeof response === "object") {
    const fromResponse = pickErrorField(response as Record<string, unknown>);
    if (fromResponse) return fromResponse;
    const serialized = JSON.stringify(response);
    if (serialized && serialized !== "{}") return serialized;
  }
  if (raw.error && typeof raw.error === "object") return JSON.stringify(raw.error);
  const kind = raw.failure_type ?? raw.failureType;
  return typeof kind === "string" && kind.trim() ? `failure type: ${kind}` : null;
}

const ERROR_FIELD_ORDER = ["error", "error_message", "errorMessage", "stderr", "output", "message"];
const ERROR_FIELD_NAME = /(?:^|[_-]|[a-z])(?:error|Error|stderr)(?:$|[_-]|[A-Z])/;

function pickErrorField(record: Record<string, unknown>): string | null {
  for (const key of ERROR_FIELD_ORDER) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.trim() && ERROR_FIELD_NAME.test(key)) return value;
  }
  return null;
}

function summarizeInput(coordRoot: string, toolInput: unknown): string | null {
  if (toolInput === null || toolInput === undefined) return null;
  let text: string;
  if (typeof toolInput === "string") {
    text = toolInput;
  } else if (typeof toolInput === "object") {
    const record = toolInput as Record<string, unknown>;
    const primary = ["command", "cmd", "file_path", "notebook_path", "path", "url"]
      .map((key) => record[key])
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (primary !== undefined) {
      text = primary;
    } else if (Array.isArray(record.command)) {
      text = record.command.map(String).join(" ");
    } else {
      text = JSON.stringify(toolInput) ?? "";
    }
  } else {
    text = String(toolInput);
  }
  const cleaned = clean(coordRoot, text);
  return cleaned ? headAndTail(cleaned, TOOL_FAILURE_INPUT_MAX_CHARS) : null;
}

function clean(coordRoot: string, text: string): string {
  const root = resolve(coordRoot);
  const relative = text.replace(ANSI, "").split(`${root}/`).join("").trim();
  const { value } = sanitizeDiagnosticValue(relative);
  return typeof value === "string" ? value : relative;
}

/** Keep the start and the end: errors usually name the cause at one or the other. */
function headAndTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = `\n… [${text.length - max} characters omitted] …\n`;
  const tail = Math.floor((max - marker.length) / 4);
  const head = max - marker.length - tail;
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}
