import { describe, expect, test } from "bun:test";

import {
  deriveExpressiveChannels,
  type ExpressiveAction,
  type ExpressiveInputs,
} from "./expression";

const NOW = "2026-08-16T12:00:00.000Z";

function at(secondsAgo: number): string {
  return new Date(Date.parse(NOW) - secondsAgo * 1000).toISOString();
}

let seq = 0;
function action(overrides: Partial<ExpressiveAction>): ExpressiveAction {
  seq += 1;
  return {
    category: "research",
    outcome: "ok",
    event_id: `ev-${seq}`,
    ts: at(5),
    ...overrides,
  };
}

function inputs(overrides: Partial<ExpressiveInputs>): ExpressiveInputs {
  return {
    activity: "working",
    lastTurnStarted: { ts: at(300), event_id: "prompt-1" },
    actions: [],
    openSubagents: 0,
    ...overrides,
  };
}

describe("deriveExpressiveChannels", () => {
  test("waiting holds on authoritative needs-input and sets input attention", () => {
    const c = deriveExpressiveChannels(inputs({ activity: "needs-input" }), NOW);
    expect(c.expression.value).toBe("waiting");
    expect(c.attention.value).toBe("input");
    expect(c.attention.expires_at).toBeDefined();
  });

  test("a fresh failure is alert + error flash, then decays into friction", () => {
    const fresh = deriveExpressiveChannels(
      inputs({ actions: [action({ outcome: "error", ts: at(3) })] }),
      NOW,
    );
    expect(fresh.expression.value).toBe("alert");
    expect(fresh.attention.value).toBe("error");

    const decayed = deriveExpressiveChannels(
      inputs({ actions: [action({ outcome: "error", ts: at(60) })] }),
      NOW,
    );
    expect(decayed.attention.value).toBe("friction");
    expect(decayed.expression.value).not.toBe("alert");

    const gone = deriveExpressiveChannels(
      inputs({ actions: [action({ outcome: "error", ts: at(400) })] }),
      NOW,
    );
    expect(gone.attention.value).toBe("none");
  });

  test("recovering: a retry after a failure inside the open turn", () => {
    const c = deriveExpressiveChannels(
      inputs({
        actions: [
          action({ outcome: "error", ts: at(40), category: "build" }),
          action({ outcome: "ok", ts: at(20), category: "build" }),
        ],
      }),
      NOW,
    );
    expect(c.expression.value).toBe("recovering");
    expect(c.expression.evidence_event_ids).toHaveLength(2);
  });

  test("celebrating on a fresh successful build/test, low confidence, brief", () => {
    const c = deriveExpressiveChannels(
      inputs({ actions: [action({ category: "test", outcome: "ok", ts: at(3) })] }),
      NOW,
    );
    expect(c.expression.value).toBe("celebrating");
    expect(c.expression.confidence).toBe("low");
    expect(c.attention.value).toBe("completion");

    const later = deriveExpressiveChannels(
      inputs({ actions: [action({ category: "test", outcome: "ok", ts: at(30) })] }),
      NOW,
    );
    expect(later.expression.value).toBe("building");
  });

  test("coordinating while a subagent is open or coordination evidence is current", () => {
    expect(deriveExpressiveChannels(inputs({ openSubagents: 1 }), NOW).expression.value).toBe(
      "coordinating",
    );
    expect(
      deriveExpressiveChannels(
        inputs({ actions: [action({ category: "coordinate", ts: at(10) })] }),
        NOW,
      ).expression.value,
    ).toBe("coordinating");
  });

  test("investigating needs repeated research in one turn; curious is a single glance", () => {
    const investigate = deriveExpressiveChannels(
      inputs({
        actions: [
          action({ ts: at(90) }),
          action({ category: "diagnostic", ts: at(60) }),
          action({ ts: at(10) }),
        ],
      }),
      NOW,
    );
    expect(investigate.expression.value).toBe("investigating");

    const glance = deriveExpressiveChannels(inputs({ actions: [action({ ts: at(10) })] }), NOW);
    expect(glance.expression.value).toBe("curious");
  });

  test("an uncategorized action triggers neither building nor curious", () => {
    const c = deriveExpressiveChannels(
      inputs({ actions: [action({ category: "other", ts: at(5) })] }),
      NOW,
    );
    expect(c.expression.value).toBe("focused");
  });

  test("deliberating: research then a short quiet interval, inferred and low", () => {
    const c = deriveExpressiveChannels(inputs({ actions: [action({ ts: at(35) })] }), NOW);
    expect(c.expression.value).toBe("deliberating");
    expect(c.expression.provenance).toBe("inferred");
    expect(c.expression.confidence).toBe("low");
  });

  test("no open turn means turn-scoped rules cannot fire", () => {
    // Prompt and action both predate the last turn.completed: the turn is closed.
    const c = deriveExpressiveChannels(
      inputs({
        activity: "idle",
        lastTurnStarted: { ts: at(600), event_id: "prompt-1" },
        lastTurnCompleted: { ts: at(500), event_id: "stop-1" },
        actions: [action({ ts: at(550), intent: "stale intent" })],
      }),
      NOW,
    );
    expect(c.expression.value).not.toBe("deliberating");
    expect(c.expression.value).not.toBe("focused");
    expect(c.focus_bubble).toBeUndefined();
  });

  test("action evidence after the last stop opens a turn without a prompt row", () => {
    // Adapters on this stream emit no turn.started; a tool action newer
    // than the last turn.completed is the honest turn-open signal.
    const c = deriveExpressiveChannels(
      inputs({
        lastTurnStarted: undefined,
        lastTurnCompleted: { ts: at(500), event_id: "stop-1" },
        actions: [action({ category: "other", ts: at(5) })],
      }),
      NOW,
    );
    expect(c.expression.value).toBe("focused");
  });

  test("focus bubble: event-backed, summarizes without a clipping ellipsis and cites its event", () => {
    const c = deriveExpressiveChannels(
      inputs({
        actions: [
          action({
            ts: at(20),
            outcome: "started",
            intent: "review the historical project Codex config changes so every adapter agrees",
          }),
        ],
      }),
      NOW,
    );
    expect(c.focus_bubble?.value.text).toBe("review the historical project");
    expect(c.focus_bubble?.value.basis).toBe("event-backed");
    expect(c.focus_bubble?.expires_at).toBeDefined();
    expect(c.focus_bubble?.evidence_event_ids).toHaveLength(1);
  });

  test("neutral is the fallback with no evidence", () => {
    const c = deriveExpressiveChannels(
      inputs({ activity: "idle", lastTurnStarted: undefined }),
      NOW,
    );
    expect(c.expression.value).toBe("neutral");
    expect(c.attention.value).toBe("none");
  });
});

