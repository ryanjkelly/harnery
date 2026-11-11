import { afterEach, describe, expect, test } from "bun:test";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import {
  adjacentAdditiveDigestsV3,
  alternatingDigestTurnsV3,
  asEventV3,
  framesV3,
  initializeReplayLedgerV3,
  mixedAdditiveEpochV3,
  plantReadyRowV3,
  priorBreakingDigestV3,
  ReplayEventsV3,
  replayRootV3,
  spoolNamesV3,
  UNKNOWN_SCHEMA_DIGEST_V3,
  unknownDigestEpochV3,
  unknownDigestQueuedRowV3,
} from "./__fixtures__/ledger-replay.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { readLedgerFramesV3, readLedgerV3 } from "./reader.ts";
import { epochCompatibilityV3, schemaGroupForDigestV3 } from "./schema-lineage.ts";
import { drainReadyEventsV3, eventV3Paths, writeEventV3 } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

/** Body for a compatibility case the lineage rule does not implement yet. */
const pendingCompatibility = () => {
  throw new Error("pending: callers still require the genesis digest to equal the runtime's");
};

describe("event ledger V3 schema compatibility: alternating runtimes (a)", () => {
  test("the alternating digests sit next to each other in the runtime's additive group", () => {
    const { older, newer } = adjacentAdditiveDigestsV3();
    expect(newer as string).toBe(EVENT_V3_SCHEMA_DIGEST);
    const olderGroup = schemaGroupForDigestV3(older);
    const newerGroup = schemaGroupForDigestV3(newer);
    expect(olderGroup?.group_index).toBe(newerGroup?.group_index);
    expect(alternatingDigestTurnsV3(4)).toEqual([newer, older, newer, older]);
  });

  test("today: every turn change replaces the other runtime's epoch", () => {
    // The compatibility work replaces this: both runtimes serve one epoch.
    const turns = alternatingDigestTurnsV3(4);
    const verdicts = turns.slice(1).map((runtimeDigest, index) => {
      const epochDigest = turns[index]!;
      return epochCompatibilityV3({ genesis_schema_digest: epochDigest }, undefined, runtimeDigest)
        .verdict;
    });
    expect(verdicts).toEqual(["replace_breaking", "replace_breaking", "replace_breaking"]);
  });

  test.todo(
    "two runtimes on adjacent digests of one additive group take turns on one root without creating an archive",
    pendingCompatibility,
  );
  test.todo(
    "each runtime serves the shared epoch and stamps its own digest on the rows it writes",
    pendingCompatibility,
  );
  test.todo(
    "a runtime still replaces an epoch whose genesis digest precedes a breaking change",
    pendingCompatibility,
  );
});

describe("event ledger V3 schema compatibility: mixed and unknown digests (e)", () => {
  test("today: rows of two additive digests in one epoch fail the read", () => {
    // The compatibility work replaces this: rows of any digest in the group read complete.
    const epoch = mixedAdditiveEpochV3();
    const read = readLedgerFramesV3(framesV3(epoch.rows), {
      accepted_schema_digests: epoch.present_digests,
    });
    expect(read.diagnostics.map(({ code }) => code)).toEqual(["unexpected_schema_digest"]);
    const runtimeOnly = readLedgerFramesV3(framesV3(epoch.rows));
    expect(runtimeOnly.diagnostics.map(({ code }) => code)).toEqual([
      "unsupported_schema_digest",
      "unsupported_schema_digest",
      "unexpected_schema_digest",
    ]);
  });

  test("today: an epoch on a digest outside the lineage is classified as replaceable", () => {
    // The compatibility work replaces this: the verdict is unknown, reason epoch_schema_unknown.
    const epoch = unknownDigestEpochV3();
    expect(schemaGroupForDigestV3(epoch.genesis_digest)).toBeUndefined();
    expect(epochCompatibilityV3({ genesis_schema_digest: epoch.genesis_digest }).verdict).toBe(
      "replace_breaking",
    );
    expect(readLedgerFramesV3(framesV3(epoch.rows)).diagnostics.map(({ code }) => code)).toContain(
      "unsupported_schema_digest",
    );
    expect(schemaGroupForDigestV3(priorBreakingDigestV3())?.group_index).toBeLessThan(
      schemaGroupForDigestV3(EVENT_V3_SCHEMA_DIGEST)!.group_index,
    );
  });

  test("today: the writer refuses to stamp a digest other than the runtime's", () => {
    const events = new ReplayEventsV3();
    const row = unknownDigestQueuedRowV3(events, events.session("newer-runtime"));
    expect(() => writeEventV3(initializedRoot(), asEventV3(row))).toThrow(
      "event schema digest is not accepted by this V3 writer",
    );
  });

  test("today: a queued row stamped with an unknown digest is drained and fails the ledger", () => {
    // The door-check work replaces this: the row stays untouched for a newer runtime.
    const root = initializedRoot();
    const events = new ReplayEventsV3();
    const session = events.session("newer-runtime");
    expect(writeEventV3(root, asEventV3(events.start(session))).state).toBe("committed");
    const row = unknownDigestQueuedRowV3(events, session);
    plantReadyRowV3(spool(root), row);
    expect(drainReadyEventsV3(root)).toBe(1);
    expect(spoolNamesV3(spool(root), ".ready")).toEqual([]);
    expect(readLedgerV3(root).diagnostics.map(({ code }) => code)).toEqual([
      "unsupported_schema_digest",
      "unexpected_schema_digest",
    ]);
    expect((row.contract as { schema_digest: string }).schema_digest).toBe(
      UNKNOWN_SCHEMA_DIGEST_V3,
    );
  });

  test.todo(
    "an epoch holding rows of two digests from one additive group reads complete and is served",
    pendingCompatibility,
  );
  test.todo(
    "an epoch holding two digests from one additive group rotates and its archive keeps both",
    pendingCompatibility,
  );
  test.todo(
    "an epoch holding a digest outside the runtime's lineage blocks this runtime with epoch_schema_unknown, appends nothing and creates no archive",
    pendingCompatibility,
  );
  test.todo(
    "a queued row stamped with an unknown digest is left untouched in the queue for a newer runtime",
    pendingCompatibility,
  );
  test.todo(
    "a reader reports a row from a newer runtime as an unknown digest, not an invalid event",
    pendingCompatibility,
  );
});

function initializedRoot(): string {
  const root = replayRootV3("harnery-v3-schema-compatibility-");
  roots.push(root);
  initializeReplayLedgerV3(root);
  return root;
}

function spool(root: string): string {
  return eventV3Paths(root).spool;
}
