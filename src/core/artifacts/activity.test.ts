import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_MANIFEST,
  cleanArtifacts,
  createArtifact,
  holdArtifact,
  inventoryArtifacts,
  migrateArtifacts,
  parseArtifactManifest,
  releaseArtifact,
  renewArtifact,
  repairArtifactActivity,
  unholdArtifact,
} from "./index.ts";

const roots: string[] = [];
const day = 86400000;
const actor = { instance_id: "activity_owner_123" };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harnery-activity-"));
  roots.push(root);
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  const at = new Date();
  const unit = createArtifact(root, {
    slug: "activity",
    purpose: "Retention regression",
    retentionDays: 3,
    now: at,
  });
  return { root, at, unit, manifest: join(unit.path, ARTIFACT_MANIFEST) };
}
function touchMetadata(path: string, at: Date) {
  utimesSync(join(path, ARTIFACT_MANIFEST), at, at);
  utimesSync(path, at, at);
}

test("release, holds, and their removal preserve expiry even when metadata timestamps advance", () => {
  const { root, at, unit } = fixture();
  const before = inventoryArtifacts(root)[0]!;
  const later = new Date(at.getTime() + 2 * day);
  releaseArtifact(root, unit.path, { now: later });
  holdArtifact(root, unit.path, { id: "review", reason: "Pending review", actor, now: later });
  touchMetadata(unit.path, later);
  expect(inventoryArtifacts(root, { now: later })[0]).toMatchObject({
    classification: "managed-held",
    expires_at: before.expires_at,
  });
  unholdArtifact(root, unit.path, "review", { actor, now: later });
  touchMetadata(unit.path, later);
  expect(inventoryArtifacts(root, { now: later })[0]?.expires_at).toBe(before.expires_at);
  expect(cleanArtifacts(root, { now: new Date(at.getTime() + 4 * day) })[0]?.action).toBe(
    "would-delete",
  );
  expect(existsSync(unit.path)).toBe(true);
});

test("payload edits, root deletions and renames, and nested deletions still renew activity", () => {
  const { root, at, unit } = fixture();
  const file = join(unit.path, "output.txt");
  writeFileSync(file, "output");
  releaseArtifact(root, unit.path);
  const changed = new Date(at.getTime() + day);
  utimesSync(file, changed, changed);
  const scan = () => inventoryArtifacts(root, { now: new Date(at.getTime() + 2 * day) })[0]!;
  expect(scan().last_modified_at).toBe(changed.toISOString());
  renameSync(file, join(unit.path, "renamed.txt"));
  const renamed = new Date(changed.getTime() + 1000);
  utimesSync(unit.path, renamed, renamed);
  expect(scan().last_modified_at).toBe(renamed.toISOString());
  releaseArtifact(root, unit.path, { now: new Date(at.getTime() + 2 * day) });
  rmSync(join(unit.path, "renamed.txt"));
  const deleted = new Date(renamed.getTime() + 1000);
  utimesSync(unit.path, deleted, deleted);
  expect(scan().last_modified_at).toBe(deleted.toISOString());
  const nested = join(unit.path, "nested");
  mkdirSync(nested);
  writeFileSync(join(nested, "payload"), "x");
  releaseArtifact(root, unit.path, { now: new Date(at.getTime() + 2 * day) });
  rmSync(join(nested, "payload"));
  const nestedDeleted = new Date(deleted.getTime() + 1000);
  utimesSync(nested, nestedDeleted, nestedDeleted);
  expect(scan().last_modified_at).toBe(nestedDeleted.toISOString());
});

test("explicit renewal remains authoritative and invalid activity is retained", () => {
  const { root, at, unit, manifest } = fixture();
  const later = new Date(at.getTime() + 5 * day);
  renewArtifact(root, unit.path, 30, "Preserve research evidence", { now: later });
  expect(inventoryArtifacts(root, { now: later })[0]?.expires_at).toBe(
    new Date(later.getTime() + 30 * day).toISOString(),
  );
  for (const activity of [null, {}, { last_changed_at: "bad", root_entries_sha256: "x" }]) {
    const value = { ...unit.manifest, activity };
    expect(parseArtifactManifest(value).ok).toBe(false);
    writeFileSync(manifest, JSON.stringify(value));
    expect(cleanArtifacts(root, { yes: true, now: later })[0]?.classification).toBe(
      "invalid-manifest",
    );
  }
  expect(existsSync(unit.path)).toBe(true);
});

test("migration preserves the effective deadline across a later metadata timestamp", () => {
  const { root, at, unit, manifest } = fixture();
  const { activity: _activity, holds: _holds, ...fields } = unit.manifest;
  writeFileSync(manifest, JSON.stringify({ ...fields, schema_version: 1 }));
  const originalStat = lstatSync(manifest);
  const originalLast = Math.max(
    at.getTime(),
    originalStat.mtimeMs,
    originalStat.ctimeMs,
    lstatSync(unit.path).mtimeMs,
  );
  const later = new Date(at.getTime() + 2 * day);
  expect(migrateArtifacts(root, { yes: true, now: later })[0]?.action).toBe("migrated");
  touchMetadata(unit.path, later);
  const entry = inventoryArtifacts(root, { now: later })[0]!;
  expect(Date.parse(entry.expires_at!)).toBeLessThanOrEqual(originalLast + 3 * day + 1);
  expect(cleanArtifacts(root, { now: new Date(at.getTime() + 4 * day) })[0]?.action).toBe(
    "would-delete",
  );
});