describe("extended-tier expressions", () => {
  test("blocked lifecycle outranks everything except needs-input waiting", () => {
    const blocked = deriveExpressiveChannels(
      inputs({
        lifecycleState: { value: "blocked", ts: at(30), event_id: "lc-1" },
        actions: [action({ category: "edit", ts: at(5) })],
      }),
      NOW,
    );
    expect(blocked.expression.value).toBe("blocked");
    const waiting = deriveExpressiveChannels(
      inputs({
        activity: "needs-input",
        lifecycleState: { value: "blocked", ts: at(30), event_id: "lc-1" },
      }),
      NOW,
    );
    expect(waiting.expression.value).toBe("waiting");
  });

  test("dormant on a long open timer wait, but never on input-like waits", () => {
    const dormant = deriveExpressiveChannels(
      inputs({ openWait: { kind: "timer", ts: at(90), event_id: "w-1" }, actions: [] }),
      NOW,
    );
    expect(dormant.expression.value).toBe("dormant");
    const farWake = deriveExpressiveChannels(
      inputs({
        openWait: {
          kind: "timer",
          ts: at(5),
          wake_at: new Date(Date.parse(NOW) + 600_000).toISOString(),
          event_id: "w-2",
        },
      }),
      NOW,
    );
    expect(farWake.expression.value).toBe("dormant");
    const inputWait = deriveExpressiveChannels(
      inputs({ openWait: { kind: "permission", ts: at(90), event_id: "w-3" } }),
      NOW,
    );
    expect(inputWait.expression.value).not.toBe("dormant");
  });

  test("compacting fires on a fresh compaction boundary and decays", () => {
    const started = deriveExpressiveChannels(
      inputs({ lastCompaction: { phase: "started", ts: at(60), event_id: "cp-1" } }),
      NOW,
    );
    expect(started.expression.value).toBe("compacting");
    const stale = deriveExpressiveChannels(
      inputs({ lastCompaction: { phase: "completed", ts: at(60), event_id: "cp-2" } }),
      NOW,
    );
    expect(stale.expression.value).not.toBe("compacting");
  });

  test("conducting at three open subagents, coordinating below", () => {
    expect(deriveExpressiveChannels(inputs({ openSubagents: 3 }), NOW).expression.value).toBe(
      "conducting",
    );
    expect(deriveExpressiveChannels(inputs({ openSubagents: 2 }), NOW).expression.value).toBe(
      "coordinating",
    );
  });

  test("observing on a fresh image artifact, investigating without one", () => {
    const research = [action({ ts: at(20) }), action({ ts: at(15) }), action({ ts: at(10) })];
    const observing = deriveExpressiveChannels(
      inputs({ actions: research, lastImageObserved: { ts: at(8), event_id: "img-1" } }),
      NOW,
    );
    expect(observing.expression.value).toBe("observing");
    const noImage = deriveExpressiveChannels(inputs({ actions: research }), NOW);
    expect(noImage.expression.value).toBe("investigating");
  });

  test("strained on a low context band inside an open turn", () => {
    const strained = deriveExpressiveChannels(
      inputs({ contextBand: "low", actions: [action({ ts: at(200) })] }),
      NOW,
    );
    expect(strained.expression.value).toBe("strained");
    const ample = deriveExpressiveChannels(
      inputs({ contextBand: "ample", actions: [action({ ts: at(200) })] }),
      NOW,
    );
    expect(ample.expression.value).not.toBe("strained");
  });

  test("wrapping-up replaces neutral when lifecycle is done, without masking work", () => {
    const done = deriveExpressiveChannels(
      inputs({
        activity: "idle",
        lastTurnStarted: undefined,
        lifecycleState: { value: "done", ts: at(120), event_id: "lc-2" },
      }),
      NOW,
    );
    expect(done.expression.value).toBe("wrapping-up");
    const stillWorking = deriveExpressiveChannels(
      inputs({
        lifecycleState: { value: "done", ts: at(120), event_id: "lc-2" },
        actions: [action({ category: "edit", ts: at(5) })],
      }),
      NOW,
    );
    expect(stillWorking.expression.value).toBe("building");
  });
});
