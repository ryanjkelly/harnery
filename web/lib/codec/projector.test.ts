import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentsSnapshot, Heartbeat } from "@/lib/coord-reader";

import type { CodecSourceEvidence } from "./contracts";
import { __resetContextBandMemory, projectScene } from "./projector";

const NOW = "2026-08-16T10:05:00.000Z";

function hb(overrides: Partial<Heartbeat>): Heartbeat {
  return {
    instance_id: "inst-1",
    name: "Sara",
    last_heartbeat: "2026-08-16T10:04:50.000Z",
    files_touched: [],
    activity: "working",
    task_state: "active",
    age_seconds: 10,
    ...overrides,
  };
}

function snapshot(
  active: Heartbeat[],
  stale: Heartbeat[] = [],
  terminal: Heartbeat[] = [],
): AgentsSnapshot {
  return {
    active,
    stale,
    terminal,
    claims: [],
    meta: {
      scanned_dir: "/tmp",
      count: active.length + stale.length,
      invalid: [],
      stale_threshold_seconds: 300,
    },
  };
}

let seq = 0;
function ev(overrides: Partial<CodecSourceEvidence>): CodecSourceEvidence {
  seq += 1;
  return {
    schema_version: 2,
    event_id: `01J${String(seq).padStart(23, "0")}`,
    event_type: "coord.status_observed",
    ts: "2026-08-16T10:04:00.000Z",
    instance_id: "inst-1",
    ...overrides,
  };
}

beforeEach(() => {
  __resetContextBandMemory();
});

