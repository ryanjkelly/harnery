/**
 * Capture: when an agent's tool call creates, changes or deletes a schedule,
 * record one observation line in `.harnery/private/schedule/observed.jsonl`.
 *
 * This is the only view Harnery has of Claude Code's in-session timers and
 * cloud triggers, and it names the session that created a T3 Code task. An
 * observation carries the operation, the returned id, a title and a trigger.
 * It never carries a prompt, a request body or any other free text from the
 * call.
 *
 * The hook calls `isScheduleToolName` on every tool call, so it does no I/O
 * and allocates nothing for a non-matching name. `captureScheduleToolCall`
 * never throws: a hook must not fail because capture did.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { stateDirMode, stateFileMode } from "../storage/modes.ts";
import { scheduleObservedPath } from "./paths.ts";
import {
  type ScheduleObservation,
  type ScheduleObservationOperation,
  type ScheduleObservationTool,
  type ScheduleRecord,
  type ScheduleSource,
  type ScheduleTrigger,
  scheduleCreatedByFromObservation,
  scheduleObservationSource,
  validateScheduleObservation,
  validateScheduleRecord,
} from "./types.ts";

/** The observation file keeps at most this many lines. */
export const SCHEDULE_OBSERVATIONS_MAX_LINES = 500;

/** Claude Code spells the T3 Code server `t3-code`, Codex `t3_code`. */
const T3_SCHEDULE_TOOL = /^mcp__t3[-_]code__(?:schedule_task|delete_scheduled_task)$/;

/** True for a tool call capture may record. Cheap; no I/O. */
export function isScheduleToolName(toolName: string | undefined): boolean {
  if (typeof toolName !== "string") return false;
  switch (toolName) {
    case "CronCreate":
    case "CronDelete":
    case "RemoteTrigger":
      return true;
  }
  return toolName.startsWith("mcp__t3") && T3_SCHEDULE_TOOL.test(toolName);
}

function observationTool(toolName: string): ScheduleObservationTool | null {
  switch (toolName) {
    case "CronCreate":
      return "claude-code.cron_create";
    case "CronDelete":
      return "claude-code.cron_delete";
    case "RemoteTrigger":
      return "claude-code.remote_trigger";
  }
  if (!T3_SCHEDULE_TOOL.test(toolName)) return null;
  return toolName.endsWith("__schedule_task")
    ? "t3-code.schedule_task"
    : "t3-code.delete_scheduled_task";
}

// ---------------------------------------------------------------------------
// Reading a tool result. A result arrives as an object, a JSON string, plain
// text, or MCP content blocks (`[{ type: "text", text }]`, possibly wrapped
// in `{ content: [...] }`), depending on the adapter.
// ---------------------------------------------------------------------------

const MAX_DEPTH = 4;
const MAX_BLOCKS = 16;
const MAX_TEXT = 256 * 1024;

interface ResultParts {
  /** JSON objects found in the result, outermost first. */
  objects: Record<string, unknown>[];
  /** Every text fragment found in the result. */
  texts: string[];
  /** True when the result says the call failed. */
  isError: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || trimmed.length > MAX_TEXT) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collect(value: unknown, depth: number, out: ResultParts): void {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.length > MAX_TEXT) return;
    out.texts.push(value);
    const object = parseJsonObject(value);
    if (object) collect(object, depth + 1, out);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_BLOCKS)) collect(item, depth + 1, out);
    return;
  }
  if (!isPlainObject(value)) return;
  if (value.isError === true || value.is_error === true) out.isError = true;
  if (value.type === "text" && typeof value.text === "string") {
    collect(value.text, depth, out);
    return;
  }
  out.objects.push(value);
  if ("content" in value && (Array.isArray(value.content) || typeof value.content === "string")) {
    collect(value.content, depth + 1, out);
  }
}

function resultParts(toolResponse: unknown): ResultParts {
  const out: ResultParts = { objects: [], texts: [], isError: false };
  collect(toolResponse, 0, out);
  return out;
}

