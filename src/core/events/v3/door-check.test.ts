import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { EventV3Fixture } from "../../../../tests/helpers/event-v3.ts";
import { initializeV3Fixture, seedV3Session } from "../../../../tests/helpers/event-v3-runtime.ts";
import {
  admitWaitingSubjectRowsV3,
  queueWaitingSubjectClaimV3,
} from "../../../../tests/helpers/event-v3-waiting.ts";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import { releaseClaimOnBehalfV3 } from "../../agents/claim-release-v3.ts";
import { collectEventQueueHealthV3, waitingEventsNoticeV3 } from "../../agents/health.ts";
import { staleSweep } from "../../agents/state/stale-sweep.ts";
import {
  asEventV3,
  causalCycleScenarioV3,
  clockRegressionScenarioV3,
  framesV3,
  genesisForDigestV3,
  initializeReplayLedgerV3,
  latePredecessorScenarioV3,
  plantCommittedReceiptV3,
  plantReadyRowV3,
  plantUnreadableSpoolFileV3,
  ReplayEventsV3,
  replayRootV3,
  sequenceGapScenarioV3,
  spoolNamesV3,
  UNKNOWN_SCHEMA_DIGEST_V3,
  unknownDigestQueuedRowV3,
  waitingClaimSweepScenarioV3,
} from "./__fixtures__/ledger-replay.ts";
import { rotateOversizedEventLedgerV3 } from "./bootstrap.ts";
import { canonicalJsonV3 } from "./canonical.ts";
import type { EventV3 } from "./contract.ts";
import { type EventV3ControlState, readEventV3ControlState } from "./control.ts";
import {
  publishActiveControlWitnessV3,
  readAdvanceableControlWitnessV3,
} from "./control-witness.ts";
import { readCoordinationViewV3 } from "./coordination-view.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import {
  eventV3AuthorityStorageVersionV3,
  eventV3ControlCheckpointPathV3,
  eventV3ControlWitnessPathV3,
  type LedgerFrameV3,
  readEventV3AppendValidationCheckpointV3,
  readLedgerFramesV3,
  readLedgerV3,
} from "./reader.ts";
import {
  createRowValidationStateV3,
  rowValidationStateFromCheckpointV3,
} from "./row-validation.ts";
import { acceptedSchemaDigestsV3 } from "./schema-lineage.ts";
import {
  admitReadyRowsV3,
  drainReadyEventsV3,
  eventV3Paths,
  generationHasWaitingRowsV3,
  inspectEventV3QueueV3,
  writeEventV3,
} from "./writer.ts";

type ClaimChangedV3 = Extract<EventV3, { event_type: "coord.claim_changed" }>;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

