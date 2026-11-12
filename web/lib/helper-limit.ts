/**
 * The helper agent limit as the dashboard sees it: the report shape that
 * `harn devtools helpers --format json` prints, its validation, the request
 * body the Tools page posts, and the words shown for each value.
 *
 * Pure and free of Node APIs, so the client control and the server reader
 * and route share one copy. The server-side runner lives in
 * `helper-limit-reader.ts`.
 */

/** A highest model and a highest effort; either side may be absent. */
export interface HelperLimitPair {
  max_model?: string;
  max_effort?: string;
}

export type HelperLimitSource = "user" | "project" | "none";

export interface HelperLimitReport {
  tool: string;
  limit: HelperLimitPair | null;
  source: HelperLimitSource;
  summary: string;
  /** `{}` = the person chose "no limit"; null = they made no choice. */
  user: HelperLimitPair | null;
  project_default: HelperLimitPair | null;
  /** Dropdown options, cheapest and lowest first. */
  ladders: { models: string[]; efforts: string[] };
  active: boolean;
  inactive_reason: string | null;
  coverage: { covered: string[]; not_covered: string[] };
  last_24h: {
    since: string;
    helpers: number;
    lowered: number;
    by_model: Record<string, number>;
  };
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isPair(value: unknown): value is HelperLimitPair {
  if (!isRecord(value)) return false;
  for (const [key, v] of Object.entries(value)) {
    if (key !== "max_model" && key !== "max_effort") return false;
    if (v !== undefined && typeof v !== "string") return false;
  }
  return true;
}

function isPairOrNull(value: unknown): value is HelperLimitPair | null {
  return value === null || isPair(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Whether a parsed value has the full report shape the page reads. */
export function isHelperLimitReport(value: unknown): value is HelperLimitReport {
  if (!isRecord(value)) return false;
  const v = value;
  if (typeof v.tool !== "string" || typeof v.summary !== "string") return false;
  if (v.source !== "user" && v.source !== "project" && v.source !== "none") return false;
  if (!isPairOrNull(v.limit) || !isPairOrNull(v.user) || !isPairOrNull(v.project_default))
    return false;
  if (!isRecord(v.ladders) || !isStringArray(v.ladders.models) || !isStringArray(v.ladders.efforts))
    return false;
  if (typeof v.active !== "boolean") return false;
  if (v.inactive_reason !== null && typeof v.inactive_reason !== "string") return false;
  if (
    !isRecord(v.coverage) ||
    !isStringArray(v.coverage.covered) ||
    !isStringArray(v.coverage.not_covered)
  )
    return false;
  const day = v.last_24h;
  if (!isRecord(day) || typeof day.since !== "string") return false;
  if (!isCount(day.helpers) || !isCount(day.lowered) || !isRecord(day.by_model)) return false;
  if (!Object.values(day.by_model).every(isCount)) return false;
  return isStringArray(v.warnings);
}

/** Parse the command's stdout; null for anything that is not a report. */
export function parseHelperLimitReport(stdout: string): HelperLimitReport | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return isHelperLimitReport(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** What the page asks for: set a pair (empty pair = no limit), or clear the person's choice. */
export type HelperLimitChange = { kind: "set"; limit: HelperLimitPair } | { kind: "clear" };

const WORD = /^[a-z]+$/;

/**
 * Validate the POST body strictly: `{ "limit": { max_model?, max_effort? } }`
 * or `{ "limit": null }`, nothing else, and every word lowercase letters only.
 */
export function parseHelperLimitBody(
  body: unknown,
): { ok: true; change: HelperLimitChange } | { ok: false; message: string } {
  if (!isRecord(body)) return { ok: false, message: "the request was not readable." };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "limit")
    return { ok: false, message: "the request must hold only a limit." };
  const limit = body.limit;
  if (limit === null) return { ok: true, change: { kind: "clear" } };
  if (!isRecord(limit)) return { ok: false, message: "the limit was not readable." };
  const pair: HelperLimitPair = {};
  for (const [key, value] of Object.entries(limit)) {
    if (key !== "max_model" && key !== "max_effort")
      return { ok: false, message: "the limit may name only a model and an effort." };
    if (typeof value !== "string" || !WORD.test(value))
      return { ok: false, message: "a model or effort must be a plain lowercase word." };
    pair[key] = value;
  }
  return { ok: true, change: { kind: "set", limit: pair } };
}

/** The CLI arguments for a change, one word per argument. */
export function helperLimitArgs(change: HelperLimitChange): string[] {
  const base = ["devtools", "helpers"];
  if (change.kind === "clear") return [...base, "--clear", "--format", "json"];
  const words = [change.limit.max_model, change.limit.max_effort].filter(
    (w): w is string => typeof w === "string",
  );
  return [...base, ...(words.length ? words : ["none"]), "--format", "json"];
}

/** "opus" → "Opus". */
export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Dropdown options: "No limit" (empty value) first, then the ladder in order. */
export function limitOptions(ladder: string[]): Array<{ value: string; label: string }> {
  return [
    { value: "", label: "No limit" },
    ...ladder.map((w) => ({ value: w, label: capitalize(w) })),
  ];
}

/** Where the limit in effect comes from, in the reader's words; null when nothing is set. */
export function sourceLabel(source: HelperLimitSource): string | null {
  if (source === "user") return "your choice for all projects";
  if (source === "project") return "this project's default";
  return null;
}

/** "Opus at Medium effort", "Opus", "Medium effort", or "None". */
export function pairLabel(pair: HelperLimitPair | null): string {
  if (!pair) return "None";
  const model = pair.max_model ? capitalize(pair.max_model) : null;
  const effort = pair.max_effort ? `${capitalize(pair.max_effort)} effort` : null;
  if (model && effort) return `${model} at ${effort}`;
  return model ?? effort ?? "No limit";
}

/** Whether a limit is in effect (a pair with at least one side). */
export function limitInEffect(limit: HelperLimitPair | null): boolean {
  return Boolean(limit && (limit.max_model || limit.max_effort));
}

/** The last-24-hours sentence. */
export function last24hLabel(day: HelperLimitReport["last_24h"]): string {
  if (day.helpers === 0) return "No helpers in the last 24 hours.";
  const ran = Object.entries(day.by_model)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model, n]) => `${capitalize(model)} ${n}`)
    .join(", ");
  const helpers = `${day.helpers} ${day.helpers === 1 ? "helper" : "helpers"}`;
  const head = `Last 24 hours, all projects: ${helpers}, ${day.lowered} lowered.`;
  return ran ? `${head} Ran on ${ran}.` : head;
}
