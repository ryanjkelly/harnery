import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

const DEFAULT_TTL_MS = 15 * 60 * 1_000;
const HARD_MAX_TTL_MS = 60 * 60 * 1_000;
const MAX_INTENT_CHARS = 240;
const MAX_TARGET_LABELS = 16;
const MAX_TARGET_CHARS = 160;
const MAX_ROW_BYTES = 8 * 1_024;
const GENERATION_PATTERN =
  /^gen_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_PATTERN = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXECUTABLE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/;
const TARGET_PATTERN = /^[a-zA-Z0-9._@+-]+(?:\/[a-zA-Z0-9._@+ -]+)*$/;

export const EVENT_V2_LIVE_RELATIVE_ROOT = ".harnery/live/v2" as const;

export interface LiveDisplayInputV2 {
  generation_id: string;
  event_id: string;
  executable?: string;
  intent_display?: string;
  target_labels?: string[];
  ttl_ms?: number;
}

export interface LiveDisplayRowV2 {
  format: "harnery-event-v2-live-display";
  format_version: 1;
  row_id: `live_${string}`;
  generation_id: string;
  event_id: string;
  written_at: string;
  expires_at: string;
  executable?: string;
  intent_display?: string;
  target_labels?: string[];
}

export interface LiveDisplayJanitorResultV2 {
  scanned: number;
  removed: number;
  retained: number;
}

/**
 * Append one best-effort operator-display row. The narrow input shape has no
 * fields for prompts, argv, tool input, output, exception bodies, or messages.
 */
export function writeLiveDisplayV2(
  coordRoot: string,
  input: LiveDisplayInputV2,
  now: () => Date = () => new Date(),
): LiveDisplayRowV2 {
  assertLiveIds(input.generation_id, input.event_id);
  const ttlMs = input.ttl_ms ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > HARD_MAX_TTL_MS) {
    throw new Error("V2 live-display TTL must be between 1 ms and 1 hour");
  }
  if (input.executable !== undefined && !EXECUTABLE_PATTERN.test(input.executable)) {
    throw new Error("V2 live-display executable is invalid");
  }
  const writtenAt = now();
  const intentDisplay = safeIntentDisplayV2(input.intent_display);
  const targetLabels = safeTargetLabels(input.target_labels);
  const row: LiveDisplayRowV2 = {
    format: "harnery-event-v2-live-display",
    format_version: 1,
    row_id: `live_${randomUUID()}`,
    generation_id: input.generation_id,
    event_id: input.event_id,
    written_at: writtenAt.toISOString(),
    expires_at: new Date(writtenAt.getTime() + ttlMs).toISOString(),
    ...(input.executable ? { executable: input.executable } : {}),
    ...(intentDisplay ? { intent_display: intentDisplay } : {}),
    ...(targetLabels.length > 0 ? { target_labels: targetLabels } : {}),
  };
  const serialized = `${JSON.stringify(row)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_ROW_BYTES) {
    throw new Error("V2 live-display row exceeds its bounded size");
  }
  const root = liveRoot(coordRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = join(root, `${input.generation_id}.ndjson`);
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, serialized, undefined, "utf8");
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  return row;
}

/** Return only unexpired, structurally valid rows. Expiry is enforced before cleanup. */
export function readLiveDisplayV2(
  coordRoot: string,
  generationId: string,
  now: () => Date = () => new Date(),
): LiveDisplayRowV2[] {
  if (!GENERATION_PATTERN.test(generationId))
    throw new Error("V2 live-display generation ID is invalid");
  const path = join(liveRoot(coordRoot), `${generationId}.ndjson`);
  if (!existsSync(path)) return [];
  const nowMs = now().getTime();
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((frame) => {
      try {
        const row = validateLiveRow(JSON.parse(frame));
        const writtenMs = Date.parse(row.written_at);
        const expiresMs = Date.parse(row.expires_at);
        if (expiresMs <= nowMs || writtenMs + HARD_MAX_TTL_MS <= nowMs) return [];
        return [row];
      } catch {
        return [];
      }
    });
}

/** Remove fully expired generation files; malformed residue is bounded by the hard maximum. */
export function janitorLiveDisplayV2(
  coordRoot: string,
  now: () => Date = () => new Date(),
): LiveDisplayJanitorResultV2 {
  const root = liveRoot(coordRoot);
  if (!existsSync(root)) return { scanned: 0, removed: 0, retained: 0 };
  const nowMs = now().getTime();
  let scanned = 0;
  let removed = 0;
  let retained = 0;
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".ndjson")) continue;
    scanned += 1;
    const path = join(root, basename(name));
    const visible = GENERATION_PATTERN.test(name.slice(0, -".ndjson".length))
      ? readLiveDisplayV2(coordRoot, name.slice(0, -".ndjson".length), now)
      : [];
    const hardExpired = statSync(path).mtimeMs + HARD_MAX_TTL_MS <= nowMs;
    if (visible.length === 0 || hardExpired) {
      rmSync(path, { force: true });
      removed += 1;
    } else {
      retained += 1;
    }
  }
  return { scanned, removed, retained };
}

/** Conservative allowlist scrubber: uncertainty omits the display instead of partially rendering it. */
export function safeIntentDisplayV2(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (normalized.length === 0 || normalized.length > MAX_INTENT_CHARS) return undefined;
  if (
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    return undefined;
  }
  if (
    /\b(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[:=]/i.test(normalized)
  ) {
    return undefined;
  }
  if (
    /\b(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9]{8,}|xox[baprs]-|AKIA[A-Z0-9]{12}|AIza[\w-]{12,})/i.test(
      normalized,
    )
  ) {
    return undefined;
  }
  if (
    /-----BEGIN [A-Z ]+PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}/.test(normalized)
  ) {
    return undefined;
  }
  if (/\b[A-Za-z0-9_+/=-]{32,}\b/.test(normalized)) return undefined;
  if (/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/.test(normalized)) return undefined;
  if (/(?:^|\s)(?:\/[A-Za-z]|[A-Za-z]:\\|\\\\|\/\/wsl)/.test(normalized)) return undefined;
  if (/[`]|\$\(|&&|\|\||(?:^|\s)--[a-z]/.test(normalized)) return undefined;
  return normalized;
}