function legacyMigration(withPayload = false) {
  const f = fixture();
  if (withPayload) writeFileSync(join(f.unit.path, "payload.txt"), "retained output");
  const { activity: _activity, holds: _holds, ...fields } = f.unit.manifest;
  const old = {
    ...fields,
    schema_version: 1,
    created_at: new Date(f.at.getTime() - 10 * day).toISOString(),
    retention: { expires_at: new Date(f.at.getTime() - 7 * day).toISOString() },
  };
  const bytes = `${JSON.stringify(old, null, 2)}\n`;
  const folder = join(f.root, ".harnery/artifact-migrations");
  mkdirSync(folder);
  const preimage = join(folder, `${createHash("sha256").update(bytes).digest("hex")}.v1.json`);
  writeFileSync(preimage, bytes);
  const migrated = { ...old, schema_version: 2, holds: [] };
  // One filesystem transaction timestamp reproduces the old migration. A
  // mocked stat is unnecessary on the Linux filesystem used by the fixture.
  const tmp = join(f.unit.path, "migration.tmp");
  writeFileSync(tmp, JSON.stringify(migrated));
  renameSync(tmp, f.manifest);
  return { ...f, migrated, preimage };
}

test("repair previews without writes, preserves preimages and retention, and is idempotent", () => {
  const { root, unit, manifest } = legacyMigration();
  const before = readFileSync(manifest, "utf8");
  const stat = lstatSync(manifest);
  const preview = repairArtifactActivity(root)[0]!;
  expect(preview.action).toBe("would-repair");
  expect(Date.parse(preview.repaired_expires_at!)).toBeLessThan(Date.now());
  expect(readFileSync(manifest, "utf8")).toBe(before);
  expect(lstatSync(manifest).mtimeMs).toBe(stat.mtimeMs);
  const applied = repairArtifactActivity(root, { yes: true })[0]!;
  expect(applied.action).toBe("repaired");
  expect(JSON.parse(readFileSync(applied.receipt_path!, "utf8")).original_manifest).toBe(before);
  expect(inventoryArtifacts(root)[0]?.expires_at).toBe(preview.repaired_expires_at!);
  expect(existsSync(unit.path)).toBe(true);
  expect(repairArtifactActivity(root, { yes: true })[0]?.action).toBe("keep");
});

test("repair refuses later metadata, root changes, invalid preimages, and tracked payloads", () => {
  for (const change of ["hold", "root", "preimage", "tracked", "symlink"]) {
    const f = legacyMigration();
    if (change === "hold")
      writeFileSync(
        f.manifest,
        JSON.stringify({
          ...f.migrated,
          holds: [{ id: "review", reason: "pending", set_by: actor, set_at: f.at.toISOString() }],
        }),
      );
    if (change === "root")
      utimesSync(f.unit.path, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    if (change === "preimage") writeFileSync(f.preimage, "{}");
    if (change === "tracked")
      Bun.spawnSync(["git", "add", "-f", ".harnery/artifacts"], { cwd: f.root });
    if (change === "symlink") {
      rmSync(f.preimage);
      symlinkSync(f.manifest, f.preimage);
    }
    const before = readFileSync(f.manifest, "utf8");
    expect(repairArtifactActivity(f.root, { yes: true })[0]?.action).toBe("keep");
    expect(readFileSync(f.manifest, "utf8")).toBe(before);
  }
});

test("repair preserves later payload activity and fails closed on lock contention", () => {
  const f = legacyMigration(true);
  const later = new Date(f.at.getTime() + 9 * day);
  const now = new Date(f.at.getTime() + 10 * day);
  utimesSync(join(f.unit.path, "payload.txt"), later, later);
  const preview = repairArtifactActivity(f.root, { now })[0]!;
  expect(preview.action).toBe("would-repair");
  expect(preview.repaired_expires_at).toBe(new Date(later.getTime() + 3 * day).toISOString());
  const before = readFileSync(f.manifest, "utf8");
  const lock = join(f.root, ".harnery/artifacts-mutation.lock");
  mkdirSync(lock);
  expect(() => repairArtifactActivity(f.root, { yes: true, now })).toThrow("lock unavailable");
  expect(readFileSync(f.manifest, "utf8")).toBe(before);
  rmSync(lock, { recursive: true });
  expect(repairArtifactActivity(f.root, { yes: true, now })[0]?.action).toBe("repaired");
  expect(cleanArtifacts(f.root, { yes: true, now })[0]?.action).toBe("keep");
  expect(readFileSync(join(f.unit.path, "payload.txt"), "utf8")).toBe("retained output");
});
