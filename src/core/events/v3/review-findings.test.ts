import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import { initEventLedgerV3Replacement } from "../../../commands/init.ts";
import {
  adjacentAdditiveDigestsV3,
  asEventV3,
  initializeReplayLedgerV3,
  latePredecessorScenarioV3,
  plantCommittedReceiptV3,
  priorBreakingDigestV3,
  ReplayEventsV3,
  replayRootV3,
  sequenceGapScenarioV3,
  spoolNamesV3,
  UNKNOWN_SCHEMA_DIGEST_V3,
  unknownDigestQueuedRowV3,
} from "./__fixtures__/ledger-replay.ts";
import { eventV3ArchivesRoot } from "./archive-retention.ts";
import {
  initializeEventLedgerV3,
  refreshIncompatibleEventLedgerV3,
  rotateOversizedEventLedgerV3,
} from "./bootstrap.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import {
  candidateManifestDigestV3,
  candidateProfileDigestV3,
  EVENT_V3_ACTIVATION_MANIFEST,
  EVENT_V3_GENESIS_MANIFEST,
  readEventV3ControlState,
} from "./control.ts";
import { readAdvanceableControlWitnessV3 } from "./control-witness.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { resolveLiveEventLedgerRouteV3 } from "./live-routing.ts";
import {
  eventV3ControlCheckpointPathV3,
  eventV3ControlWitnessPathV3,
  readLedgerV3,
} from "./reader.ts";
import { drainReadyEventsV3, eventV3Paths, writeEventV3 } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

function initializedRoot(): string {
  const root = replayRootV3("harnery-v3-review-findings-");
  roots.push(root);
  initializeReplayLedgerV3(root);
  return root;
}

describe("F1: a queued row under a committed event ID is compared byte for byte", () => {
  test("F1 a different row under a committed event ID waits with conflicting_event_id and the ledger stays readable", () => {
    const root = initializedRoot();
    const scenario = latePredecessorScenarioV3();
    expect(writeEventV3(root, asEventV3(scenario.start)).state).toBe("committed");
    // The drain judges against the witness checkpoint, which knows only IDs.
    expect(readAdvanceableControlWitnessV3(root)?.checkpoint).toBeDefined();

    // Same event ID, different but contract-valid bytes.
    const impostor = structuredClone(scenario.start);
    (impostor.time as { observed_at: string }).observed_at = new Date(
      Date.parse((scenario.start.time as { observed_at: string }).observed_at) + 1,
    ).toISOString();
    expect(canonicalJsonV3(impostor)).not.toBe(canonicalJsonV3(scenario.start));

    const result = writeEventV3(root, asEventV3(impostor));
    expect(result).toMatchObject({
      state: "waiting",
      reason: "conflicting_event_id",
      event_id: scenario.start.event_id as string,
    });
    expect(readFileSync(result.ready_path!, "utf8")).toBe(`${canonicalJsonV3(impostor)}\n`);
    const read = readLedgerV3(root);
    expect(read).toMatchObject({ complete: true, diagnostics: [] });
    expect(
      read.events.filter(({ event }) => event.event_id === scenario.start.event_id),
    ).toHaveLength(1);
    expect(readEventV3ControlState(root).state).toBe("active");
  });

  test("F1 an identical replay of a committed row is still admitted without a diagnostic", () => {
    const root = initializedRoot();
    const scenario = latePredecessorScenarioV3();
    expect(writeEventV3(root, asEventV3(scenario.start)).state).toBe("committed");
    expect(writeEventV3(root, asEventV3(scenario.start)).state).toBe("committed");
    plantCommittedReceiptV3(eventV3Paths(root).spool, scenario.start);
    expect(drainReadyEventsV3(root)).toBe(1);
    expect(spoolNamesV3(eventV3Paths(root).spool, ".ready")).toEqual([]);
    expect(spoolNamesV3(eventV3Paths(root).spool, ".committed")).toEqual([]);
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
    expect(readEventV3ControlState(root).state).toBe("active");
  });
});

