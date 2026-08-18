/**
 * How long an agent may be transcripted running with no heartbeat before that is
 * worth warning about.
 *
 * A child registers its heartbeat a beat after the orchestrator starts it, not
 * at the same instant. Measured on an instrumented run: `session.started` at
 * +0.5s, the heartbeat file first readable at roughly +16s, so a child that
 * lives under that never appears live at all. Warning immediately reported a
 * normal startup in the vocabulary of a dead orchestrator, which is what sent
 * two false alarms in one session.
 */
export const HEARTBEAT_GRACE_MS = 20_000;

export type AgentLiveness =
  /** A heartbeat for this agent's child session is present and unterminated. */
  | "live"
  /** No heartbeat yet, but the agent is young enough that this is the ordinary
   * gap between `agent.start` and the child registering. Not a warning. */
  | "starting"
  /** No heartbeat, and long enough that something is actually wrong: the agent
   * is between attempts, or the orchestrator exited without `agent.end`. */
  | "stalled"
  /** The elapsed time is not known yet (no clock read on this pass) or the
   * start timestamp does not parse. Render neither state. */
  | "unknown";

/**
 * Which of the three states an in-flight agent row is in.
 *
 * Pure so it can be pinned by a test: the component that uses it renders on the
 * server with `now: null` and again on the client after an effect reads the
 * clock, and the boundary between "starting" and "stalled" is the whole point
 * of the change.
 */
export function agentLiveness(input: {
  startedAt: string;
  live: boolean;
  /** Wall clock, or null before the first client tick. */
  now: number | null;
  graceMs?: number;
}): AgentLiveness {
  if (input.live) return "live";
  const started = Date.parse(input.startedAt);
  if (Number.isNaN(started)) return "unknown";
  if (input.now === null) return "unknown";
  const grace = input.graceMs ?? HEARTBEAT_GRACE_MS;
  return input.now - started < grace ? "starting" : "stalled";
}