describe("event ledger V3 door check: a bad row stops only its own session (b)", () => {
  test("a sequence gap in X's queued rows leaves the ledger with no reader diagnostic", () => {
    const root = initializedRoot();
    const scenario = sequenceGapScenarioV3();
    for (const event of scenario.committed) {
      expect(writeEventV3(root, asEventV3(event)).state).toBe("committed");
    }
    expect(writeEventV3(root, asEventV3(scenario.x_waiting), { deferDrain: true }).state).toBe(
      "ready",
    );
    expect(writeEventV3(root, asEventV3(scenario.y_task)).state).toBe("committed");

    const read = readLedgerV3(root);
    expect(read).toMatchObject({ complete: true, diagnostics: [] });
    expect(read.events.map(({ event }) => event.event_id)).toContain(
      scenario.y_task.event_id as string,
    );
    expect(read.events.map(({ event }) => event.event_id)).not.toContain(
      scenario.x_waiting.event_id as string,
    );
    expect(readyIds(root)).toEqual([scenario.x_waiting.event_id as string]);
    expect(readEventV3ControlState(root).state).toBe("active");
  });

  test("the waiting-claim fixture has a sweeper release the claim X still has queued", () => {
    const scenario = waitingClaimSweepScenarioV3();
    const acquisition = scenario.x_claim_waiting.payload as Record<string, unknown>;
    const release = scenario.sweep_release.payload as Record<string, unknown>;
    expect(acquisition).toMatchObject({
      operation: "acquired",
      subject_instance_id: scenario.x.instance_id,
    });
    expect(release).toMatchObject({
      operation: "released",
      actor_instance_id: scenario.sweeper.instance_id,
      subject_instance_id: scenario.x.instance_id,
    });
    expect((scenario.sweep_release.links as { caused_by: string[] }).caused_by).toEqual([
      scenario.x_claim_waiting.event_id as string,
    ]);
    // X skipped one producer sequence before both of its waiting rows.
    const sequence = (event: Record<string, unknown>) =>
      (event.producer as { sequence: number }).sequence;
    expect(sequence(scenario.x_waiting)).toBe(sequence(scenario.x_missing) + 1);
    expect(sequence(scenario.x_claim_waiting)).toBe(sequence(scenario.x_waiting) + 1);
  });

  test("writeEventV3 returns waiting with reason producer_sequence_gap for X's row", () => {
    const root = initializedRoot();
    const scenario = sequenceGapScenarioV3();
    for (const event of scenario.committed) writeEventV3(root, asEventV3(event));
    const result = writeEventV3(root, asEventV3(scenario.x_waiting));
    expect(result).toMatchObject({
      state: "waiting",
      reason: "producer_sequence_gap",
      event_id: scenario.x_waiting.event_id as string,
    });
    expect(existsSync(result.ready_path!)).toBe(true);
  });
  test("Y's set-task and claim rows are appended while X's rows wait", () => {
    const root = initializedRoot();
    const scenario = sequenceGapScenarioV3();
    const { events, y } = scenario;
    for (const event of scenario.committed) writeEventV3(root, asEventV3(event));
    expect(writeEventV3(root, asEventV3(scenario.x_waiting)).state).toBe("waiting");
    const yRows = [
      scenario.y_task,
      events.claim(y, "acquired", { caused_by: [scenario.y_task.event_id as string] }),
    ];
    yRows.push(events.claim(y, "released", { caused_by: [yRows[1]!.event_id as string] }));
    for (const row of yRows) expect(writeEventV3(root, asEventV3(row)).state).toBe("committed");

    const read = readLedgerV3(root);
    expect(read).toMatchObject({ complete: true, diagnostics: [] });
    const ids = read.events.map(({ event }) => event.event_id);
    for (const row of yRows) expect(ids).toContain(row.event_id as string);
    expect(readyIds(root)).toEqual([scenario.x_waiting.event_id as string]);
    expect(readEventV3ControlState(root).state).toBe("active");
  });
  test("X's waiting rows stay in the archived queue, and X records again after a rotation", () => {
    const root = initializedRoot();
    const scenario = sequenceGapScenarioV3();
    for (const event of scenario.committed) writeEventV3(root, asEventV3(event));
    const waiting = writeEventV3(root, asEventV3(scenario.x_waiting));
    expect(waiting.state).toBe("waiting");
    const waitingName = basename(waiting.ready_path!);
    const waitingBytes = readFileSync(waiting.ready_path!, "utf8");
    // A file the drain sets aside and a newer runtime's row ride along untouched.
    const unreadable = plantUnreadableSpoolFileV3(spool(root), "ready");
    const unknown = plantReadyRowV3(
      spool(root),
      unknownDigestQueuedRowV3(scenario.events, scenario.events.session("newer-runtime")),
    );
    const unknownBytes = readFileSync(unknown, "utf8");
    // Y's admissible row drains before the cutover and is carried as usual.
    expect(writeEventV3(root, asEventV3(scenario.y_task)).state).toBe("committed");
    const asideName = `${basename(unreadable)}.set-aside`;
    const asideBytes = readFileSync(join(spool(root), asideName), "utf8");

    const rotated = rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 });
    expect(rotated.state).toBe("rotated");
    // The archive keeps every file it could not carry, byte for byte.
    const archivedSpool = join(rotated.archived_epoch!, "spool");
    expect(readdirSync(archivedSpool)).toEqual(
      expect.arrayContaining([waitingName, basename(unknown), asideName, `${asideName}.json`]),
    );
    expect(readFileSync(join(archivedSpool, waitingName), "utf8")).toBe(waitingBytes);
    expect(readFileSync(join(archivedSpool, basename(unknown)), "utf8")).toBe(unknownBytes);
    expect(readFileSync(join(archivedSpool, asideName), "utf8")).toBe(asideBytes);
    expect(readFileSync(join(rotated.archived_epoch!, "active.ndjson"), "utf8")).not.toContain(
      scenario.x_waiting.event_id as string,
    );
    expect(readyIds(root)).toEqual([]);
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });

    // In the new epoch X's producer starts again at sequence 1, and its rows are admitted.
    const start = scenario.events.start(scenario.x, { sequence: 1 });
    expect(writeEventV3(root, asEventV3(start)).state).toBe("committed");
    expect(
      writeEventV3(
        root,
        asEventV3(
          scenario.events.event(scenario.x, "coord.task_changed", {
            sequence: 2,
            caused_by: [start.event_id as string],
          }),
        ),
      ).state,
    ).toBe("committed");
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
    expect(readEventV3ControlState(root).state).toBe("active");
  });
  test("agents health names X's generation, the reason, the first waiting sequence and its age", () => {
    const root = initializedRoot();
    const scenario = sequenceGapScenarioV3();
    for (const event of scenario.committed) writeEventV3(root, asEventV3(event));
    writeEventV3(root, asEventV3(scenario.x_waiting));
    plantUnreadableSpoolFileV3(spool(root), "ready");
    writeEventV3(root, asEventV3(scenario.y_task));
    const xSequence = (scenario.x_waiting.producer as { sequence: number }).sequence;

    const health = collectEventQueueHealthV3(root, Date.now() + 60_000);
    expect(health).toMatchObject({
      waiting_total: 1,
      set_aside_total: 1,
      waiting: [
        {
          generation_id: scenario.x.generation_id,
          instance_id: scenario.x.instance_id,
          reason: "producer_sequence_gap",
          count: 1,
          first_waiting_sequence: xSequence,
        },
      ],
      set_aside: [{ reason: "malformed_json", count: 1 }],
    });
    expect(health.waiting[0]!.oldest_age_ms).toBeGreaterThanOrEqual(59_000);

    const notice = waitingEventsNoticeV3(root, scenario.x.generation_id, "harn");
    expect(notice).toContain(scenario.x.generation_id);
    expect(notice).toContain("producer_sequence_gap");
    expect(notice).toContain(`producer sequence ${xSequence}`);
    expect(notice).toContain("Start a new session, or wait for the next epoch rotation");
    expect(notice).toContain("`harn agents health`");
    expect(waitingEventsNoticeV3(root, scenario.y.generation_id, "harn")).toBeUndefined();
  });
  test("a stale sweep emits no release for X's generation while X's claim acquisition waits, and retries once it has none", () => {
    const root = replayRootV3("harnery-v3-door-check-producers-");
    roots.push(root);
    initializeV3Fixture(root);
    seedV3Session(root, "lead", { name: "Lead" });
    seedV3Session(root, "x", { name: "Xavier" });
    const rows = queueWaitingSubjectClaimV3(root, "codex", "x", "docs/held.md");
    // X's producer applied its claim to the disposable cache after the row was
    // durably queued; its heartbeat has since gone stale.
    const heartbeat = join(root, ".harnery", "active", "x.json");
    const stale = (files: string[]) =>
      writeFileSync(
        heartbeat,
        JSON.stringify({
          ...JSON.parse(readFileSync(heartbeat, "utf8")),
          files_touched: files,
          last_heartbeat: "2020-01-01T00:00:00.000Z",
        }),
      );
    stale(["docs/held.md"]);
    const groupRelease = () =>
      releaseClaimOnBehalfV3({
        coordRoot: root,
        owner: "lead",
        subject: "x",
        nativeSessionId: "lead",
        adapter: "codex",
        path: "docs/held.md",
      });
    const types = () => readLedgerV3(root).events.map(({ event }) => event.event_type);
    const releases = () =>
      readLedgerV3(root)
        .events.map(({ event }) => event)
        .filter(
          (event): event is ClaimChangedV3 =>
            event.event_type === "coord.claim_changed" && event.payload.operation === "released",
        );

    expect(staleSweep(root).heartbeatsRemoved).toEqual([]);
    expect(existsSync(heartbeat)).toBe(true);
    expect(groupRelease()).toEqual({ state: "skipped", reason: "generation_rows_waiting" });
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
    expect(readCoordinationViewV3(root).global_diagnostics).toEqual([]);
    expect(projectionCodes(root)).toEqual([]);
    expect(types()).not.toContain("lifecycle.sweep_observed");
    expect(releases()).toEqual([]);

    admitWaitingSubjectRowsV3(root, rows);
    expect(readCoordinationViewV3(root).instances.inst_x?.files_touched).toEqual(["docs/held.md"]);
    expect(groupRelease()).toMatchObject({
      state: "released",
      acquired_event_id: rows.acquisition_id,
    });
    expect((releases().at(-1)?.links as { caused_by: string[] }).caused_by).toContain(
      rows.acquisition_id,
    );
    // The release rewrote X's cache; X is still gone, so age it again.
    stale([]);
    expect(staleSweep(root).heartbeatsRemoved).toEqual(["x.json"]);
    expect(types()).toContain("lifecycle.sweep_observed");
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
    expect(readCoordinationViewV3(root).global_diagnostics).toEqual([]);
    expect(projectionCodes(root)).not.toContain("claim_release_without_acquire");
  });
  test("a release citing X's waiting claim acquisition waits with it, and both land in order", () => {
    const root = initializedRoot();
    const events = new ReplayEventsV3();
    const base = sequenceGapScenarioV3(events);
    const xClaim = events.claim(base.x, "acquired", {
      caused_by: [base.committed[0]!.event_id as string],
    });
    const sweeper = events.session("sweeper");
    const sweeperStart = events.start(sweeper);
    const release = events.claim(sweeper, "released", {
      subject: base.x,
      caused_by: [xClaim.event_id as string],
    });
    for (const event of [...base.committed, sweeperStart]) {
      expect(writeEventV3(root, asEventV3(event)).state).toBe("committed");
    }
    const projectionBefore = projectionCodes(root);
    expect(writeEventV3(root, asEventV3(base.x_waiting)).state).toBe("waiting");
    expect(writeEventV3(root, asEventV3(xClaim)).state).toBe("waiting");
    expect(writeEventV3(root, asEventV3(release))).toMatchObject({
      state: "waiting",
      reason: "causal_parent_missing",
    });
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
    expect(projectionCodes(root)).toEqual(projectionBefore);

    expect(writeEventV3(root, asEventV3(base.x_missing)).state).toBe("committed");
    const read = readLedgerV3(root);
    expect(read).toMatchObject({ complete: true, diagnostics: [] });
    const ids = read.events.map(({ event }) => event.event_id);
    expect(ids.slice(-4)).toEqual(
      [base.x_missing, base.x_waiting, xClaim, release].map((event) => event.event_id as string),
    );
    expect(readyIds(root)).toEqual([]);
    expect(projectionCodes(root)).not.toContain("claim_release_without_acquire");
  });
});

