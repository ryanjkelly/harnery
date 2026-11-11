import { canonicalClaimPath } from "../../src/core/agents/claim-path.ts";
import {
  asEventV3,
  ReplayEventsV3,
  type ReplaySessionV3,
} from "../../src/core/events/v3/__fixtures__/ledger-replay.ts";
import type { EventAdapterIdV3 } from "../../src/core/events/v3/adapter-id.ts";
import { readEventV3ControlState } from "../../src/core/events/v3/control.ts";
import { fingerprintContextV3 } from "../../src/core/events/v3/fingerprint-keys.ts";
import {
  type HookProducerStateV3,
  readHookProducerStateV3,
} from "../../src/core/events/v3/producers/recorder.ts";
import { describePathTargetV3 } from "../../src/core/events/v3/targets.ts";
import { writeEventV3 } from "../../src/core/events/v3/writer.ts";
import { type EventV3Fixture, fixtureObject } from "./event-v3.ts";

// One builder per test process keeps event IDs unique across calls.
const events = new ReplayEventsV3();
let nextProducer = 1;

export interface WaitingSubjectRowsV3 {
  generation_id: `gen_${string}`;
  /** The queued row the door holds: sequence 2 of a fresh producer. */
  waiting: EventV3Fixture;
  /** Sequence 1 of that producer; writing it lets the door admit both. */
  missing: EventV3Fixture;
}

/**
 * Queue a row in a live session's generation that the ledger door holds with
 * `producer_sequence_gap`. The row is a `coord.status_observed`, which changes
 * no projected coordination state, so admitting it later leaves the view as
 * the test's own producers shaped it. Call `admitWaitingSubjectRowsV3` to
 * write the missing predecessor.
 */
export function queueWaitingSubjectRowsV3(
  root: string,
  adapter: EventAdapterIdV3,
  nativeSessionId: string,
): WaitingSubjectRowsV3 {
  const { hook, session } = waitingProducer(root, adapter, nativeSessionId);
  const causedBy = [hook.last_event_id!];
  const missing = events.event(session, "coord.status_observed", { caused_by: causedBy });
  const waiting = events.event(session, "coord.status_observed", { caused_by: causedBy });
  return queue(root, hook, waiting, missing);
}

/**
 * Queue the session's own write-claim acquisition of `path` behind a skipped
 * producer sequence, with the target fingerprinted as the coordination
 * producer fingerprints it. Admitting the rows makes the claim held.
 */
export function queueWaitingSubjectClaimV3(
  root: string,
  adapter: EventAdapterIdV3,
  nativeSessionId: string,
  path: string,
): WaitingSubjectRowsV3 & { acquisition_id: `evt_${string}` } {
  const { hook, session } = waitingProducer(root, adapter, nativeSessionId);
  const control = readEventV3ControlState(root);
  if (control.state !== "active" && control.state !== "candidate") {
    throw new Error(`fixture_control:${control.state}`);
  }
  const target = describePathTargetV3({
    coordRoot: root,
    value: canonicalClaimPath(root, path),
    access: "write",
    fingerprintContext: fingerprintContextV3(
      root,
      control.genesis.event.scope.root_id as `root_${string}`,
      hook.generation_id,
      hook.privacy_epoch_id,
    ),
    extractorVersion: "agent-coord-claim-v3",
  });
  const causedBy = [hook.last_event_id!];
  const missing = events.event(session, "coord.status_observed", { caused_by: causedBy });
  const waiting = events.claim(session, "acquired", {
    caused_by: causedBy,
    mutate: (event) => {
      fixtureObject(event.payload).target = target;
      const attribution = fixtureObject(fixtureObject(event.provenance).attribution);
      attribution.state = "verified";
      attribution.subject_instance_id = hook.instance_id;
    },
  });
  return {
    ...queue(root, hook, waiting, missing),
    acquisition_id: waiting.event_id as `evt_${string}`,
  };
}

function waitingProducer(root: string, adapter: EventAdapterIdV3, nativeSessionId: string) {
  const hook = readHookProducerStateV3(root, adapter, nativeSessionId);
  if (!hook?.last_event_id) throw new Error(`fixture_hook_state:${nativeSessionId}`);
  const index = nextProducer++;
  const hex = String(index).padStart(12, "0");
  const session: ReplaySessionV3 = {
    label: `waiting-${index}`,
    instance_id: hook.instance_id,
    session_id: hook.session_id,
    generation_id: hook.generation_id,
    attestation_id: hook.attestation_id,
    producer_id: `prd_fixture-waiting-${index}`,
    boot_id: `boot_fixture-waiting-${index}`,
    clock_id: `clk_00000000-0000-7000-8009-${hex}`,
    next_sequence: 1,
    next_ms: Date.now() - 60_000,
  };
  return { hook, session };
}

function queue(
  root: string,
  hook: HookProducerStateV3,
  waiting: EventV3Fixture,
  missing: EventV3Fixture,
): WaitingSubjectRowsV3 {
  const result = writeEventV3(root, asEventV3(waiting));
  if (result.state !== "waiting") throw new Error(`fixture_waiting_row:${result.state}`);
  return { generation_id: hook.generation_id, waiting, missing };
}

/** Write the missing predecessor so the door admits the waiting row. */
export function admitWaitingSubjectRowsV3(root: string, rows: WaitingSubjectRowsV3): void {
  const result = writeEventV3(root, asEventV3(rows.missing));
  if (result.state !== "committed") throw new Error(`fixture_admit_row:${result.state}`);
}
