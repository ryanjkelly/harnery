import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../tests/helpers/event-v3-runtime.ts";
import {
  admitWaitingSubjectRowsV3,
  queueWaitingSubjectRowsV3,
} from "../../../tests/helpers/event-v3-waiting.ts";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import { readHookProducerStateV3 } from "../events/v3/producers/recorder.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";
import {
  endSessionExplicitV3,
  listSessionFinalizationRequestsV3,
  observeHostDisappearedV3,
  reconcileSessionFinalizationV3,
  requestSessionEndExplicitV3,
} from "./session-finalizer-v3.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

const WAITING = { state: "unavailable", reason: "generation_rows_waiting" } as const;

describe("session finalizer holds while the generation has waiting rows", () => {
  test("host loss records no observation or request, then observes once the rows are admitted", () => {
    const { root, state } = seeded("host-loss");
    const rows = queueWaitingSubjectRowsV3(root, "codex", "host-loss-session");
    const before = ledgerIds(root);

    expect(observeHostDisappearedV3(subject(root, state))).toEqual(WAITING);
    expect(listSessionFinalizationRequestsV3(root)).toEqual([]);
    expect(ledgerIds(root)).toEqual(before);

    admitWaitingSubjectRowsV3(root, rows);
    expect(observeHostDisappearedV3(subject(root, state)).state).toBe("observed");
    expect(eventTypes(root)).toContain("lifecycle.sweep_observed");
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
  });

  test("an idle observation is not written while rows wait, and is on the next pass", () => {
    const { root } = seeded("idle");
    const rows = queueWaitingSubjectRowsV3(root, "codex", "idle-session");
    const later = new Date(Date.now() + 4 * 24 * 60 * 60 * 1_000);

    const first = reconcileSessionFinalizationV3(root, { now: later, archive_observations: [] });
    expect(first.observed).toBe(0);
    expect(listSessionFinalizationRequestsV3(root)).toEqual([]);
    expect(eventTypes(root)).not.toContain("lifecycle.sweep_observed");

    admitWaitingSubjectRowsV3(root, rows);
    const second = reconcileSessionFinalizationV3(root, { now: later, archive_observations: [] });
    expect(second.observed).toBe(1);
    expect(listSessionFinalizationRequestsV3(root)).toHaveLength(1);
  });

  test("a due request stays pending with no end while rows wait, then finalizes", () => {
    const { root, state } = seeded("due");
    const observedAt = new Date().toISOString();
    expect(
      observeHostDisappearedV3({ ...subject(root, state), observed_at: observedAt }).state,
    ).toBe("observed");
    const rows = queueWaitingSubjectRowsV3(root, "codex", "due-session");
    const due = new Date(Date.now() + 60 * 60 * 1_000);

    const held = reconcileSessionFinalizationV3(root, { now: due, archive_observations: [] });
    expect(held).toMatchObject({ finalized: 0, pending: 1, cancelled: 0 });
    expect(held.diagnostics.some((code) => code.endsWith(":generation_rows_waiting"))).toBeTrue();
    expect(listSessionFinalizationRequestsV3(root)[0]?.status).toBe("pending");
    expect(eventTypes(root)).not.toContain("session.ended");

    admitWaitingSubjectRowsV3(root, rows);
    const done = reconcileSessionFinalizationV3(root, { now: due, archive_observations: [] });
    expect(done).toMatchObject({ finalized: 1, pending: 0 });
    expect(eventTypes(root)).toContain("session.ended");
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
  });

  test("an explicit end returns unavailable with the waiting reason, then ends", () => {
    const { root, state } = seeded("explicit");
    const rows = queueWaitingSubjectRowsV3(root, "codex", "explicit-session");
    const input = { ...subject(root, state), coordination_finalized: true };

    expect(endSessionExplicitV3(input)).toEqual(WAITING);
    expect(requestSessionEndExplicitV3(input)).toEqual(WAITING);
    expect(eventTypes(root)).not.toContain("session.ended");

    admitWaitingSubjectRowsV3(root, rows);
    expect(requestSessionEndExplicitV3(input).state).toBe("recorded");
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
  });

  test("a queued explicit end skips salvage while rows wait and still expires", () => {
    const { root, state } = seeded("queued");
    hook(root, "queued", "user-prompt-submit");
    const input = { ...subject(root, state), coordination_finalized: true };
    expect(requestSessionEndExplicitV3(input).state).toBe("queued");
    hook(root, "queued", "stop");
    const rows = queueWaitingSubjectRowsV3(root, "codex", "queued-session");

    const held = reconcileSessionFinalizationV3(root, { archive_observations: [] });
    expect(held).toMatchObject({ finalized: 0, pending: 1 });
    expect(eventTypes(root)).not.toContain("session.ended");

    const expired = reconcileSessionFinalizationV3(root, {
      now: new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000),
      archive_observations: [],
    });
    expect(expired.cancelled).toBe(1);
    expect(listSessionFinalizationRequestsV3(root)[0]?.status).toBe("cancelled");

    admitWaitingSubjectRowsV3(root, rows);
    expect(requestSessionEndExplicitV3(input).state).toBe("recorded");
  });
});

function seeded(label: string) {
  const root = mkdtempSync(join(tmpdir(), "harnery-finalizer-waiting-"));
  roots.push(root);
  initializeV3Fixture(root);
  seedV3Session(root, label, { sessionId: `${label}-session`, adapter: "codex" });
  const state = readHookProducerStateV3(root, "codex", `${label}-session`);
  if (!state) throw new Error("producer state missing");
  return { root, state };
}

function subject(
  root: string,
  state: { instance_id: `inst_${string}`; generation_id: `gen_${string}` },
) {
  return { coordRoot: root, instance_id: state.instance_id, generation_id: state.generation_id };
}

function hook(root: string, label: string, eventName: "user-prompt-submit" | "stop"): void {
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error(`fixture_v3_route:${route.reason}`);
  const result = recordLiveHookSignalV3({
    coordRoot: root,
    route,
    eventName,
    adapter: "codex",
    instanceId: label,
    payload: { session_id: `${label}-session`, raw: {} },
  });
  if (result.state !== "recorded") throw new Error(`fixture_hook:${eventName}:${result.state}`);
}

function ledgerIds(root: string): string[] {
  return readLedgerV3(root).events.map(({ event }) => event.event_id);
}

function eventTypes(root: string): string[] {
  return readLedgerV3(root).events.map(({ event }) => event.event_type);
}