describe("event ledger V3 door check: producers acting on another generation", () => {
  test("generationHasWaitingRowsV3 drains first, then reports only generations with rows left", () => {
    const root = initializedRoot();
    const scenario = sequenceGapScenarioV3();
    for (const event of scenario.committed) writeEventV3(root, asEventV3(event));
    writeEventV3(root, asEventV3(scenario.x_waiting), { deferDrain: true });
    // Y's admissible row is still queued; the predicate's own drain appends it.
    writeEventV3(root, asEventV3(scenario.y_task), { deferDrain: true });
    expect(readyIds(root)).toHaveLength(2);

    expect(generationHasWaitingRowsV3(root, scenario.y.generation_id)).toBe(false);
    expect(readyIds(root)).toEqual([scenario.x_waiting.event_id as string]);
    expect(generationHasWaitingRowsV3(root, scenario.x.generation_id)).toBe(true);

    writeEventV3(root, asEventV3(scenario.x_missing));
    expect(generationHasWaitingRowsV3(root, scenario.x.generation_id)).toBe(false);
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
  });

  test("generationHasWaitingRowsV3 is false for a root without a ledger queue", () => {
    const root = replayRootV3("harnery-v3-door-check-empty-");
    roots.push(root);
    expect(generationHasWaitingRowsV3(root, "gen_00000000-0000-7000-8001-000000000001")).toBe(
      false,
    );
  });
});

