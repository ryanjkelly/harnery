/**
 * One parser for the relative durations commands accept (`--since 7d`,
 * `--budget 30s`, `--if-stale 24h`), so every flag understands the same
 * units. Callers apply their own bounds and defaults.
 */

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

/**
 * Parse `500ms`, `30s`, `5m`, `1.5h`, `7d` or `2w` into whole milliseconds.
 * Units are case-insensitive. Returns null for anything else, including zero,
 * negative amounts and results too large to be a safe integer.
 */
export function parseDurationMs(input: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/i.exec(input.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase() as keyof typeof UNIT_MS;
  const ms = Math.floor(amount * UNIT_MS[unit]);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}
