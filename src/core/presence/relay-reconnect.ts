/**
 * Reconnect planning for the relay client daemon (ADR 0016, phase 2c).
 *
 * Pure: given the backoff state and what happened to the socket that just
 * closed, decide the reconnect delay and whether the drop deserves a log
 * record. The daemon owns the timers and the socket; this module owns the
 * arithmetic so it can be tested without a live relay.
 *
 * Two rules keep a flapping relay from flooding the presence-relay log:
 *
 *   - Backoff resets only after a connection stayed up for
 *     `STABLE_CONNECTION_MS`. A relay that accepts and immediately drops the
 *     socket keeps backing off instead of reconnecting every second.
 *   - Every drop after a stable connection is logged. Consecutive failed or
 *     short-lived attempts log the first three, then only on power-of-two
 *     attempt numbers or after `QUIET_LOG_INTERVAL_MS`, and the next record
 *     carries how many were skipped.
 */

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
export const STABLE_CONNECTION_MS = 30_000;
export const QUIET_LOG_INTERVAL_MS = 15 * 60_000;
export const CLOSE_REASON_MAX_CHARS = 120;

export interface ReconnectState {
  /** Base delay for the next unstable reconnect. */
  backoffMs: number;
  /** Consecutive attempts without a stable connection. */
  attempt: number;
  /** When the last disconnect record was written (epoch ms). */
  lastLoggedAt: number | null;
  /** Disconnects since that record that were not logged. */
  suppressed: number;
}

export function initialReconnectState(): ReconnectState {
  return { backoffMs: BACKOFF_MIN_MS, attempt: 0, lastLoggedAt: null, suppressed: 0 };
}

export interface SocketEnd {
  /** WebSocket close code; null when the socket never got that far. */
  code: number | null;
  reason: string;
  wasClean: boolean;
  /** When `onopen` fired (epoch ms), or null when it never opened. */
  openedAt: number | null;
  /** When the close was observed (epoch ms). */
  closedAt: number;
  /** Error text seen on this socket before it closed, if any. */
  error?: string;
}

export interface ReconnectPlan {
  delayMs: number;
  next: ReconnectState;
  /** Fields for a `relay.disconnected` record, or null when throttled. */
  log: Record<string, string | number | boolean | null> | null;
}

/** Plan the reconnect after a socket ends. `random` is injectable for tests. */
export function planReconnect(
  state: ReconnectState,
  end: SocketEnd,
  random: () => number = Math.random,
): ReconnectPlan {
  const upMs = end.openedAt === null ? null : Math.max(0, end.closedAt - end.openedAt);
  const stable = upMs !== null && upMs >= STABLE_CONNECTION_MS;
  const base = stable ? BACKOFF_MIN_MS : Math.min(BACKOFF_MAX_MS, state.backoffMs);
  const delayMs = Math.round(base + random() * base * 0.3);
  const attempt = stable ? 1 : state.attempt + 1;

  const shouldLog =
    stable ||
    attempt <= 3 ||
    isPowerOfTwo(attempt) ||
    state.lastLoggedAt === null ||
    end.closedAt - state.lastLoggedAt >= QUIET_LOG_INTERVAL_MS;

  const next: ReconnectState = {
    backoffMs: Math.min(BACKOFF_MAX_MS, base * 2),
    attempt,
    lastLoggedAt: shouldLog ? end.closedAt : state.lastLoggedAt,
    suppressed: shouldLog ? 0 : state.suppressed + 1,
  };
  if (!shouldLog) return { delayMs, next, log: null };

  const reason = truncate(end.reason.trim(), CLOSE_REASON_MAX_CHARS);
  const parts = [
    upMs === null ? "connect failed" : "disconnected",
    `code=${end.code ?? "none"}`,
    `clean=${end.wasClean}`,
    upMs === null ? null : `up=${formatMs(upMs)}`,
    `reconnect in ${formatMs(delayMs)}`,
    attempt > 1 ? `attempt ${attempt}` : null,
    state.suppressed > 0 ? `${state.suppressed} earlier not logged` : null,
  ].filter((p): p is string => p !== null);
  return {
    delayMs,
    next,
    log: {
      phase: upMs === null ? "connect_failed" : "disconnected",
      message: parts.join(" "),
      code: end.code,
      reason: reason || null,
      clean: end.wasClean,
      up_ms: upMs,
      reconnect_ms: delayMs,
      attempt,
      suppressed: state.suppressed,
      error: end.error ? truncate(end.error, CLOSE_REASON_MAX_CHARS) : null,
    },
  };
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function formatMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
