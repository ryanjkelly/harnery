import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import {
  adjacentAdditiveDigestsV3,
  alternatingDigestTurnsV3,
  asEventV3,
  framesV3,
  genesisForDigestV3,
  initializeReplayLedgerV3,
  mixedAdditiveEpochV3,
  plantReadyRowV3,
  priorBreakingDigestV3,
  ReplayEventsV3,
  replayRootV3,
  UNKNOWN_SCHEMA_DIGEST_V3,
  unknownDigestEpochV3,
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
  type EventV3ControlState,
  readEventV3ControlState,
} from "./control.ts";
import {
  activeControlWitnessMatchesV3,
  readAdvanceableControlWitnessV3,
} from "./control-witness.ts";
import { EVENT_V3_SCHEMA_DIGEST, EVENT_V3_SCHEMA_LINEAGE } from "./generated.ts";
import { resolveLiveEventLedgerRouteV3 } from "./live-routing.ts";
import {
  eventV3ControlCheckpointPathV3,
  eventV3ControlWitnessPathV3,
  readLedgerFramesV3,
  readLedgerV3,
} from "./reader.ts";
import { importArchivedReadyEventsV3 } from "./ready-history.ts";
import {
  type EventV3SchemaLineageV3,
  epochCompatibilityV3,
  schemaGroupForDigestV3,
} from "./schema-lineage.ts";
import { drainReadyEventsV3, eventV3Paths, inspectEventV3QueueV3, writeEventV3 } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

const livePath = resolve(import.meta.dir, "live-routing.ts");
const witnessModulePath = resolve(import.meta.dir, "control-witness.ts");