function safeTargetLabels(values: string[] | undefined): string[] {
  if (!values || values.length > MAX_TARGET_LABELS) return [];
  const safe = values
    .map((value) => value.normalize("NFC").trim())
    .filter(
      (value) =>
        value.length > 0 &&
        value.length <= MAX_TARGET_CHARS &&
        TARGET_PATTERN.test(value) &&
        !value.startsWith("/") &&
        !value.split("/").includes("..") &&
        safeIntentDisplayV2(value) !== undefined,
    );
  return [...new Set(safe)];
}

function validateLiveRow(value: unknown): LiveDisplayRowV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid live-display row");
  }
  const row = value as Record<string, unknown>;
  const allowed = new Set([
    "format",
    "format_version",
    "row_id",
    "generation_id",
    "event_id",
    "written_at",
    "expires_at",
    "executable",
    "intent_display",
    "target_labels",
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key)))
    throw new Error("invalid live-display row");
  if (
    row.format !== "harnery-event-v2-live-display" ||
    row.format_version !== 1 ||
    typeof row.row_id !== "string" ||
    !/^live_[0-9a-f-]{36}$/.test(row.row_id) ||
    typeof row.generation_id !== "string" ||
    typeof row.event_id !== "string" ||
    typeof row.written_at !== "string" ||
    typeof row.expires_at !== "string"
  ) {
    throw new Error("invalid live-display row");
  }
  assertLiveIds(row.generation_id, row.event_id);
  if (typeof row.executable === "string" && !EXECUTABLE_PATTERN.test(row.executable)) {
    throw new Error("invalid live-display row");
  }
  if (
    typeof row.intent_display === "string" &&
    safeIntentDisplayV2(row.intent_display) !== row.intent_display
  ) {
    throw new Error("invalid live-display row");
  }
  if (
    row.target_labels !== undefined &&
    (!Array.isArray(row.target_labels) ||
      safeTargetLabels(row.target_labels as string[]).length !== row.target_labels.length)
  ) {
    throw new Error("invalid live-display row");
  }
  const writtenMs = Date.parse(row.written_at);
  const expiresMs = Date.parse(row.expires_at);
  if (
    Number.isNaN(writtenMs) ||
    Number.isNaN(expiresMs) ||
    expiresMs <= writtenMs ||
    expiresMs - writtenMs > HARD_MAX_TTL_MS
  ) {
    throw new Error("invalid live-display row");
  }
  return row as unknown as LiveDisplayRowV2;
}

function assertLiveIds(generationId: string, eventId: string): void {
  if (!GENERATION_PATTERN.test(generationId) || !EVENT_PATTERN.test(eventId)) {
    throw new Error("V2 live-display identity is invalid");
  }
}

function liveRoot(coordRoot: string): string {
  return join(resolve(coordRoot), EVENT_V2_LIVE_RELATIVE_ROOT);
}