describe("projectScene", () => {
  test("cold bootstrap from the snapshot alone renders evidence-safe panels", () => {
    const scene = projectScene({
      snapshot: snapshot([
        hb({ task: "Ship the codec view", task_updated_at: "2026-08-16T10:00:00.000Z" }),
      ]),
      events: [],
      now: NOW,
    });
    expect(scene.schema_version).toBe(2);
    expect(scene.panels).toHaveLength(1);
    const panel = scene.panels[0];
    expect(panel).toBeDefined();
    if (!panel) throw new Error("panel missing");
    expect(panel.identity.display_name).toBe("Sara");
    expect(panel.identity.task?.value).toBe("Ship the codec view");
    expect(panel.presence).toMatchObject({ value: "online", provenance: "projection" });
    expect(panel.activity).toMatchObject({ value: "working", provenance: "projection" });
    // No task_state_updated_at and no event evidence → lifecycle unknown, not
    // the heartbeat's compatibility default.
    expect(panel.lifecycle.value).toBe("unknown");
    expect(panel.context_band).toMatchObject({ value: "unknown", provenance: "unknown" });
    expect(panel.expression.value).toBe("neutral");
    expect(panel.attention.value).toBe("none");
    expect(panel.character.pack_id).toBe("fallback-neutral");
    expect(scene.relationships).toEqual([]);
    expect(scene.transients).toEqual([]);
  });

  test("determinism: same inputs produce the same scene", () => {
    const inputs = {
      snapshot: snapshot([hb({})]),
      events: [ev({ event_type: "context.observed", used_percent: 40 })],
      now: NOW,
    };
    const a = JSON.stringify(projectScene(inputs));
    __resetContextBandMemory();
    const b = JSON.stringify(projectScene(inputs));
    expect(a).toBe(b);
  });

  test("stale leftover heartbeats are omitted; session.ended still yields offline", () => {
    const staleHb = hb({ age_seconds: 900 });
    const noEnd = projectScene({ snapshot: snapshot([], [staleHb]), events: [], now: NOW });
    expect(noEnd.panels).toHaveLength(0);
    expect(noEnd.team_ambience.value).toBe("unknown");

    const ended = projectScene({
      snapshot: snapshot([], [staleHb]),
      events: [
        ev({ event_type: "session.started", ts: "2026-08-16T09:00:00.000Z" }),
        ev({ event_type: "session.ended", ts: "2026-08-16T10:00:00.000Z" }),
      ],
      now: NOW,
    });
    expect(ended.panels[0]?.presence).toMatchObject({ value: "offline", provenance: "event" });
    expect(ended.team_ambience.value).toBe("calm");

    // A restart after the recorded end must not read as offline.
    const restarted = projectScene({
      snapshot: snapshot([hb({})]),
      events: [
        ev({ event_type: "session.ended", ts: "2026-08-16T10:00:00.000Z" }),
        ev({ event_type: "session.started", ts: "2026-08-16T10:02:00.000Z" }),
      ],
      now: NOW,
    });
    expect(restarted.panels[0]?.presence.value).toBe("online");
  });

  test("stale leftover heartbeats do not fill the live scene or make it busy", () => {
    const leftovers = Array.from({ length: 20 }, (_, i) =>
      hb({
        instance_id: `dead-${i}`,
        name: `Dead${i}`,
        age_seconds: 900,
        activity: "working",
      }),
    );
    const scene = projectScene({
      snapshot: snapshot([hb({ activity: "idle" })], leftovers),
      events: [],
      now: NOW,
    });
    expect(scene.panels).toHaveLength(1);
    expect(scene.panels[0]?.identity.display_name).toBe("Sara");
    expect(scene.panels[0]?.presence.value).toBe("online");
    expect(scene.team_ambience.value).toBe("calm");
  });

  test("recent evidence still surfaces a stale heartbeat as online, not unknown", () => {
    const staleWorking = hb({ age_seconds: 900, activity: "working" });
    const scene = projectScene({
      snapshot: snapshot([], [staleWorking]),
      events: [
        ev({
          event_type: "tool.requested",
          category: "edit",
          outcome: "started",
          ts: "2026-08-16T10:03:00.000Z",
        }),
      ],
      now: NOW,
    });
    expect(scene.panels).toHaveLength(1);
    expect(scene.panels[0]?.identity.display_name).toBe("Sara");
    expect(scene.panels[0]?.presence).toMatchObject({
      value: "online",
      provenance: "event",
      confidence: "medium",
    });
    expect(scene.panels[0]?.activity).toMatchObject({ value: "working", provenance: "event" });
  });

  test("an old session.ended on a stale heartbeat does not linger in the scene", () => {
    const scene = projectScene({
      snapshot: snapshot([], [hb({ age_seconds: 7200 })]),
      events: [ev({ event_type: "session.ended", ts: "2026-08-16T08:00:00.000Z" })],
      now: NOW,
    });
    expect(scene.panels).toHaveLength(0);
  });

  test("lifecycle prefers the stamped projection, then event evidence, then unknown", () => {
    const stamped = projectScene({
      snapshot: snapshot([
        hb({ task_state: "blocked", task_state_updated_at: "2026-08-16T10:01:00.000Z" }),
      ]),
      events: [],
      now: NOW,
    });
    expect(stamped.panels[0]?.lifecycle).toMatchObject({
      value: "blocked",
      provenance: "projection",
    });

    const fromEvent = projectScene({
      snapshot: snapshot([hb({})]),
      events: [ev({ event_type: "coord.lifecycle_changed", task_state: "done" })],
      now: NOW,
    });
    expect(fromEvent.panels[0]?.lifecycle).toMatchObject({ value: "done", provenance: "event" });
  });

  test("context bands map remaining capacity and hold at boundaries (hysteresis)", () => {
    const band = (usedPercent: number) =>
      projectScene({
        snapshot: snapshot([hb({})]),
        events: [ev({ event_type: "context.observed", used_percent: usedPercent })],
        now: NOW,
      }).panels[0]?.context_band.value;

    expect(band(30)).toBe("ample"); // 70 remaining
    __resetContextBandMemory();
    expect(band(60)).toBe("reduced"); // 40 remaining
    __resetContextBandMemory();
    expect(band(85)).toBe("low"); // 15 remaining

    // Hysteresis: 49 remaining → reduced; a wiggle to 51 remaining stays
    // reduced because it moved only 2 points across the boundary.
    __resetContextBandMemory();
    expect(band(51)).toBe("reduced");
    expect(band(49)).toBe("reduced");
    // A decisive move clears the hold.
    expect(band(30)).toBe("ample");
  });

  test("progress rhythm follows evidence windows, never silence forecasts", () => {
    const rhythm = (events: CodecSourceEvidence[]) =>
      projectScene({ snapshot: snapshot([hb({})]), events, now: NOW }).panels[0]?.progress_rhythm
        .value;

    expect(rhythm([ev({ event_type: "turn.started", ts: "2026-08-16T10:04:30.000Z" })])).toBe(
      "just-started",
    );
    expect(
      rhythm([
        ev({
          event_type: "tool.completed",
          ts: "2026-08-16T10:04:40.000Z",
          category: "edit",
          outcome: "ok",
        }),
      ]),
    ).toBe("in-motion");
    expect(rhythm([ev({ event_type: "turn.completed", ts: "2026-08-16T10:04:55.000Z" })])).toBe(
      "wrapping-up",
    );
    // An old turn stop is not "wrapping-up" and silence is not progress.
    expect(rhythm([ev({ event_type: "turn.completed", ts: "2026-08-16T09:00:00.000Z" })])).toBe(
      "unknown",
    );
  });

  test("recent actions keep the newest three closed actions only", () => {
    const scene = projectScene({
      snapshot: snapshot([hb({})]),
      events: [
        ev({
          event_type: "tool.completed",
          category: "research",
          outcome: "ok",
          ts: "2026-08-16T10:01:00.000Z",
        }),
        ev({
          event_type: "tool.completed",
          category: "edit",
          outcome: "ok",
          ts: "2026-08-16T10:02:00.000Z",
        }),
        ev({
          event_type: "command.completed",
          category: "diagnostic",
          outcome: "error",
          ts: "2026-08-16T10:03:00.000Z",
        }),
        ev({
          event_type: "tool.completed",
          category: "test",
          outcome: "ok",
          ts: "2026-08-16T10:04:00.000Z",
        }),
        ev({
          event_type: "tool.requested",
          category: "build",
          outcome: "started",
          ts: "2026-08-16T10:04:30.000Z",
        }),
      ],
      now: NOW,
    });
    const trail = scene.panels[0]?.recent_actions ?? [];
    expect(trail).toHaveLength(3);
    expect(trail.map((a) => a.category)).toEqual(["test", "diagnostic", "edit"]);
  });

  test("evidence-backed panel survives a swept heartbeat; noise and stale evidence do not", () => {
    const events = [
      ev({
        event_type: "coord.identity_attested",
        identity_name: "Quentin",
        ts: "2026-08-16T09:00:00.000Z",
      }),
      ev({
        event_type: "coord.task_changed",
        task: "Review fixes",
        ts: "2026-08-16T09:30:00.000Z",
      }),
      ev({
        event_type: "tool.requested",
        category: "research",
        outcome: "started",
        ts: "2026-08-16T10:03:00.000Z",
      }),
      // a different instance with only incidental evidence: no panel
      ev({
        event_type: "coord.status_observed",
        instance_id: "inst-noise",
        ts: "2026-08-16T10:03:00.000Z",
      }),
      // a third instance whose evidence is far outside the window: no panel
      ev({
        event_type: "tool.requested",
        instance_id: "inst-old",
        category: "edit",
        ts: "2026-08-16T05:00:00.000Z",
      }),
      ev({
        event_type: "coord.identity_attested",
        instance_id: "inst-old",
        identity_name: "Old",
        ts: "2026-08-16T05:00:00.000Z",
      }),
    ];
    const scene = projectScene({ snapshot: snapshot([]), events, now: NOW });
    expect(scene.panels.map((p) => p.identity.display_name)).toEqual(["Quentin"]);
    const q = scene.panels[0];
    if (!q) throw new Error("panel missing");
    // Non-end evidence 2 minutes old: online, event-backed, medium confidence.
    expect(q.presence).toMatchObject({
      value: "online",
      provenance: "event",
      confidence: "medium",
    });
    expect(q.activity).toMatchObject({ value: "working", provenance: "event" });
    expect(q.identity.task?.value).toBe("Review fixes");

    // With a session.ended as the newest lifecycle signal, the panel reads
    // offline instead of online.
    const endedScene = projectScene({
      snapshot: snapshot([]),
      events: [...events, ev({ event_type: "session.ended", ts: "2026-08-16T10:04:00.000Z" })],
      now: NOW,
    });
    expect(endedScene.panels[0]?.presence.value).toBe("offline");
    expect(endedScene.panels[0]?.activity.value).toBe("idle");
  });

  test("coord.identity_attested alone is incidental and does not create a panel", () => {
    const scene = projectScene({
      snapshot: snapshot([]),
      events: [
        ev({
          event_type: "coord.identity_attested",
          identity_name: "Ghost",
          instance_id: "inst-ghost",
          ts: "2026-08-16T10:04:00.000Z",
        }),
      ],
      now: NOW,
    });
    expect(scene.panels).toHaveLength(0);
  });

  test("quiet stale evidence does not linger as unknown panels", () => {
    const scene = projectScene({
      snapshot: snapshot([]),
      events: [
        ev({
          event_type: "coord.identity_attested",
          identity_name: "Quentin",
          ts: "2026-08-16T09:50:00.000Z",
        }),
        ev({
          event_type: "tool.requested",
          category: "research",
          outcome: "started",
          ts: "2026-08-16T09:50:00.000Z",
        }),
      ],
      now: NOW,
    });
    expect(scene.panels).toHaveLength(0);
  });

  test("a heartbeat panel is never duplicated by evidence", () => {
    const scene = projectScene({
      snapshot: snapshot([hb({})]),
      events: [
        ev({ event_type: "tool.requested", category: "research", ts: "2026-08-16T10:03:00.000Z" }),
      ],
      now: NOW,
    });
    expect(scene.panels).toHaveLength(1);
  });

  test("ping transients render only unexpired and only between rendered panels", () => {
    const panels = snapshot([hb({}), hb({ instance_id: "inst-2", name: "Kai" })]);
    const scene = projectScene({
      snapshot: panels,
      events: [
        // fresh ping between two panels: renders
        ev({
          event_type: "coord.message_observed",
          ping_to: "inst-2",
          ts: "2026-08-16T10:04:57.000Z",
        }),
        // expired ping: suppressed
        ev({
          event_type: "coord.message_observed",
          ping_to: "inst-2",
          ts: "2026-08-16T10:00:00.000Z",
        }),
        // ping to an un-paneled instance: suppressed, never guessed
        ev({
          event_type: "coord.message_observed",
          ping_to: "inst-ghost",
          ts: "2026-08-16T10:04:58.000Z",
        }),
      ],
      now: NOW,
    });
    expect(scene.transients).toHaveLength(1);
    expect(scene.transients[0]).toMatchObject({
      kind: "message",
      from_instance_id: "inst-1",
      to_instance_id: "inst-2",
      provenance: "event",
    });
    expect(Date.parse(scene.transients[0]?.expires_at ?? "")).toBeGreaterThan(Date.parse(NOW));
  });

  test("team ambience is deterministic from activity", () => {
    const busy = projectScene({
      snapshot: snapshot([hb({}), hb({ instance_id: "inst-2", name: "Kai" })]),
      events: [],
      now: NOW,
    });
    expect(busy.team_ambience.value).toBe("busy");

    const alert = projectScene({
      snapshot: snapshot([hb({ activity: "needs_input" })]),
      events: [],
      now: NOW,
    });
    expect(alert.team_ambience.value).toBe("alert");

    const empty = projectScene({ snapshot: snapshot([]), events: [], now: NOW });
    expect(empty.team_ambience.value).toBe("unknown");
  });

  test("joins parentage through V3 generation ids, not parent_session_id", () => {
    const parentGen = "gen_11111111-1111-7111-8111-111111111111";
    const childGen = "gen_22222222-2222-7222-8222-222222222222";
    const scene = projectScene({
      snapshot: snapshot([
        hb({ instance_id: "inst-parent", name: "Parent", generation_id: parentGen }),
        hb({ instance_id: "inst-child", name: "Child", generation_id: childGen }),
      ]),
      events: [
        ev({
          instance_id: "inst-child",
          event_type: "session.started",
          generation_id: childGen,
          parent_generation_id: parentGen,
        }),
        ev({
          instance_id: "inst-parent",
          event_type: "agent.started",
          generation_id: parentGen,
          child_generation_id: childGen,
        }),
      ],
      now: NOW,
    });
    const child = scene.panels.find((panel) => panel.instance_id === "inst-child");
    expect(child?.parent_instance_id?.value).toBe("inst-parent");
  });

  test("terminal ledger snapshots render offline within the evidence window", () => {
    const scene = projectScene({
      snapshot: snapshot(
        [],
        [],
        [
          hb({
            instance_id: "inst-done",
            name: "Done",
            ledger_state: "terminal",
            last_heartbeat: "2026-08-16T10:00:00.000Z",
            age_seconds: 300,
          }),
        ],
      ),
      events: [],
      now: NOW,
    });
    expect(scene.panels).toHaveLength(1);
    expect(scene.panels[0]?.presence.value).toBe("offline");
    expect(scene.panels[0]?.ledger_state?.value).toBe("terminal");
  });

  test("recovery-required ledger state presents as recovering", () => {
    const scene = projectScene({
      snapshot: snapshot([
        hb({ ledger_state: "recovery-required", last_heartbeat: "2026-08-16T10:04:50.000Z" }),
      ]),
      events: [],
      now: NOW,
    });
    expect(scene.panels[0]?.ledger_state?.value).toBe("recovery-required");
    expect(scene.panels[0]?.expression.value).toBe("recovering");
  });
});
