import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../tests/helpers/event-v3-runtime.ts";
import {
  ARTIFACT_MANIFEST,
  artifactReviewGuidance,
  cleanArtifacts,
  createArtifact,
  discardArtifact,
  holdArtifact,
  inventoryArtifacts,
  renewArtifact,
} from "./index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(minutes?: number) {
  const root = mkdtempSync(join(tmpdir(), "harnery-discard-"));
  roots.push(root);
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  const unit = createArtifact(root, {
    slug: "capture",
    purpose: "QA",
    retentionDays: 3,
    retentionMinutes: minutes,
  });
  const payload = join(unit.path, "capture.png");
  writeFileSync(payload, "evidence");
  return { root, unit, payload, now: new Date() };
}
test("discard preserves files for the grace period, records the decision, and cleanup deletes afterward", () => {
  const { root, unit, payload, now } = fixture();
  const manifest = discardArtifact(root, unit.manifest.artifact_id, "Reviewed and superseded", {
    now,
  });
  expect(manifest.retention.reason).toBe("Reviewed and superseded");
  expect(manifest.released_at).toBe(now.toISOString());
  expect(Date.parse(manifest.retention.expires_at)).toBe(now.getTime() + 3_600_000);
  expect(existsSync(payload)).toBe(true);
  expect(
    cleanArtifacts(root, { yes: true, now: new Date(now.getTime() + 59 * 60_000) })[0]?.action,
  ).toBe("keep");
  expect(
    cleanArtifacts(root, { yes: true, now: new Date(now.getTime() + 61 * 60_000) })[0]?.action,
  ).toBe("deleted");
});
test("discard never extends a sooner deadline, including repeat calls and already expired files", () => {
  for (const offset of [0, 31 * 60_000]) {
    const { root, unit, now } = fixture(30);
    const original = inventoryArtifacts(root, { now })[0]!.expires_at;
    for (const extra of [0, 60_000]) {
      const at = new Date(now.getTime() + offset + extra);
      discardArtifact(root, unit.manifest.artifact_id, "No longer needed", { now: at });
      expect(inventoryArtifacts(root, { now: at })[0]!.expires_at).toBe(original);
    }
  }
});
test("payload edits restart the shortened window and explicit renewal can rescue the files", () => {
  const { root, unit, payload, now } = fixture();
  discardArtifact(root, unit.manifest.artifact_id, "Superseded", { now });
  const later = new Date(now.getTime() + 30 * 60_000);
  utimesSync(payload, later, later);
  expect(Date.parse(inventoryArtifacts(root, { now: later })[0]!.expires_at!)).toBe(
    later.getTime() + 3_600_000,
  );
  const renewed = renewArtifact(root, unit.manifest.artifact_id, { minutes: 180 }, "Still needed", {
    now: later,
  });
  expect(Date.parse(renewed.retention.expires_at)).toBe(later.getTime() + 180 * 60_000);
});
test("held, tracked, symlinked and locked artifacts cannot be discarded; invalid durations write nothing", () => {
  for (const mode of ["held", "tracked", "symlink", "lock", "zero", "fraction", "reason"]) {
    const { root, unit, payload } = fixture();
    const ref = unit.manifest.artifact_id;
    if (mode === "held")
      holdArtifact(root, ref, {
        id: "review",
        reason: "User review",
        actor: { instance_id: "reviewer_1234" },
      });
    if (mode === "tracked") Bun.spawnSync(["git", "add", "-f", payload], { cwd: root });
    if (mode === "lock") mkdirSync(join(root, ".harnery/artifacts-mutation.lock"));
    const link = join(root, ".harnery/artifacts/link");
    if (mode === "symlink") symlinkSync(unit.path, link);
    const before = readFileSync(join(unit.path, ARTIFACT_MANIFEST), "utf8");
    expect(() =>
      discardArtifact(root, mode === "symlink" ? link : ref, mode === "reason" ? " " : "Reviewed", {
        minutes: mode === "zero" ? 0 : mode === "fraction" ? 0.5 : 60,
      }),
    ).toThrow();
    expect(readFileSync(join(unit.path, ARTIFACT_MANIFEST), "utf8")).toBe(before);
    expect(existsSync(payload)).toBe(true);
  }
});
test("a live owner may discard its own artifact, but another actor cannot", () => {
  const { root } = fixture();
  const actor = { instance_id: "agent_discard_owner" };
  initializeV3Fixture(root);
  seedV3Session(root, actor.instance_id);
  const unit = createArtifact(root, {
    slug: "owned",
    purpose: "evidence",
    retentionDays: 3,
    actor,
  });
  expect(() =>
    discardArtifact(root, unit.manifest.artifact_id, "Reviewed", {
      actor: { instance_id: "other_agent_123" },
    }),
  ).toThrow("fresh heartbeat");
  expect(
    discardArtifact(root, unit.manifest.artifact_id, "Reviewed", { actor }).released_by,
  ).toEqual(actor);
});
test("review guidance resolves the host command and states the review conditions", () => {
  const { root, unit } = fixture();
  writeFileSync(join(root, ".harnery/config.jsonc"), JSON.stringify({ binName: "sample" }));
  const advice = artifactReviewGuidance(root, unit.manifest.artifact_id);
  expect(advice).toContain("sample artifacts discard");
  expect(advice).toContain("no review, handoff, failure investigation, or final evidence depends");
});
