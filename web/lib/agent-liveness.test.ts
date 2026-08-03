import { describe, expect, test } from "bun:test";

import { agentLiveness, HEARTBEAT_GRACE_MS } from "./agent-liveness.ts";

const START = "2026-07-26T08:34:40.481Z";
const started = Date.parse(START);

describe("agentLiveness", () => {
  test("a heartbeat present makes the row live regardless of age", () => {
    expect(agentLiveness({ startedAt: START, live: true, now: started })).toBe("live");
    expect(agentLiveness({ startedAt: START, live: true, now: started + 60 * 60_000 })).toBe(
      "live",
    );
    // Live short-circuits before the timestamp is even parsed.
    expect(agentLiveness({ startedAt: "not a date", live: true, now: started })).toBe("live");
  });

  test("a young agent with no heartbeat is starting, not stalled", () => {
    // The screenshot that prompted this caught a reviewer at 10s and reported
    // it as a dead orchestrator.
    expect(agentLiveness({ startedAt: START, live: false, now: started + 10_000 })).toBe(
      "starting",
    );
    expect(agentLiveness({ startedAt: START, live: false, now: started })).toBe("starting");
  });

  test("the grace boundary is exclusive, so the warning does fire", () => {
    expect(
      agentLiveness({ startedAt: START, live: false, now: started + HEARTBEAT_GRACE_MS - 1 }),
    ).toBe("starting");
    expect(
      agentLiveness({ startedAt: START, live: false, now: started + HEARTBEAT_GRACE_MS }),
    ).toBe("stalled");
  });

  test("the grace window covers the measured registration lag", () => {
    // Instrumented run: heartbeat first readable ~16s after agent.start.
    expect(HEARTBEAT_GRACE_MS).toBeGreaterThan(16_000);
  });

  test("a long-quiet agent with no heartbeat is still a warning", () => {
    expect(agentLiveness({ startedAt: START, live: false, now: started + 20 * 60_000 })).toBe(
      "stalled",
    );
  });

  test("nothing is claimed before the clock is read or when the start is unparseable", () => {
    expect(agentLiveness({ startedAt: START, live: false, now: null })).toBe("unknown");
    expect(agentLiveness({ startedAt: "not a date", live: false, now: started })).toBe("unknown");
  });

  test("the grace window is overridable for a caller with its own measurement", () => {
    expect(
      agentLiveness({ startedAt: START, live: false, now: started + 5_000, graceMs: 1_000 }),
    ).toBe("stalled");
  });
});