describe("F2: an older-group genesis does not hide an unknown schema from automatic replacement", () => {
  test("F2 control reports epoch_schema_unknown for an older-group genesis epoch holding an unknown-digest row", () => {
    const { root } = olderGroupEpochWithUnknownRow();
    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "epoch_schema_unknown",
    });
  });

  test("F2 route resolution, refresh, init and rotation archive and replace nothing", () => {
    const { root, genesisId, activeBytes } = olderGroupEpochWithUnknownRow();
    expect(resolveLiveEventLedgerRouteV3(root)).toEqual({
      state: "blocked",
      reason: "epoch_schema_unknown",
    });
    expect(() => refreshIncompatibleEventLedgerV3(root)).toThrow(
      "event_v3_runtime_refresh_refused:invalid:epoch_schema_unknown",
    );
    expect(() => initializeEventLedgerV3(initInput(root))).toThrow(
      "event_v3_epoch_not_replaced:epoch_schema_unknown",
    );
    expect(rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 }).state).not.toBe("rotated");
    expect(archiveCount(root)).toBe(0);
    expect(genesisIdOf(root)).toBe(genesisId);
    expect(readFileSync(join(root, ".harnery/ledgers/v3/active.ndjson")).length).toBe(activeBytes);
  });

  test("F2 an older-group genesis epoch whose digests are all known is still replaced", () => {
    const root = initializedRoot();
    restampEpochSchema(root, priorBreakingDigestV3());
    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "genesis_schema_digest_incompatible",
    });
    expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({ state: "v3", mode: "active" });
    expect(archiveCount(root)).toBe(1);
  });
});

/** An epoch whose genesis precedes a breaking change, plus one row of a digest no lineage holds. */
function olderGroupEpochWithUnknownRow(): { root: string; genesisId: string; activeBytes: number } {
  const root = initializedRoot();
  restampEpochSchema(root, priorBreakingDigestV3());
  const events = new ReplayEventsV3();
  const row = unknownDigestQueuedRowV3(events, events.session("newer-runtime"));
  const active = join(root, ".harnery/ledgers/v3/active.ndjson");
  appendFileSync(active, `${canonicalJsonV3(row)}\n`);
  return { root, genesisId: genesisIdOf(root), activeBytes: readFileSync(active).length };
}