describe("event ledger V3 door check: rows the reader would reject (c)", () => {
  test("an unmarked clock regression waits in the queue and the ledger stays valid", () => {
    const root = initializedRoot();
    const scenario = clockRegressionScenarioV3();
    expect(writeEventV3(root, asEventV3(scenario.start)).state).toBe("committed");
    writeEventV3(root, asEventV3(scenario.clock_regressed));
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
    expect(readyIds(root)).toEqual([scenario.clock_regressed.event_id as string]);
  });

  test("a row whose producer predecessor arrives late waits, then both are admitted in producer order", () => {
    const root = initializedRoot();
    const scenario = latePredecessorScenarioV3();
    expect(writeEventV3(root, asEventV3(scenario.start)).state).toBe("committed");
    writeEventV3(root, asEventV3(scenario.successor));
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
    expect(readyIds(root)).toEqual([scenario.successor.event_id as string]);

    expect(writeEventV3(root, asEventV3(scenario.predecessor)).state).toBe("committed");
    const read = readLedgerV3(root);
    expect(read).toMatchObject({ complete: true, diagnostics: [] });
    const ids = read.events.map(({ event }) => event.event_id);
    expect(ids.slice(-2)).toEqual([
      scenario.predecessor.event_id as string,
      scenario.successor.event_id as string,
    ]);
    expect(readyIds(root)).toEqual([]);
  });

  test("a replayed row whose ID is already committed passes and leaves the ledger valid", () => {
    // Crash replay: a receipt left behind after the append. This must keep passing.
    const root = initializedRoot();
    const scenario = latePredecessorScenarioV3();
    expect(writeEventV3(root, asEventV3(scenario.start)).state).toBe("committed");
    plantCommittedReceiptV3(spool(root), scenario.start);
    expect(drainReadyEventsV3(root)).toBe(1);
    const read = readLedgerV3(root);
    expect(read.complete).toBe(true);
    expect(
      read.events.filter(({ event }) => event.event_id === scenario.start.event_id),
    ).toHaveLength(1);
    expect(spoolNamesV3(spool(root), ".committed")).toEqual([]);
  });

  test("a causal cycle waits in the queue while the admissible row beside it is appended", () => {
    const root = initializedRoot();
    const scenario = causalCycleScenarioV3();
    for (const event of [...scenario.cycle, scenario.admissible])
      plantReadyRowV3(spool(root), event);
    expect(drainReadyEventsV3(root)).toBe(1);
    const read = readLedgerV3(root);
    expect(read).toMatchObject({ complete: true, diagnostics: [] });
    expect(read.events.map(({ event }) => event.event_id)).toContain(
      scenario.admissible.event_id as string,
    );
    expect(readyIds(root).sort()).toEqual(
      scenario.cycle.map((event) => event.event_id as string).sort(),
    );
  });

  test("an unreadable queued file is set aside and reported, other rows are appended, and nothing is deleted", () => {
    const root = initializedRoot();
    const scenario = latePredecessorScenarioV3();
    const unreadable = plantUnreadableSpoolFileV3(spool(root), "ready");
    const bytes = readFileSync(unreadable, "utf8");
    expect(writeEventV3(root, asEventV3(scenario.start)).state).toBe("committed");
    expect(existsSync(unreadable)).toBe(false);
    const aside = setAsideNames(root);
    expect(aside).toEqual([`${basename(unreadable)}.set-aside`]);
    expect(readFileSync(join(spool(root), aside[0]!), "utf8")).toBe(bytes);
    expect(setAsideReason(root, aside[0]!)).toBe("malformed_json");
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
    expect(readyIds(root)).toEqual([]);
  });

  test("an unreadable committed receipt is set aside and reported without stopping the drain", () => {
    const root = initializedRoot();
    const scenario = latePredecessorScenarioV3();
    const unreadable = plantUnreadableSpoolFileV3(spool(root), "committed");
    expect(writeEventV3(root, asEventV3(scenario.start)).state).toBe("committed");
    expect(existsSync(unreadable)).toBe(false);
    const aside = setAsideNames(root);
    expect(aside).toEqual([`${basename(unreadable)}.set-aside`]);
    expect(setAsideReason(root, aside[0]!)).toBe("malformed_json");
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
  });

  test("writeEventV3 returns set_aside with a reason for a file that can never be appended", () => {
    const root = initializedRoot();
    const scenario = latePredecessorScenarioV3();
    const result = writeEventV3(root, asEventV3(scenario.start), {
      // Damage the published file before the drain reads it.
      onStep: (step) => {
        if (step !== "ready_published") return;
        const [name] = spoolNamesV3(spool(root), ".ready");
        writeFileSync(join(spool(root), name!), "{damaged\n");
      },
    });
    expect(result).toMatchObject({ state: "set_aside", reason: "malformed_json" });
    expect(setAsideNames(root)).toHaveLength(1);
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
  });

  test("a replayed committed receipt beside a waiting row still drains", () => {
    const root = initializedRoot();
    const scenario = latePredecessorScenarioV3();
    expect(writeEventV3(root, asEventV3(scenario.start)).state).toBe("committed");
    plantCommittedReceiptV3(spool(root), scenario.start);
    plantReadyRowV3(spool(root), scenario.successor);
    expect(drainReadyEventsV3(root)).toBe(1);
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
    expect(readyIds(root)).toEqual([scenario.successor.event_id as string]);
  });
});

