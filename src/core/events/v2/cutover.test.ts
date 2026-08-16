import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertV1WriterIdentityV2,
  type CutoverV2Step,
  createProjectionSnapshotV2,
  projectionSnapshotDigestV2,
  rehearseCutoverV2,
  restoreProjectionSnapshotV2,
  rollbackV1LedgerV2,
  sealV1LedgerV2,
  verifyV1SealV2,
} from "./cutover.ts";

const roots: string[] = [];
const NOW = () => Date.parse("2026-08-16T22:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodFenceForCleanup(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("event ledger V2 cutover safety", () => {
  test("seals immutable V1 bytes, fences stale writers, and restores exact projections", () => {
    const root = fixtureRoot();
    const artifactRoot = join(root, ".harnery", "cutover-artifacts");
    const priorArchive = join(root, ".harnery", "events-2026-08-16.ndjson");
    writeFileSync(priorArchive, '{"prior":true}\n', "utf8");
    const snapshot = createProjectionSnapshotV2({
      coordRoot: root,
      artifactRoot,
      projectionPaths: [".harnery/active", ".harnery/.events-cursor"],
      now: NOW,
    });
    const staleIdentity = snapshot.source_v1_active;
    writeFileSync(join(root, ".harnery", "active", "agent-a.json"), '{"changed":true}\n');
    writeFileSync(join(root, ".harnery", ".events-cursor"), "changed\n");

    const seal = sealV1LedgerV2({ coordRoot: root, artifactRoot, snapshot, now: NOW });
    expect(seal.terminal_archive).toBe(".harnery/events-2026-08-16.1.ndjson");
    expect(seal.terminal_rows).toBe(2);
    expect(seal.segments).toHaveLength(2);
    expect(() => appendFileSync(join(root, ".harnery", "events.ndjson"), "stale\n")).toThrow();
    expect(() => assertV1WriterIdentityV2(root, staleIdentity)).toThrow("v1_writer_fenced");
    verifyV1SealV2(root, seal, projectionSnapshotDigestV2(snapshot));

    const rollback = rollbackV1LedgerV2({
      coordRoot: root,
      artifactRoot,
      snapshot,
      seal,
      now: NOW,
    });
    expect(rollback.kind).toBe("v1_rollback_complete");
    expect(readFileSync(join(root, ".harnery", "events.ndjson"), "utf8")).toBe("");
    expect(readFileSync(join(root, ".harnery", "active", "agent-a.json"), "utf8")).toBe(
      '{"task":"before"}\n',
    );
    expect(readFileSync(join(root, ".harnery", ".events-cursor"), "utf8")).toBe("evt_before\n");
    expect(readFileSync(join(root, seal.terminal_archive), "utf8")).toContain("evt_2");
    expect(() => assertV1WriterIdentityV2(root, staleIdentity)).toThrow("v1_writer_stale");

    expect(rollbackV1LedgerV2({ coordRoot: root, artifactRoot, snapshot, seal, now: NOW })).toEqual(
      rollback,
    );
  });

  test("refuses to seal when V1 changed after the projection snapshot", () => {
    const root = fixtureRoot();
    const artifactRoot = join(root, ".harnery", "cutover-artifacts");
    const snapshot = createProjectionSnapshotV2({
      coordRoot: root,
      artifactRoot,
      projectionPaths: [".harnery/active"],
      now: NOW,
    });
    appendFileSync(join(root, ".harnery", "events.ndjson"), '{"event_id":"evt_late"}\n');
    expect(() => sealV1LedgerV2({ coordRoot: root, artifactRoot, snapshot, now: NOW })).toThrow(
      "v1_active_changed_since_snapshot",
    );
    expect(existsSync(join(root, ".harnery", "events.ndjson"))).toBeTrue();
  });

  test("rejects overlapping, audit, live-V2, and tampered snapshot inputs", () => {
    const root = fixtureRoot();
    const artifactRoot = join(root, ".harnery", "cutover-artifacts");
    expect(() =>
      createProjectionSnapshotV2({
        coordRoot: root,
        artifactRoot,
        projectionPaths: [".harnery/active", ".harnery/active/agent-a.json"],
      }),
    ).toThrow("projection_snapshot_roots_overlap");
    expect(() =>
      createProjectionSnapshotV2({
        coordRoot: root,
        artifactRoot,
        projectionPaths: [".harnery/events.ndjson"],
      }),
    ).toThrow("projection_path_forbidden");
    expect(() =>
      createProjectionSnapshotV2({
        coordRoot: root,
        artifactRoot: join(root, ".harnery", "ledgers", "v2", "snapshots"),
        projectionPaths: [".harnery/active"],
      }),
    ).toThrow("live_v2_artifact_path_forbidden");
    expect(() =>
      createProjectionSnapshotV2({
        coordRoot: root,
        artifactRoot: join(root, ".harnery", "active", "snapshot"),
        projectionPaths: [".harnery/active"],
      }),
    ).toThrow("projection_snapshot_artifact_overlap");

    const snapshot = createProjectionSnapshotV2({
      coordRoot: root,
      artifactRoot,
      projectionPaths: [".harnery/active"],
      now: NOW,
    });
    const object = snapshot.entries.find((entry) => entry.kind === "file")?.digest;
    expect(object).toBeDefined();
    writeFileSync(join(artifactRoot, "snapshot", "objects", object!.slice(7)), "tampered");
    expect(() =>
      restoreProjectionSnapshotV2({
        coordRoot: root,
        artifactRoot,
        projectionPaths: snapshot.roots,
        snapshot,
      }),
    ).toThrow("projection_snapshot_object_mismatch");
  });

  test("seal verification requires the exact immutable fence marker", () => {
    const root = fixtureRoot();
    const artifactRoot = join(root, ".harnery", "cutover-artifacts");
    const snapshot = createProjectionSnapshotV2({
      coordRoot: root,
      artifactRoot,
      projectionPaths: [".harnery/active"],
      now: NOW,
    });
    const seal = sealV1LedgerV2({ coordRoot: root, artifactRoot, snapshot, now: NOW });
    const fence = join(root, ".harnery", "events.ndjson");
    chmodSync(fence, 0o700);
    writeFileSync(join(fence, "unexpected"), "not exact", "utf8");
    expect(() => verifyV1SealV2(root, seal, projectionSnapshotDigestV2(snapshot))).toThrow(
      "v1_fence_not_exact",
    );
  });

  for (const killedAt of [
    "seal_intent_committed",
    "v1_active_renamed",
    "v1_fence_installed",
    "seal_manifest_committed",
  ] satisfies CutoverV2Step[]) {
    test(`recovers an exact V1 seal after a kill at ${killedAt}`, () => {
      const root = fixtureRoot();
      const artifactRoot = join(root, ".harnery", "cutover-artifacts");
      const snapshot = createProjectionSnapshotV2({
        coordRoot: root,
        artifactRoot,
        projectionPaths: [".harnery/active"],
        now: NOW,
      });
      expect(() =>
        sealV1LedgerV2({
          coordRoot: root,
          artifactRoot,
          snapshot,
          now: NOW,
          onStep(step) {
            if (step === killedAt) throw new Error(`killed:${step}`);
          },
        }),
      ).toThrow(`killed:${killedAt}`);
      const seal = sealV1LedgerV2({ coordRoot: root, artifactRoot, snapshot, now: NOW });
      verifyV1SealV2(root, seal, projectionSnapshotDigestV2(snapshot));
    });
  }

  for (const killedAt of [
    "rollback_intent_committed",
    "v1_fence_removed",
    "v1_continuation_created",
    "projection_root_restored",
    "rollback_record_committed",
  ] satisfies CutoverV2Step[]) {
    test(`recovers an exact rollback after a kill at ${killedAt}`, () => {
      const root = fixtureRoot();
      const artifactRoot = join(root, ".harnery", "cutover-artifacts");
      const snapshot = createProjectionSnapshotV2({
        coordRoot: root,
        artifactRoot,
        projectionPaths: [".harnery/active", ".harnery/.events-cursor"],
        now: NOW,
      });
      const seal = sealV1LedgerV2({ coordRoot: root, artifactRoot, snapshot, now: NOW });
      writeFileSync(join(root, ".harnery", "active", "agent-a.json"), '{"changed":true}\n');
      let killed = false;
      expect(() =>
        rollbackV1LedgerV2({
          coordRoot: root,
          artifactRoot,
          snapshot,
          seal,
          now: NOW,
          onStep(step) {
            if (!killed && step === killedAt) {
              killed = true;
              throw new Error(`killed:${step}`);
            }
          },
        }),
      ).toThrow(`killed:${killedAt}`);
      const rollback = rollbackV1LedgerV2({
        coordRoot: root,
        artifactRoot,
        snapshot,
        seal,
        now: NOW,
      });
      expect(rollback.kind).toBe("v1_rollback_complete");
      expect(readFileSync(join(root, ".harnery", "active", "agent-a.json"), "utf8")).toBe(
        '{"task":"before"}\n',
      );
    });
  }

  test("runs end to end only in an explicit OS temporary root", () => {
    const root = fixtureRoot();
    const result = rehearseCutoverV2({
      root,
      projectionPaths: [".harnery/active", ".harnery/.events-cursor"],
      now: NOW,
    });
    expect(result).toMatchObject({ ok: true, stale_writer_refused: true });
    expect(() => rehearseCutoverV2({ root: "/", projectionPaths: [".harnery/active"] })).toThrow(
      "cutover_rehearsal_requires_explicit_temporary_root",
    );
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-cutover-v2-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery", "active"), { recursive: true });
  writeFileSync(
    join(root, ".harnery", "events.ndjson"),
    '{"event_id":"evt_1"}\n{"event_id":"evt_2"}\n',
    "utf8",
  );
  const fixed = new Date("2026-08-16T20:00:00.000Z");
  utimesSync(join(root, ".harnery", "events.ndjson"), fixed, fixed);
  writeFileSync(join(root, ".harnery", "active", "agent-a.json"), '{"task":"before"}\n');
  writeFileSync(join(root, ".harnery", ".events-cursor"), "evt_before\n");
  return root;
}

function chmodFenceForCleanup(root: string): void {
  const fence = join(root, ".harnery", "events.ndjson");
  try {
    if (existsSync(fence)) chmodSync(fence, 0o700);
  } catch {
    // Test cleanup remains best-effort after intentionally killed boundaries.
  }
}