function firstField(objects: readonly Record<string, unknown>[], key: string): unknown {
  for (const object of objects) {
    if (key in object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Field cleaning. Ids and titles are bounded; anything odd is dropped rather
// than stored.
// ---------------------------------------------------------------------------

const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,199}$/;
const MAX_TITLE = 200;

function cleanId(value: unknown): string | null {
  return typeof value === "string" && NATIVE_ID.test(value) ? value : null;
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let printable = "";
  for (const char of value.slice(0, MAX_TITLE * 4)) {
    const code = char.charCodeAt(0);
    printable += code < 0x20 || code === 0x7f ? " " : char;
  }
  const flat = printable.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
}

const CRON_FIELD = /^[0-9A-Za-z*/,?#LW-]{1,40}$/;

function cleanCron(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5 || !fields.every((field) => CRON_FIELD.test(field))) return null;
  return fields.join(" ");
}

function cronTrigger(value: unknown): ScheduleTrigger | null {
  const expr = cleanCron(value);
  return expr === null ? null : { kind: "cron", expr, raw: expr };
}

// ---------------------------------------------------------------------------
// T3 Code
// ---------------------------------------------------------------------------

const TIME_OF_DAY = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Map T3 Code's `schedule` object. `raw` is a short summary, never the JSON. */
function t3Trigger(schedule: unknown): ScheduleTrigger | null {
  if (!isPlainObject(schedule)) return null;
  switch (schedule.type) {
    case "once": {
      const at = schedule.runAt;
      if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return null;
      const iso = new Date(Date.parse(at)).toISOString();
      return { kind: "once", at: iso, raw: `once ${iso}` };
    }
    case "interval": {
      const everyMs = schedule.everyMs;
      if (
        typeof everyMs !== "number" ||
        !Number.isInteger(everyMs) ||
        everyMs < 1 ||
        everyMs > Number.MAX_SAFE_INTEGER
      )
        return null;
      return { kind: "interval", everyMs, raw: `interval ${everyMs}ms` };
    }
    case "fixed_time": {
      const time =
        typeof schedule.timeOfDay === "string" ? TIME_OF_DAY.exec(schedule.timeOfDay) : null;
      if (!time) return null;
      const hour = Number(time[1]);
      const minute = Number(time[2]);
      let days = "*";
      const weekdays = schedule.weekdays;
      if (weekdays !== undefined && weekdays !== null) {
        if (!Array.isArray(weekdays)) return null;
        const set = new Set<number>();
        for (const day of weekdays) {
          if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) return null;
          set.add(day);
        }
        if (set.size > 0 && set.size < 7) days = [...set].sort((a, b) => a - b).join(",");
      }
      const expr = `${minute} ${hour} * * ${days}`;
      const hhmm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      return {
        kind: "cron",
        expr,
        raw: `fixed_time ${hhmm}${days === "*" ? "" : ` weekdays ${days}`}`,
      };
    }
    case "webhook":
      return { kind: "event", description: "webhook", raw: "webhook" };
  }
  return null;
}

interface Draft {
  operation: ScheduleObservationOperation;
  native_id: string | null;
  title: string | null;
  trigger: ScheduleTrigger | null;
  expires_with_session: boolean;
}

function t3ScheduleTask(input: Record<string, unknown>, result: ResultParts): Draft | null {
  if (result.isError) return null;
  const inputId = cleanId(input.scheduledTaskId);
  const resultId = cleanId(firstField(result.objects, "scheduledTaskId"));
  const operation: ScheduleObservationOperation = inputId ? "update" : "create";
  const native_id = resultId ?? inputId;
  if (native_id === null) return null;
  return {
    operation,
    native_id,
    title: cleanTitle(input.title) ?? cleanTitle(firstField(result.objects, "title")),
    trigger: t3Trigger(input.schedule) ?? t3Trigger(firstField(result.objects, "schedule")),
    expires_with_session: false,
  };
}

function t3DeleteTask(input: Record<string, unknown>, result: ResultParts): Draft | null {
  if (result.isError) return null;
  const native_id = cleanId(input.scheduledTaskId);
  if (native_id === null) return null;
  return {
    operation: "delete",
    native_id,
    title: null,
    trigger: null,
    expires_with_session: false,
  };
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/** "Scheduled one-shot task 72490f3c (...)" or "Scheduled recurring task <id> (...)". */
const CRON_TASK_ID = /\btask ([A-Za-z0-9][A-Za-z0-9_-]{0,63})\b/;

function cronCreate(input: Record<string, unknown>, result: ResultParts): Draft | null {
  if (result.isError) return null;
  let native_id = cleanId(firstField(result.objects, "id"));
  if (native_id === null) {
    for (const text of result.texts) {
      const match = CRON_TASK_ID.exec(text);
      if (match) {
        native_id = cleanId(match[1]);
        break;
      }
    }
  }
  if (native_id === null) return null;
  return {
    operation: "create",
    native_id,
    title: null,
    trigger: cronTrigger(input.cron),
    expires_with_session: true,
  };
}

function cronDelete(input: Record<string, unknown>, result: ResultParts): Draft | null {
  if (result.isError) return null;
  const native_id = cleanId(input.id);
  if (native_id === null) return null;
  return { operation: "delete", native_id, title: null, trigger: null, expires_with_session: true };
}

const HTTP_STATUS = /^\s*HTTP (\d{3})\b/;

/** The JSON part of `HTTP <code>\n<json>[\n<summary line>]`. */
function remoteJson(text: string): Record<string, unknown> | null {
  const newline = text.indexOf("\n");
  if (newline < 0) return null;
  const lines = text.slice(newline + 1).split("\n");
  // Drop trailing lines (the appended summary) until the rest parses.
  for (let end = lines.length; end > 0 && lines.length - end <= 4; end--) {
    const object = parseJsonObject(lines.slice(0, end).join("\n"));
    if (object) return object;
  }
  return null;
}

const REMOTE_CRON_KEYS = ["cron_expression", "cron", "schedule"] as const;

function remoteBodyTrigger(objects: readonly Record<string, unknown>[]): ScheduleTrigger | null {
  for (const object of objects) {
    for (const key of REMOTE_CRON_KEYS) {
      const trigger = cronTrigger(object[key]);
      if (trigger) return trigger;
    }
  }
  return null;
}

function remoteTrigger(input: Record<string, unknown>, result: ResultParts): Draft | null {
  const action = input.action;
  if (action !== "create" && action !== "update" && action !== "create_webhook_trigger") {
    return null;
  }
  if (result.isError) return null;
  let status: number | null = null;
  let json: Record<string, unknown> | null = null;
  for (const text of result.texts) {
    const match = HTTP_STATUS.exec(text);
    if (!match) continue;
    status = Number(match[1]);
    json = remoteJson(text.trimStart());
    break;
  }
  if (status === null || status < 200 || status > 299) return null;
  const inputId = cleanId(input.trigger_id);
  const resultId = json
    ? (cleanId(json.id) ?? (isPlainObject(json.data) ? cleanId(json.data.id) : null))
    : null;
  const body = isPlainObject(input.body) ? input.body : null;
  const sources: Record<string, unknown>[] = [];
  if (body) sources.push(body);
  if (json) {
    sources.push(json);
    if (isPlainObject(json.data)) sources.push(json.data);
  }
  let trigger = remoteBodyTrigger(sources);
  if (trigger === null && action === "create_webhook_trigger") {
    trigger = { kind: "event", description: "webhook", raw: "webhook" };
  }
  let title: string | null = null;
  for (const source of sources) {
    title = cleanTitle(source.name) ?? cleanTitle(source.title);
    if (title) break;
  }
  return {
    operation:
      action === "create" || (action === "create_webhook_trigger" && !inputId)
        ? "create"
        : "update",
    native_id: inputId ?? resultId,
    title,
    trigger,
    expires_with_session: false,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScheduleToolCall {
  toolName: string | undefined;
  toolInput: unknown;
  toolResponse: unknown;
  instanceId: string;
  agentName?: string;
  task?: string;
  /** ISO instant the hook saw the finished call. */
  observedAt: string;
}

/**
 * Build the observation for one finished tool call, or null when the call is
 * not a schedule change, failed, or carried nothing recognisable. Pure.
 */
export function scheduleObservationFromToolCall(
  call: ScheduleToolCall,
): ScheduleObservation | null {
  try {
    if (!isScheduleToolName(call.toolName)) return null;
    const tool = observationTool(call.toolName as string);
    if (tool === null) return null;
    let input: Record<string, unknown> = {};
    if (isPlainObject(call.toolInput)) input = call.toolInput;
    else if (typeof call.toolInput === "string") input = parseJsonObject(call.toolInput) ?? {};
    const result = resultParts(call.toolResponse);
    let draft: Draft | null;
    switch (tool) {
      case "t3-code.schedule_task":
        draft = t3ScheduleTask(input, result);
        break;
      case "t3-code.delete_scheduled_task":
        draft = t3DeleteTask(input, result);
        break;
      case "claude-code.cron_create":
        draft = cronCreate(input, result);
        break;
      case "claude-code.cron_delete":
        draft = cronDelete(input, result);
        break;
      case "claude-code.remote_trigger":
        draft = remoteTrigger(input, result);
        break;
    }
    if (draft === null) return null;
    const observation: ScheduleObservation = {
      schema_version: 1,
      observed_at: call.observedAt,
      instance_id: call.instanceId,
      tool,
      operation: draft.operation,
      native_id: draft.native_id,
      title: draft.title,
      trigger: draft.trigger,
      expires_with_session: draft.expires_with_session,
    };
    if (typeof call.agentName === "string" && call.agentName.trim().length > 0) {
      observation.agent_name = call.agentName;
    }
    if (typeof call.task === "string") observation.task = call.task;
    return validateScheduleObservation(observation).ok ? observation : null;
  } catch {
    return null;
  }
}

/** A trim lock older than this belongs to a process that died mid-trim. */
const TRIM_LOCK_STALE_MS = 30_000;

function acquireTrimLock(lockPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lockPath, "wx", stateFileMode()));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs < TRIM_LOCK_STALE_MS) return false;
        unlinkSync(lockPath);
      } catch {
        return false;
      }
    }
  }
  return false;
}