describe("event ledger V3 door check: admission state", () => {
  test("a held row never mutates the admission state", () => {
    const root = initializedRoot();
    const scenario = sequenceGapScenarioV3();
    for (const event of scenario.committed) writeEventV3(root, asEventV3(event));
    const checkpoint = readEventV3AppendValidationCheckpointV3(root)!;
    const state = rowValidationStateFromCheckpointV3(checkpoint);
    const before = rowValidationStateFromCheckpointV3(checkpoint);
    const admission = admitReadyRowsV3(state, [queuedRow(scenario.x_waiting)]);
    expect(admission.admitted).toEqual([]);
    expect(admission.waiting.map(({ codes }) => codes)).toEqual([["producer_sequence_gap"]]);
    expect(state).toEqual(before);
  });

  test("a queued row with an unknown digest is untouched and reported as epoch_schema_unknown", () => {
    const root = initializedRoot();
    const events = new ReplayEventsV3();
    const session = events.session("newer-runtime");
    writeEventV3(root, asEventV3(events.start(session)));
    const planted = plantReadyRowV3(spool(root), unknownDigestQueuedRowV3(events, session));
    const bytes = readFileSync(planted, "utf8");
    expect(drainReadyEventsV3(root)).toBe(0);
    expect(readFileSync(planted, "utf8")).toBe(bytes);
    expect(inspectEventV3QueueV3(root).waiting).toEqual([
      expect.objectContaining({ name: basename(planted), reason: "epoch_schema_unknown" }),
    ]);
    expect(setAsideNames(root)).toEqual([]);
  });

  test("every row of a ledger the reader accepts is admitted in its recorded order", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const frames = acceptedLedgerFrames(seed);
      const read = readLedgerFramesV3(frames);
      expect(read.diagnostics).toEqual([]);
      const state = createRowValidationStateV3(acceptedSchemaDigestsV3());
      for (const frame of frames) {
        const event = JSON.parse(frame.raw) as EventV3;
        if (event.event_type === "ledger.genesis") {
          // The door accepts every digest of the runtime's group, the genesis digest included.
          expect(
            state.accepted.has(
              (event.payload as { generated_schema_digest: string }).generated_schema_digest,
            ),
          ).toBe(true);
        }
        const admission = admitReadyRowsV3(state, [
          { readyName: event.event_id, readyPath: "", row: `${frame.raw}\n`, event },
        ]);
        expect({ seed, event_id: event.event_id, waiting: admission.waiting.length }).toEqual({
          seed,
          event_id: event.event_id,
          waiting: 0,
        });
      }
    }
  });
});