function restampEpochSchema(root: string, digest: string): void {
  const genesisPath = join(root, EVENT_V3_GENESIS_MANIFEST);
  const activationPath = join(root, EVENT_V3_ACTIVATION_MANIFEST);
  const genesis = JSON.parse(readFileSync(genesisPath, "utf8"));
  const activation = JSON.parse(readFileSync(activationPath, "utf8"));
  const priorGenesisRow = canonicalJsonV3(genesis.event);
  const priorActivationRow = canonicalJsonV3(activation.event);
  genesis.profile.initial_schema_digest = digest;
  genesis.event.contract.schema_digest = digest;
  genesis.event.payload.generated_schema_digest = digest;
  genesis.event.payload.genesis_profile_digest = candidateProfileDigestV3(genesis.profile);
  const candidateDigest = candidateManifestDigestV3(genesis);
  activation.candidate_manifest_digest = candidateDigest;
  activation.event.payload.candidate_digest = candidateDigest;
  activation.event.contract.schema_digest = digest;
  writeFileSync(genesisPath, `${canonicalJsonV3(genesis)}\n`);
  writeFileSync(activationPath, `${canonicalJsonV3(activation)}\n`);
  const active = eventV3Paths(root).active;
  const rows = readFileSync(active, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((row) =>
      row === priorGenesisRow
        ? canonicalJsonV3(genesis.event)
        : row === priorActivationRow
          ? canonicalJsonV3(activation.event)
          : row,
    );
  writeFileSync(active, rows.map((row) => `${row}\n`).join(""));
  rmSync(eventV3ControlWitnessPathV3(root), { force: true });
  rmSync(eventV3ControlCheckpointPathV3(root), { force: true });
}

function genesisIdOf(root: string): string {
  return JSON.parse(readFileSync(join(root, EVENT_V3_GENESIS_MANIFEST), "utf8")).event.payload
    .genesis_id;
}

function archiveCount(root: string): number {
  const archives = eventV3ArchivesRoot(root);
  return existsSync(archives)
    ? readdirSync(archives).filter((name) => name.startsWith("epoch-")).length
    : 0;
}

function initInput(root: string) {
  return {
    coordRoot: root,
    harneryBuild: "fixture-replay",
    hostBuild: "fixture-replay-host",
    configDigest: sha256V3("fixture-replay-config"),
    approvalRecordId: "fixture-replay",
  };
}

describe("F3: writeEventV3 accepts a stored event stamped with an earlier digest of the runtime's group", () => {
  test("F3 writeEventV3 commits an event stamped with the previous additive digest, bytes unchanged", () => {
    const root = initializedRoot();
    const { older } = adjacentAdditiveDigestsV3();
    const events = new ReplayEventsV3();
    const session = events.session("upgraded");
    const start = events.start(session, { schema_digest: older });
    const task = events.event(session, "coord.task_changed", {
      schema_digest: older,
      caused_by: [start.event_id as string],
    });
    for (const event of [start, task]) {
      expect(writeEventV3(root, asEventV3(event)).state).toBe("committed");
    }
    const read = readLedgerV3(root);
    expect(read).toMatchObject({ complete: true, diagnostics: [] });
    const committed = read.events.filter(({ event }) => event.contract.schema_digest === older);
    expect(committed.map(({ event }) => canonicalJsonV3(event))).toEqual([
      canonicalJsonV3(start),
      canonicalJsonV3(task),
    ]);
    expect(readEventV3ControlState(root).state).toBe("active");
  });

  test("F3 writeEventV3 still refuses a digest outside the runtime's group", () => {
    const root = initializedRoot();
    const events = new ReplayEventsV3();
    for (const digest of [priorBreakingDigestV3(), UNKNOWN_SCHEMA_DIGEST_V3]) {
      const start = events.start(events.session(`outside-${digest.slice(7, 12)}`), {
        schema_digest: digest,
      });
      expect(() => writeEventV3(root, asEventV3(start))).toThrow(
        "event schema digest is not accepted by this V3 writer",
      );
    }
    expect(spoolNamesV3(eventV3Paths(root).spool, ".ready")).toEqual([]);
  });
});

describe("F4: an automatic cutover revalidates the epoch under the publication and append leases", () => {
  test("F4a a refresh decided on a replaceable epoch refuses when another writer appends an unknown-digest row before the leases", () => {
    const root = initializedRoot();
    restampEpochSchema(root, priorBreakingDigestV3());
    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "genesis_schema_digest_incompatible",
    });
    const before = controlFilesOf(root);
    let appended: string | undefined;

    expect(() =>
      refreshIncompatibleEventLedgerV3(root, {
        onStep: (step) => {
          if (step === "replacement_decided") appended = appendUnknownDigestRow(root);
        },
      }),
    ).toThrow("event_v3_runtime_refresh_refused:invalid:epoch_schema_unknown");

    expect(appended).toBeDefined();
    expectEpochUntouched(root, before, appended!);
  });

  test("F4b a size rotation decided on a healthy epoch refuses when another writer appends an unknown-digest row before the leases", () => {
    const root = initializedRoot();
    const scenario = latePredecessorScenarioV3();
    expect(writeEventV3(root, asEventV3(scenario.start)).state).toBe("committed");
    expect(readEventV3ControlState(root).state).toBe("active");
    const before = controlFilesOf(root);
    let appended: string | undefined;

    const rotated = rotateOversizedEventLedgerV3(root, {
      thresholdBytes: 1,
      onStep: (step) => {
        if (step === "replacement_decided") appended = appendUnknownDigestRow(root);
      },
    });

    expect(appended).toBeDefined();
    expect(rotated).toMatchObject({ state: "refused", reason: "epoch_schema_unknown" });
    expect(rotated.archived_epoch).toBeUndefined();
    expectEpochUntouched(root, before, appended!);
  });

  test("F4c init decided on a replaceable epoch refuses when another writer appends an unknown-digest row before the leases", () => {
    const root = initializedRoot();
    restampEpochSchema(root, priorBreakingDigestV3());
    const before = controlFilesOf(root);
    let appended: string | undefined;

    expect(() =>
      initializeEventLedgerV3({
        ...initInput(root),
        onStep: (step) => {
          if (step === "replacement_decided") appended = appendUnknownDigestRow(root);
        },
      }),
    ).toThrow("event_v3_epoch_not_replaced:epoch_schema_unknown");

    expect(appended).toBeDefined();
    expectEpochUntouched(root, before, appended!);
  });

  test("F4c init's own replacement refuses when another writer appends an unknown-digest row before the leases", () => {
    const root = initializedRoot();
    restampEpochSchema(root, priorBreakingDigestV3());
    const before = controlFilesOf(root);
    let appended: string | undefined;

    expect(() =>
      initializeEventLedgerV3({
        ...initInput(root),
        replacement: initEventLedgerV3Replacement(),
        onStep: (step) => {
          if (step === "replacement_decided") appended = appendUnknownDigestRow(root);
        },
      }),
    ).toThrow("event_v3_epoch_not_replaced:epoch_schema_unknown");

    expect(appended).toBeDefined();
    expectEpochUntouched(root, before, appended!);
  });

  test("F4d an approved replacement still archives an epoch that turned unknown before the leases", () => {
    const root = initializedRoot();
    const genesisBefore = genesisIdOf(root);
    let appended: string | undefined;

    const replaced = initializeEventLedgerV3({
      ...initInput(root),
      replacement: { kind: "approved", command: "initialize_force_new_epoch" },
      onStep: (step) => {
        if (step === "replacement_decided") appended = appendUnknownDigestRow(root);
      },
    });

    expect(appended).toBeDefined();
    expect(replaced.archived_epoch).toBeDefined();
    expect(readFileSync(join(replaced.archived_epoch!, "active.ndjson"), "utf8")).toEndWith(
      appended!,
    );
    expect(archiveCount(root)).toBe(1);
    expect(genesisIdOf(root)).not.toBe(genesisBefore);
    expect(readEventV3ControlState(root).state).toBe("active");
  });

  test("F4 an approved recovery refuses when the failed authority is no longer there under the leases", () => {
    const root = initializedRoot();
    const active = join(root, ".harnery/ledgers/v3/active.ndjson");
    const healthy = readFileSync(active);
    appendFileSync(active, "{not an event\n");
    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "ledger_integrity_failure",
    });
    const before = controlFilesOf(root);

    expect(() =>
      initializeEventLedgerV3({
        ...initInput(root),
        replacement: {
          kind: "approved",
          command: "recover",
          replaces: (control) =>
            control.state === "invalid" && control.reason === "ledger_integrity_failure",
        },
        onStep: (step) => {
          if (step === "replacement_decided") writeFileSync(active, healthy);
        },
      }),
    ).toThrow("event_v3_epoch_not_replaced:epoch_changed_before_replacement:active");

    expect(archiveCount(root)).toBe(0);
    expect(controlFilesOf(root)).toEqual(before);
    expect(readEventV3ControlState(root).state).toBe("active");
  });

  test("F4e a size rotation with a waiting row still rotates and keeps the row in the archived queue", () => {
    const root = initializedRoot();
    const scenario = sequenceGapScenarioV3();
    for (const event of scenario.committed) {
      expect(writeEventV3(root, asEventV3(event)).state).toBe("committed");
    }
    const waiting = writeEventV3(root, asEventV3(scenario.x_waiting));
    expect(waiting.state).toBe("waiting");
    const waitingBytes = readFileSync(waiting.ready_path!, "utf8");
    const steps: string[] = [];

    const rotated = rotateOversizedEventLedgerV3(root, {
      thresholdBytes: 1,
      onStep: (step) => steps.push(step),
    });

    expect(steps).toEqual(["replacement_decided"]);
    expect(rotated.state).toBe("rotated");
    expect(archiveCount(root)).toBe(1);
    const archived = join(rotated.archived_epoch!, "spool", basename(waiting.ready_path!));
    expect(readFileSync(archived, "utf8")).toBe(waitingBytes);
    expect(readEventV3ControlState(root).state).toBe("active");
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
  });

  test("F4f a replace_breaking epoch whose present digests are all known is still refreshed", () => {
    const root = initializedRoot();
    restampEpochSchema(root, priorBreakingDigestV3());
    const genesisBefore = genesisIdOf(root);
    const steps: string[] = [];

    const refreshed = refreshIncompatibleEventLedgerV3(root, {
      onStep: (step) => steps.push(step),
    });

    expect(steps).toEqual(["replacement_decided"]);
    expect(refreshed.state).toBe("refreshed");
    expect(refreshed.archived_epoch).toBeDefined();
    expect(archiveCount(root)).toBe(1);
    expect(genesisIdOf(root)).not.toBe(genesisBefore);
    const control = readEventV3ControlState(root);
    expect(control.state).toBe("active");
    if (control.state === "active") {
      expect(control.genesis.profile.initial_schema_digest).toBe(EVENT_V3_SCHEMA_DIGEST);
    }
  });
});

/** Append, as another runtime would, one row stamped with a digest no lineage holds. */
function appendUnknownDigestRow(root: string): string {
  const events = new ReplayEventsV3();
  const row = `${canonicalJsonV3(unknownDigestQueuedRowV3(events, events.session("newer-runtime")))}\n`;
  appendFileSync(join(root, ".harnery/ledgers/v3/active.ndjson"), row);
  return row;
}

function controlFilesOf(root: string): { genesis: string; activation: string } {
  return {
    genesis: readFileSync(join(root, EVENT_V3_GENESIS_MANIFEST), "utf8"),
    activation: readFileSync(join(root, EVENT_V3_ACTIVATION_MANIFEST), "utf8"),
  };
}

/** Nothing archived, the control pair byte-identical, and the unknown row still in place. */
function expectEpochUntouched(
  root: string,
  before: { genesis: string; activation: string },
  appended: string,
): void {
  expect(archiveCount(root)).toBe(0);
  expect(controlFilesOf(root)).toEqual(before);
  expect(readFileSync(join(root, ".harnery/ledgers/v3/active.ndjson"), "utf8")).toEndWith(appended);
  expect(readEventV3ControlState(root)).toEqual({
    state: "invalid",
    reason: "epoch_schema_unknown",
  });
}