describe("event ledger V3 schema compatibility: alternating runtimes (a)", () => {
  test("the alternating digests sit next to each other in the runtime's additive group", () => {
    const { older, newer } = adjacentAdditiveDigestsV3();
    expect(newer as string).toBe(EVENT_V3_SCHEMA_DIGEST);
    const olderGroup = schemaGroupForDigestV3(older);
    const newerGroup = schemaGroupForDigestV3(newer);
    expect(olderGroup?.group_index).toBe(newerGroup?.group_index);
    expect(alternatingDigestTurnsV3(4)).toEqual([newer, older, newer, older]);
  });

  test("two runtimes on adjacent digests of one additive group take turns on one root without creating an archive", () => {
    const { older, newer } = adjacentAdditiveDigestsV3();
    const root = initializedRoot();
    restampEpochSchema(root, older);
    const genesisId = genesisIdOf(root);
    const events = new ReplayEventsV3();
    for (const [turn, runtimeDigest] of alternatingDigestTurnsV3(4).entries()) {
      if (runtimeDigest === newer) {
        // This runtime: serves the older epoch in place and writes to it. Each
        // turn is its own session, so its producer starts at sequence 1.
        expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({ state: "v3", mode: "active" });
        const session = events.session(`turn-${turn}`);
        expect(writeEventV3(root, asEventV3(events.start(session))).state).toBe("committed");
        expect(readLedgerV3(root).diagnostics).toEqual([]);
      } else {
        // The older runtime's lineage ends at its own digest. It never
        // classifies the shared epoch as replaceable: it either serves it or,
        // once newer rows are present, blocks itself.
        const present = readLedgerV3(root).schema_digests ?? [];
        const verdict = epochCompatibilityV3(
          { genesis_schema_digest: older, present_schema_digests: present },
          lineageEndingAt(older),
          older,
        ).verdict;
        expect(verdict).toBe(present.includes(newer) ? "unknown" : "serve");
      }
      expect(archiveCount(root)).toBe(0);
      expect(genesisIdOf(root)).toBe(genesisId);
    }
  });

  test("each runtime serves the shared epoch and stamps its own digest on the rows it writes", () => {
    const { older, newer } = adjacentAdditiveDigestsV3();
    const root = initializedRoot();
    restampEpochSchema(root, older);
    expect(
      epochCompatibilityV3(
        { genesis_schema_digest: older, present_schema_digests: [older] },
        lineageEndingAt(older),
        older,
      ).verdict,
    ).toBe("serve");
    const events = new ReplayEventsV3();
    const start = events.start(events.session("stamp"));
    expect(writeEventV3(root, asEventV3(start)).state).toBe("committed");
    const read = readLedgerV3(root);
    expect(read.complete).toBe(true);
    expect(read.genesis_schema_digest).toBe(older);
    expect(read.schema_digests).toEqual([older, newer].sort());
    const written = read.events.find(({ event }) => event.event_id === start.event_id);
    expect(written?.event.contract.schema_digest).toBe(newer);
  });

  test("a drain that appends the first row of the newer digest adds it to the witness and checkpoint", async () => {
    const { older, newer } = adjacentAdditiveDigestsV3();
    const root = initializedRoot();
    restampEpochSchema(root, older);
    // A full read publishes a witness listing only the genesis digest.
    expect(readEventV3ControlState(root).state).toBe("active");
    expect(readAdvanceableControlWitnessV3(root)?.payload.schema_digests).toEqual([older]);

    const events = new ReplayEventsV3();
    expect(writeEventV3(root, asEventV3(events.start(events.session("first-newer")))).state).toBe(
      "committed",
    );

    // A fresh process reads only the witness and its checkpoint, no ledger rows.
    const script = `
      const { readAdvanceableControlWitnessV3 } = await import(${JSON.stringify(witnessModulePath)});
      const witness = readAdvanceableControlWitnessV3(${JSON.stringify(root)});
      console.log(JSON.stringify({
        witness: witness?.payload.schema_digests,
        checkpoint: witness?.checkpoint.schema_digests,
      }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exitCode).toBe(0);
    const both = [older, newer].sort();
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
      witness: both,
      checkpoint: both,
    });
    expect(activeControlWitnessMatchesV3(root, activeControlOf(root))).toBe(true);
  });

  test("a runtime still replaces an epoch whose genesis digest precedes a breaking change", () => {
    const root = initializedRoot();
    restampEpochSchema(root, priorBreakingDigestV3());
    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "genesis_schema_digest_incompatible",
    });
    expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({ state: "v3", mode: "active" });
    expect(archiveCount(root)).toBe(1);
    const control = readEventV3ControlState(root);
    expect(control.state).toBe("active");
    if (control.state === "active") {
      expect(control.genesis.profile.initial_schema_digest).toBe(EVENT_V3_SCHEMA_DIGEST);
      expect(control.genesis.manifest_version).toBe(2);
    }
  });

  test("an older same-group epoch is served with no archive under concurrent route resolutions", async () => {
    const { older } = adjacentAdditiveDigestsV3();
    const root = initializedRoot();
    restampEpochSchema(root, older);
    const genesisId = genesisIdOf(root);
    const script = `
      const { resolveLiveEventLedgerRouteV3 } = await import(${JSON.stringify(livePath)});
      console.log(JSON.stringify(resolveLiveEventLedgerRouteV3(${JSON.stringify(root)})));
    `;
    const children = Array.from({ length: 4 }, () =>
      Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }),
    );
    const routes = await Promise.all(
      children.map(async (child) => {
        const [stdout, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ]);
        expect(exitCode).toBe(0);
        return JSON.parse(stdout.trim().split("\n").at(-1)!) as { state: string };
      }),
    );
    expect(routes.map(({ state }) => state)).toEqual(["v3", "v3", "v3", "v3"]);
    expect(archiveCount(root)).toBe(0);
    expect(genesisIdOf(root)).toBe(genesisId);
  });
});

describe("event ledger V3 schema compatibility: mixed and unknown digests (e)", () => {
  test("rows of two additive digests in one epoch read complete under the runtime's group", () => {
    const epoch = mixedAdditiveEpochV3();
    const read = readLedgerFramesV3(framesV3(epoch.rows));
    expect(read.diagnostics).toEqual([]);
    expect(read.schema_digests).toEqual([...epoch.present_digests].sort());
  });

  test("an epoch on a digest outside the lineage is unknown, never replaceable", () => {
    const epoch = unknownDigestEpochV3();
    expect(schemaGroupForDigestV3(epoch.genesis_digest)).toBeUndefined();
    expect(epochCompatibilityV3({ genesis_schema_digest: epoch.genesis_digest })).toEqual({
      verdict: "unknown",
      reason: "epoch_schema_unknown",
    });
    expect(readLedgerFramesV3(framesV3(epoch.rows)).diagnostics.map(({ code }) => code)).toEqual([
      "unsupported_schema_digest",
      "unsupported_schema_digest",
    ]);
    expect(schemaGroupForDigestV3(priorBreakingDigestV3())?.group_index).toBeLessThan(
      schemaGroupForDigestV3(EVENT_V3_SCHEMA_DIGEST)!.group_index,
    );
  });

  test("the writer stamps only the runtime's own digest", () => {
    const events = new ReplayEventsV3();
    const row = unknownDigestQueuedRowV3(events, events.session("newer-runtime"));
    expect(() => writeEventV3(initializedRoot(), asEventV3(row))).toThrow(
      "event schema digest is not accepted by this V3 writer",
    );
  });

  test("a queued row stamped with an unknown digest stays untouched for a newer runtime", () => {
    const root = initializedRoot();
    const events = new ReplayEventsV3();
    const session = events.session("newer-runtime");
    expect(writeEventV3(root, asEventV3(events.start(session))).state).toBe("committed");
    const row = unknownDigestQueuedRowV3(events, session);
    const planted = plantReadyRowV3(spool(root), row);
    const bytes = readFileSync(planted, "utf8");
    expect(drainReadyEventsV3(root)).toBe(0);
    expect(readFileSync(planted, "utf8")).toBe(bytes);
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
    expect((row.contract as { schema_digest: string }).schema_digest).toBe(
      UNKNOWN_SCHEMA_DIGEST_V3,
    );
    // The queue reports it as waiting for a runtime that knows its schema, and
    // this runtime's own rows beside it keep committing.
    expect(inspectEventV3QueueV3(root).waiting).toEqual([
      expect.objectContaining({ name: basename(planted), reason: "epoch_schema_unknown" }),
    ]);
    const other = events.start(events.session("this-runtime"));
    expect(writeEventV3(root, asEventV3(other)).state).toBe("committed");
    expect(readFileSync(planted, "utf8")).toBe(bytes);
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
  });

  test("an epoch holding rows of two digests from one additive group reads complete and is served", () => {
    const { older, newer } = adjacentAdditiveDigestsV3();
    const root = initializedRoot();
    restampEpochSchema(root, older);
    const events = new ReplayEventsV3();
    expect(writeEventV3(root, asEventV3(events.start(events.session("mixed")))).state).toBe(
      "committed",
    );
    expect(readEventV3ControlState(root).state).toBe("active");
    // The second read answers from the witness, which lists both digests.
    expect(readEventV3ControlState(root).state).toBe("active");
    const witness = JSON.parse(readFileSync(eventV3ControlWitnessPathV3(root), "utf8"));
    expect(witness.payload.format_version).toBe(3);
    expect(witness.payload.schema_digests).toEqual([older, newer].sort());
    expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({ state: "v3" });
    expect(archiveCount(root)).toBe(0);
  });

  test("an epoch holding two digests from one additive group rotates and its archive keeps both", () => {
    const { older, newer } = adjacentAdditiveDigestsV3();
    const root = initializedRoot();
    restampEpochSchema(root, older);
    const events = new ReplayEventsV3();
    expect(writeEventV3(root, asEventV3(events.start(events.session("before")))).state).toBe(
      "committed",
    );

    const rotated = rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 });
    expect(rotated.state).toBe("rotated");
    const archived = rotated.archived_epoch!;
    const archivedDigests = new Set(
      readFileSync(join(archived, "active.ndjson"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            (JSON.parse(line) as { contract: { schema_digest: string } }).contract.schema_digest,
        ),
    );
    expect([...archivedDigests].sort()).toEqual([older, newer].sort());
    expect(rotated.control?.genesis.manifest_version).toBe(2);

    // A pending row stamped with the newer digest is carried into the archive
    // that began on the older one.
    const archivedSpool = join(archived, "spool");
    mkdirSync(archivedSpool, { recursive: true });
    const pending = events.start(events.session("pending"));
    plantReadyRowV3(archivedSpool, pending);
    const plan = importArchivedReadyEventsV3(root, basename(archived));
    expect(plan.events.map(({ event_id }) => event_id)).toContain(pending.event_id as string);
  });

  test("an epoch holding a digest outside the runtime's lineage blocks this runtime with epoch_schema_unknown, appends nothing and creates no archive", () => {
    const root = initializedRoot();
    restampEpochSchema(root, UNKNOWN_SCHEMA_DIGEST_V3);
    const activeBefore = readFileSync(eventV3Paths(root).active);
    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "epoch_schema_unknown",
    });
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
    expect(rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 }).state).toBe("not_active");
    expect(readFileSync(eventV3Paths(root).active).equals(activeBefore)).toBe(true);
    expect(archiveCount(root)).toBe(0);
  });

  test("a row stamped with a digest outside the lineage blocks this runtime without replacing the epoch", () => {
    const root = initializedRoot();
    const events = new ReplayEventsV3();
    const session = events.session("unknown-row");
    expect(writeEventV3(root, asEventV3(events.start(session))).state).toBe("committed");
    appendFileSync(
      eventV3Paths(root).active,
      `${canonicalJsonV3(unknownDigestQueuedRowV3(events, session))}\n`,
    );
    const activeBefore = readFileSync(eventV3Paths(root).active);
    // The reader names the unknown digest and nothing else.
    expect(readLedgerV3(root).diagnostics.map(({ code }) => code)).toEqual([
      "unsupported_schema_digest",
    ]);
    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "epoch_schema_unknown",
    });
    expect(resolveLiveEventLedgerRouteV3(root)).toEqual({
      state: "blocked",
      reason: "epoch_schema_unknown",
    });
    expect(() => initializeEventLedgerV3(initInput(root))).toThrow(
      "event_v3_epoch_not_replaced:epoch_schema_unknown",
    );
    expect(readFileSync(eventV3Paths(root).active).equals(activeBefore)).toBe(true);
    expect(archiveCount(root)).toBe(0);
  });

  test("a reader reports a row from a newer runtime as an unknown digest, not an invalid event", () => {
    const genesis = genesisForDigestV3(EVENT_V3_SCHEMA_DIGEST);
    const events = new ReplayEventsV3();
    const row = unknownDigestQueuedRowV3(events, events.session("newer"));
    (row.payload as Record<string, unknown>).field_only_a_newer_schema_knows = true;
    const read = readLedgerFramesV3(framesV3([genesis, row]));
    expect(read.diagnostics.map(({ code }) => code)).toEqual(["unsupported_schema_digest"]);
  });

  test("both a version 1 and a version 2 genesis manifest are served", () => {
    const root = initializedRoot();
    expect(manifestVersionOf(root)).toBe(2);
    expect(readEventV3ControlState(root).state).toBe("active");
    restampEpochSchema(root, EVENT_V3_SCHEMA_DIGEST, 1);
    expect(manifestVersionOf(root)).toBe(1);
    expect(readEventV3ControlState(root).state).toBe("active");
    expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({ state: "v3", mode: "active" });
    expect(archiveCount(root)).toBe(0);
  });
});

/**
 * Rewrite an initialized epoch as if a runtime on `digest` had created it:
 * the genesis profile, the genesis and activation events and their manifests,
 * re-bound to each other. The active file is rewritten in place, so the
 * catalog's binding to it holds, and the witness and checkpoint are removed.
 */
function restampEpochSchema(root: string, digest: string, manifestVersion: 1 | 2 = 2): void {
  const genesisPath = join(root, EVENT_V3_GENESIS_MANIFEST);
  const activationPath = join(root, EVENT_V3_ACTIVATION_MANIFEST);
  const genesis = JSON.parse(readFileSync(genesisPath, "utf8"));
  const activation = JSON.parse(readFileSync(activationPath, "utf8"));
  const priorGenesisRow = canonicalJsonV3(genesis.event);
  const priorActivationRow = canonicalJsonV3(activation.event);
  genesis.manifest_version = manifestVersion;
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

/** The lineage as a runtime whose own digest is `digest` would carry it. */
function lineageEndingAt(digest: string): EventV3SchemaLineageV3 {
  const position = schemaGroupForDigestV3(digest)!;
  return {
    groups: [
      ...EVENT_V3_SCHEMA_LINEAGE.groups.slice(0, position.group_index),
      position.group.slice(0, position.position + 1),
    ],
  };
}

function activeControlOf(root: string): Extract<EventV3ControlState, { state: "active" }> {
  const control = readEventV3ControlState(root);
  if (control.state !== "active") throw new Error(`expected active control, got ${control.state}`);
  return control;
}

function genesisIdOf(root: string): string {
  return JSON.parse(readFileSync(join(root, EVENT_V3_GENESIS_MANIFEST), "utf8")).event.payload
    .genesis_id;
}

function manifestVersionOf(root: string): number {
  return JSON.parse(readFileSync(join(root, EVENT_V3_GENESIS_MANIFEST), "utf8")).manifest_version;
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

function initializedRoot(): string {
  const root = replayRootV3("harnery-v3-schema-compatibility-");
  roots.push(root);
  initializeReplayLedgerV3(root);
  return root;
}

function spool(root: string): string {
  return eventV3Paths(root).spool;
}