describe("event ledger V3 door check: where the admission state comes from", () => {
  const sources = ["witness", "canonical read", "version 1 checkpoint"] as const;
  for (const source of sources) {
    test(`the drain, the waiting predicate and health agree from a ${source}`, () => {
      const root = initializedRoot();
      const scenario = sequenceGapScenarioV3();
      for (const event of scenario.committed) {
        expect(writeEventV3(root, asEventV3(event)).state).toBe("committed");
      }
      activeControl(root);
      expect(readAdvanceableControlWitnessV3(root)?.checkpoint.format_version).toBe(2);
      if (source === "canonical read") {
        rmSync(eventV3ControlWitnessPathV3(root));
        rmSync(eventV3ControlCheckpointPathV3(root));
      } else if (source === "version 1 checkpoint") {
        // An older runtime's checkpoint, with the accepted list it used to record.
        const path = eventV3ControlCheckpointPathV3(root);
        const checkpoint = JSON.parse(readFileSync(path, "utf8"));
        checkpoint.format_version = 1;
        checkpoint.accepted_schema_digests = checkpoint.schema_digests;
        delete checkpoint.schema_digests;
        writeFileSync(path, `${canonicalJsonV3(checkpoint)}\n`);
      }
      if (source !== "witness") expect(readAdvanceableControlWitnessV3(root)).toBeUndefined();

      expect(writeEventV3(root, asEventV3(scenario.x_waiting))).toMatchObject({
        state: "waiting",
        reason: "producer_sequence_gap",
      });
      expect(generationHasWaitingRowsV3(root, scenario.x.generation_id)).toBe(true);
      expect(generationHasWaitingRowsV3(root, scenario.y.generation_id)).toBe(false);
      expect(collectEventQueueHealthV3(root, Date.now())).toMatchObject({
        waiting_total: 1,
        waiting: [{ generation_id: scenario.x.generation_id, reason: "producer_sequence_gap" }],
      });
      expect(writeEventV3(root, asEventV3(scenario.y_task)).state).toBe("committed");
      expect(writeEventV3(root, asEventV3(scenario.x_missing)).state).toBe("committed");
      expect(readyIds(root)).toEqual([]);
      expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
    });
  }

  test("a witness listing a digest outside the runtime's group admits nothing", () => {
    const root = initializedRoot();
    const events = new ReplayEventsV3();
    const control = activeControl(root);
    const checkpoint = readEventV3AppendValidationCheckpointV3(root)!;
    const listed = {
      ...checkpoint,
      schema_digests: [...checkpoint.schema_digests, UNKNOWN_SCHEMA_DIGEST_V3].sort(),
    };
    expect(
      publishActiveControlWitnessV3(root, control, eventV3AuthorityStorageVersionV3(root), listed),
    ).toBe(true);
    const activeBefore = readFileSync(eventV3Paths(root).active);
    const session = events.session("late-writer");
    expect(writeEventV3(root, asEventV3(events.start(session)))).toMatchObject({
      state: "waiting",
      reason: "epoch_schema_unknown",
    });
    expect(readFileSync(eventV3Paths(root).active).equals(activeBefore)).toBe(true);
    expect(collectEventQueueHealthV3(root, Date.now()).waiting).toEqual([
      expect.objectContaining({
        generation_id: session.generation_id,
        reason: "epoch_schema_unknown",
      }),
    ]);
  });
});