/**
 * Keep the newest lines when the file has grown past the bound. One process
 * trims at a time; another that finds the lock taken skips the trim and leaves
 * it to the next append. The rewrite is a rename, so a reader never sees a
 * partial file. An append that lands between the read and the rename is lost;
 * a trim runs once per few hundred appends, so that window is small.
 */
function trimObservations(path: string, maxLines: number): void {
  const lines = readFileSync(path, "utf8").split("\n");
  let count = 0;
  for (const line of lines) if (line.length > 0) count++;
  if (count <= maxLines) return;
  const lockPath = `${path}.trim.lock`;
  if (!acquireTrimLock(lockPath)) return;
  try {
    const fresh = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    if (fresh.length <= maxLines) return;
    const keep = fresh.slice(fresh.length - maxLines);
    const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(temporary, `${keep.join("\n")}\n`, { encoding: "utf8", mode: stateFileMode() });
    try {
      chmodSync(temporary, stateFileMode());
    } catch {
      // Windows does not expose POSIX modes.
    }
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Record one finished tool call when it changed a schedule. Returns the
 * observation written, or null. Never throws.
 */
export function captureScheduleToolCall(
  call: ScheduleToolCall & { coordRoot: string },
): ScheduleObservation | null {
  try {
    const observation = scheduleObservationFromToolCall(call);
    if (observation === null) return null;
    const path = scheduleObservedPath(call.coordRoot);
    mkdirSync(dirname(path), { recursive: true, mode: stateDirMode() });
    // One write of one complete line; concurrent appends do not interleave.
    appendFileSync(path, `${JSON.stringify(observation)}\n`, {
      encoding: "utf8",
      mode: stateFileMode(),
    });
    try {
      trimObservations(path, SCHEDULE_OBSERVATIONS_MAX_LINES);
    } catch {
      // The line is written; a failed trim is retried by the next append.
    }
    return observation;
  } catch {
    return null;
  }
}

/** Every valid observation in the file, oldest first. Never throws. */
export function readScheduleObservations(coordRoot: string): ScheduleObservation[] {
  let text: string;
  try {
    text = readFileSync(scheduleObservedPath(coordRoot), "utf8");
  } catch {
    return [];
  }
  const out: ScheduleObservation[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      const valid = validateScheduleObservation(value);
      if (valid.ok) out.push(valid.value);
    } catch {
      // Skip a line that is not JSON.
    }
  }
  return out;
}

function byObservedAt(observations: readonly ScheduleObservation[]): ScheduleObservation[] {
  return observations
    .map((observation, index) => ({ observation, index, at: Date.parse(observation.observed_at) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((entry) => entry.observation);
}

/** Claude Code's timers and cloud triggers are separate id spaces. */
function capturedFamily(tool: ScheduleObservationTool): "cron" | "remote" | null {
  switch (tool) {
    case "claude-code.cron_create":
    case "claude-code.cron_delete":
      return "cron";
    case "claude-code.remote_trigger":
      return "remote";
  }
  return null;
}

/** The trigger a captured record shows when the call did not state one. */
const UNKNOWN_TRIGGER: ScheduleTrigger = {
  kind: "event",
  description: "not recorded",
  raw: "",
};

/**
 * Records for the schedules no reader can see: Claude Code's in-session
 * timers and cloud triggers, replayed from their observations. T3 Code
 * observations are skipped here; they annotate the T3 Code reader's records.
 *
 * A create or update adds or replaces the record (the first creator stays);
 * a delete removes it. An in-session timer is dropped when `liveInstanceIds`
 * is given and its creating session is not in it.
 */
export function capturedScheduleRecords(
  observations: readonly ScheduleObservation[],
  opts: { machine: string; liveInstanceIds?: ReadonlySet<string> },
): ScheduleRecord[] {
  const entries = new Map<
    string,
    { record: ScheduleRecord; creator: ScheduleObservation; expires: boolean }
  >();
  for (const observation of byObservedAt(observations)) {
    if (scheduleObservationSource(observation.tool) !== "captured") continue;
    const family = capturedFamily(observation.tool);
    if (family === null) continue;
    const id =
      observation.native_id ?? `unknown:${observation.observed_at}:${observation.instance_id}`;
    const key = JSON.stringify([family, id]);
    if (observation.operation === "delete") {
      entries.delete(key);
      continue;
    }
    const previous = entries.get(key);
    const creator = previous?.creator ?? observation;
    const record: ScheduleRecord = {
      source: "captured",
      account: opts.machine,
      id,
      title: observation.title ?? previous?.record.title ?? "",
      trigger: observation.trigger ?? previous?.record.trigger ?? UNKNOWN_TRIGGER,
      runs_on: { host: opts.machine },
      enabled: null,
      next_run_at: null,
      last_run: null,
      created_by: scheduleCreatedByFromObservation(creator),
    };
    entries.set(key, {
      record,
      creator,
      expires: observation.expires_with_session || (previous?.expires ?? false),
    });
  }
  const out: ScheduleRecord[] = [];
  for (const { record, creator, expires } of entries.values()) {
    if (expires && opts.liveInstanceIds && !opts.liveInstanceIds.has(creator.instance_id)) continue;
    if (validateScheduleRecord(record).ok) out.push(record);
  }
  return out;
}

/** The key `scheduleObservationsById` uses: a record's source and native id. */
export function scheduleObservationKey(source: ScheduleSource, nativeId: string): string {
  return JSON.stringify([source, nativeId]);
}

/**
 * The newest create or update observation for each `(source, native_id)`,
 * keyed by `scheduleObservationKey`. The list uses it to stamp `created_by`
 * on a reader's record.
 */
export function scheduleObservationsById(
  observations: readonly ScheduleObservation[],
): Map<string, ScheduleObservation> {
  const out = new Map<string, ScheduleObservation>();
  for (const observation of byObservedAt(observations)) {
    if (observation.operation === "delete" || observation.native_id === null) continue;
    out.set(
      scheduleObservationKey(scheduleObservationSource(observation.tool), observation.native_id),
      observation,
    );
  }
  return out;
}
