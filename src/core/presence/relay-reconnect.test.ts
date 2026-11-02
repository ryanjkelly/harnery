import { describe, expect, test } from "bun:test";
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  initialReconnectState,
  planReconnect,
  QUIET_LOG_INTERVAL_MS,
  type ReconnectState,
  STABLE_CONNECTION_MS,
} from "./relay-reconnect.ts";

const noJitter = () => 0;

describe("planReconnect", () => {
  test("a drop after a stable connection logs code, reason, uptime and delay, and resets backoff", () => {
    const state: ReconnectState = {
      backoffMs: 32_000,
      attempt: 6,
      lastLoggedAt: 0,
      suppressed: 2,
    };
    const plan = planReconnect(
      state,
      {
        code: 1006,
        reason: "",
        wasClean: false,
        openedAt: 1_000,
        closedAt: 1_000 + 36_000,
      },
      noJitter,
    );
    expect(plan.delayMs).toBe(BACKOFF_MIN_MS);
    expect(plan.next).toEqual({
      backoffMs: BACKOFF_MIN_MS * 2,
      attempt: 1,
      lastLoggedAt: 37_000,
      suppressed: 0,
    });
    expect(plan.log).toMatchObject({
      phase: "disconnected",
      code: 1006,
      reason: null,
      clean: false,
      up_ms: 36_000,
      reconnect_ms: BACKOFF_MIN_MS,
      attempt: 1,
      suppressed: 2,
      error: null,
    });
    expect(plan.log?.message).toBe(
      "disconnected code=1006 clean=false up=36.0s reconnect in 1.0s 2 earlier not logged",
    );
  });

  test("a socket that never opened is a connect failure and keeps backing off", () => {
    let state = initialReconnectState();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const plan = planReconnect(
        state,
        { code: 1006, reason: "", wasClean: false, openedAt: null, closedAt: i * 1_000 },
        noJitter,
      );
      delays.push(plan.delayMs);
      state = plan.next;
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(state.backoffMs).toBe(BACKOFF_MAX_MS);
  });

  test("an accept-then-drop relay does not reset backoff", () => {
    const state: ReconnectState = { backoffMs: 8_000, attempt: 3, lastLoggedAt: 0, suppressed: 0 };
    const plan = planReconnect(
      state,
      {
        code: 1011,
        reason: "x",
        wasClean: true,
        openedAt: 0,
        closedAt: STABLE_CONNECTION_MS - 1,
      },
      noJitter,
    );
    expect(plan.delayMs).toBe(8_000);
    expect(plan.next.attempt).toBe(4);
    expect(plan.log?.phase).toBe("disconnected");
  });

  test("a tight failure loop logs only a handful of records and counts the rest", () => {
    let state = initialReconnectState();
    let logged = 0;
    let clock = 0;
    let lastSuppressedReported = 0;
    // 200 failures at the 60s backoff cap span a bit over three hours.
    for (let i = 0; i < 200; i++) {
      const plan = planReconnect(
        state,
        { code: null, reason: "", wasClean: false, openedAt: null, closedAt: clock },
        noJitter,
      );
      if (plan.log) {
        logged++;
        lastSuppressedReported = Number(plan.log.suppressed);
      }
      state = plan.next;
      clock += plan.delayMs;
    }
    // First three, powers of two (4..128), plus one every 15 quiet minutes.
    const quietWindows = Math.ceil(clock / QUIET_LOG_INTERVAL_MS);
    expect(logged).toBeLessThanOrEqual(3 + 6 + quietWindows);
    expect(logged).toBeGreaterThan(3);
    expect(lastSuppressedReported).toBeGreaterThan(0);
  });

  test("long close reasons and error text are truncated", () => {
    const plan = planReconnect(
      initialReconnectState(),
      {
        code: 4000,
        reason: "r".repeat(500),
        wasClean: true,
        openedAt: null,
        closedAt: 0,
        error: "e".repeat(500),
      },
      noJitter,
    );
    expect(String(plan.log?.reason).length).toBe(120);
    expect(String(plan.log?.error).length).toBe(120);
    expect(plan.log?.message).toBe("connect failed code=4000 clean=true reconnect in 1.0s");
  });
});