/** A synthetic ledger the reader accepts: interleaved sessions, cross-session causes. */
function acceptedLedgerFrames(seed: number): LedgerFrameV3[] {
  let value = seed * 2_654_435_761;
  const random = (limit: number) => {
    value = (value * 1_103_515_245 + 12_345) % 2_147_483_648;
    return value % limit;
  };
  const events = new ReplayEventsV3();
  const sessions = Array.from({ length: 2 + random(3) }, (_, index) =>
    events.session(`p${seed}-${index}`),
  );
  const rows: EventV3Fixture[] = [genesisForDigestV3(EVENT_V3_SCHEMA_DIGEST)];
  const started = new Set<number>();
  const committedIds: string[] = [];
  for (let step = 0; step < 20; step++) {
    const index = random(sessions.length);
    const session = sessions[index]!;
    let row: EventV3Fixture;
    if (!started.has(index)) {
      row = events.start(session);
      started.add(index);
    } else {
      const causes = committedIds.length ? [committedIds[random(committedIds.length)]!] : [];
      row =
        random(2) === 0
          ? events.event(session, "coord.task_changed", { caused_by: causes })
          : events.claim(session, random(2) === 0 ? "acquired" : "released", {
              caused_by: causes,
            });
    }
    rows.push(row);
    committedIds.push(row.event_id as string);
  }
  return framesV3(rows);
}

