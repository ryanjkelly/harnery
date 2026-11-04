/**
 * How long the current turn has been running, for the closing status box.
 *
 * The box already reports `session`, which is cumulative and says nothing
 * about the work just done: a 9-minute session hides whether this turn took
 * twelve seconds or eight minutes. `turn` measures from the operator's prompt
 * (`turn.started`) to the moment the box renders, so the operator reads the
 * cost of the turn they are about to be handed.
 *
 * Every read here is best-effort by contract. A missing ledger, an
 * unvalidated one, or no `turn.started` for this owner renders no row rather
 * than failing the status command.
 */
import type { EventV3 } from "../events/v3/contract.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";
import { resolveTurnRange } from "./turn-range.ts";

export interface TurnElapsed {
  /** Seconds from the turn's start to its terminal, or to `now` while open. */
  secs: number;
  /** True once a `turn.completed` closed the turn this measures. */
  complete: boolean;
  /** Stop-hook restarts folded into this measurement. */
  remediation_restarts: number;
}

function timeMs(event: EventV3 | undefined): number {
  if (!event) return Number.NaN;
  return Date.parse(event.time.observed_at);
}

function generationOf(event: EventV3): string | undefined {
  return "generation_id" in event.scope ? event.scope.generation_id : undefined;
}

/**
 * Measure the newest turn for `instanceId` from an already-read event stream.
 *
 * Explicit adjacent continuation links preserve the operator's original
 * prompt across retries, while late recoveries cannot replace a newer turn.
 */
export function resolveTurnElapsed(
  events: readonly EventV3[],
  instanceId: string,
  now: number = Date.now(),
): TurnElapsed | null {
  const range = resolveTurnRange(events, instanceId, now);
  if (!range) return null;

  // A terminal only closes the measurement when nothing restarted the turn
  // after it, so match against the newest start rather than the walked-back
  // one. Otherwise the `turn.completed` that a Stop-hook bounce produced would
  // end the measurement mid-remediation.
  const terminal = events.find(
    (event) =>
      event.event_type === "turn.completed" &&
      event.scope.instance_id === range.latest.scope.instance_id &&
      generationOf(event) === range.generationId &&
      "turn_id" in event.scope &&
      event.scope.turn_id === range.latest.scope.turn_id &&
      timeMs(event) >= range.latestStartMs &&
      timeMs(event) <= now,
  );
  const terminalMs = timeMs(terminal);
  const endMs = Number.isFinite(terminalMs) ? terminalMs : now;
  return {
    secs: Math.max(0, Math.floor((endMs - range.startMs) / 1000)),
    complete: Number.isFinite(terminalMs),
    remediation_restarts: range.continuationCount,
  };
}

/**
 * Render a turn duration for the box. Seconds stay visible below an hour
 * because most turns land there and a bare `4m` cannot be compared with the
 * turn before it.
 */
export function formatTurnElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export interface TurnElapsedTarget {
  coordRoot: string;
  instanceId: string;
}

/**
 * The whole status-box contribution in one best-effort call: read the ledger
 * and render this session's `turn` row. Null means render no row.
 */
export function turnElapsedStatusRow(
  target: TurnElapsedTarget,
  now: number = Date.now(),
): { value: string; elapsed: TurnElapsed } | null {
  try {
    const ledger = readLedgerV3(target.coordRoot);
    if (!ledger.complete) return null;
    const elapsed = resolveTurnElapsed(
      ledger.events.map((positioned) => positioned.event),
      target.instanceId,
      now,
    );
    if (!elapsed) return null;
    return { value: formatTurnElapsed(elapsed.secs), elapsed };
  } catch {
    return null;
  }
}