function queuedRow(event: EventV3Fixture) {
  const raw = canonicalJsonV3(event);
  return {
    readyName: String(event.event_id),
    readyPath: "",
    row: `${raw}\n`,
    event: asEventV3(event),
  };
}

function projectionCodes(root: string): string[] {
  const view = readCoordinationViewV3(root);
  return [...view.global_diagnostics, ...Object.values(view.diagnostics_by_generation).flat()].map(
    ({ code }) => code,
  );
}

function activeControl(root: string): Extract<EventV3ControlState, { state: "active" }> {
  const control = readEventV3ControlState(root);
  if (control.state !== "active") throw new Error(`expected active control, got ${control.state}`);
  return control;
}

function initializedRoot(): string {
  const root = replayRootV3("harnery-v3-door-check-");
  roots.push(root);
  initializeReplayLedgerV3(root);
  return root;
}

/** Names of files the drain set aside, without their reason sidecars. */
function setAsideNames(root: string): string[] {
  return readdirSync(spool(root))
    .filter((name) => name.endsWith(".set-aside"))
    .sort();
}

function setAsideReason(root: string, name: string): string {
  return JSON.parse(readFileSync(join(spool(root), `${name}.json`), "utf8")).reason;
}

/** Event IDs of the rows still queued as `.ready`, in queue order. */
function readyIds(root: string): string[] {
  return spoolNamesV3(spool(root), ".ready").map(
    (name) => name.match(/^\d{16}-(evt_[0-9a-f-]{36})-/)?.[1] ?? name,
  );
}

function spool(root: string): string {
  return eventV3Paths(root).spool;
}
