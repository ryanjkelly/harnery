import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactHold } from "./index.ts";
import {
  ARTIFACT_MANIFEST,
  artifactCapabilities,
  artifactQuickUsage,
  artifactUsageReport,
  assertArtifactDiskFloor,
  autoCleanArtifacts,
  cleanArtifacts,
  createArtifact,
  holdArtifact,
  inventoryArtifacts,
  migrateArtifacts,
  parseArtifactManifest,
  releaseArtifact,
  renewArtifact,
  showArtifact,
  unholdArtifact,
} from "./index.ts";

const roots: string[] = [];
const owner = { instance_id: "binding_owner_123", session_id: "session_12345" };
const other = { instance_id: "binding_other_456" };
// Filesystem creation times are deliberately outside this historical clock.
const createdAt = new Date("2020-01-01T00:00:00.000Z");
const expiredAt = new Date("2020-01-10T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}
function at(days: number, base = createdAt): Date {
  return new Date(base.getTime() + days * DAY_MS);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
});
function repo() {
  const root = mkdtempSync(join(tmpdir(), "harnery-holds-"));
  roots.push(root);
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  return root;
}
function create(root: string, slug = "held", held = true, now = createdAt, retentionDays = 1) {
  return createArtifact(root, {
    slug,
    purpose: "Retain unsynchronized working files",
    retentionDays,
    now,
    actor: owner,
    holds: held ? [{ id: "transfer-123", reason: "pending handoff" }] : [],
  });
}

describe("artifact holds", () => {
  test("initial holds are persisted atomically and capabilities are machine readable", () => {
    const root = repo();
    const artifact = create(root);
    expect(artifactCapabilities()).toMatchObject({
      schema_version: 2,
      holds: true,
      atomic_create_holds: true,
      owner_scoped_unhold: true,
    });
    expect(JSON.parse(readFileSync(join(artifact.path, ARTIFACT_MANIFEST), "utf8"))).toEqual(
      artifact.manifest,
    );
    expect(artifact.manifest.holds).toEqual([
      {
        id: "transfer-123",
        reason: "pending handoff",
        set_by: owner,
        set_at: createdAt.toISOString(),
        expires_at: at(14).toISOString(),
      },
    ]);
    expect(() =>
      createArtifact(root, {
        slug: "invalid",
        purpose: "bad hold",
        retentionDays: 1,
        holds: [{ id: "x", reason: "pending" }],
      }),
    ).toThrow("actor");
    expect(inventoryArtifacts(root)).toHaveLength(1);
  });

  for (const automatic of [false, true]) {
    test(`${automatic ? "automatic" : "manual"} cleanup preserves expired inactive released holds and deletes control`, () => {
      const root = repo();
      const held = create(root);
      const control = create(root, "control", false);
      releaseArtifact(root, held.path, { now: createdAt });
      releaseArtifact(root, control.path, { now: createdAt });
      expect(
        inventoryArtifacts(root, { now: expiredAt }).find((row) => row.path === held.path)
          ?.classification,
      ).toBe("managed-held");
      if (automatic) expect(autoCleanArtifacts(root, { now: expiredAt }).deleted).toBe(1);
      else
        expect(
          cleanArtifacts(root, { yes: true, now: expiredAt }).filter(
            (row) => row.action === "deleted",
          ),
        ).toHaveLength(1);
      expect(existsSync(held.path)).toBe(true);
      expect(existsSync(control.path)).toBe(false);
    });
  }

  test("holds override both byte budgets", () => {
    const root = repo();
    mkdirSync(join(root, ".harnery"), { recursive: true });
    writeFileSync(
      join(root, ".harnery/config.jsonc"),
      JSON.stringify({ artifacts: { max_bytes: 67108864, max_unit_bytes: 16777216 } }),
    );
    const held = create(root, "held", true, new Date());
    const payload = join(held.path, "large.bin");
    writeFileSync(payload, "");
    truncateSync(payload, 80 * 1024 * 1024);
    expect(cleanArtifacts(root, { yes: true }).find((row) => row.path === held.path)).toMatchObject(
      { classification: "managed-held", action: "keep" },
    );
  });

  test("retries renew the original hold; renewal and release preserve all holds", () => {
    const root = repo();
    const artifact = create(root);
    const held = holdArtifact(root, artifact.path, {
      id: "transfer-123",
      reason: "pending handoff",
      actor: owner,
      now: at(1),
    });
    expect(held.holds).toEqual([
      { ...artifact.manifest.holds[0]!, expires_at: at(15).toISOString() },
    ]);
    holdArtifact(root, artifact.path, { id: "second-hold", reason: "other work", actor: other });
    expect(releaseArtifact(root, artifact.path).holds).toHaveLength(2);
    expect(renewArtifact(root, artifact.path, 3, "continued work").holds).toHaveLength(2);
    expect(() => unholdArtifact(root, artifact.path, "transfer-123", { actor: other })).toThrow(
      "only the hold owner",
    );
    expect(() =>
      holdArtifact(root, artifact.path, {
        id: "transfer-123",
        reason: "pending handoff",
        actor: other,
      }),
    ).toThrow("different owner");
    expect(() =>
      holdArtifact(root, artifact.path, { id: "transfer-123", reason: "changed", actor: owner }),
    ).toThrow("different owner or reason");
    const cleared = unholdArtifact(root, artifact.path, "transfer-123", {
      actor: { instance_id: owner.instance_id },
    });
    expect(cleared.holds.map((hold) => hold.id)).toEqual(["second-hold"]);
    expect(unholdArtifact(root, artifact.path, "transfer-123", { actor: owner })).toEqual(cleared);
    unholdArtifact(root, artifact.path, "second-hold", { actor: other });
    expect(showArtifact(root, artifact.path).manifest.holds).toEqual([]);
  });

  test("lock contention fails closed for cleanup and every manifest mutation", () => {
    const root = repo();
    const artifact = create(root, "control", false);
    const before = readFileSync(join(artifact.path, ARTIFACT_MANIFEST), "utf8");
    const lock = join(root, ".harnery/artifacts-mutation.lock");
    mkdirSync(lock);
    expect(cleanArtifacts(root, { yes: true, now: expiredAt })[0]?.action).toBe("keep");
    expect(() =>
      holdArtifact(root, artifact.path, { id: "locked", reason: "pending", actor: owner }),
    ).toThrow("lock unavailable");
    expect(() => unholdArtifact(root, artifact.path, "locked", { actor: owner })).toThrow(
      "lock unavailable",
    );
    expect(() => renewArtifact(root, artifact.path, 2, "renew")).toThrow("lock unavailable");
    expect(() => releaseArtifact(root, artifact.path)).toThrow("lock unavailable");
    expect(() => create(root, "another")).toThrow("lock unavailable");
    expect(readFileSync(join(artifact.path, ARTIFACT_MANIFEST), "utf8")).toBe(before);
    rmSync(lock, { recursive: true });
    holdArtifact(root, artifact.path, { id: "locked", reason: "pending", actor: owner });
    expect(cleanArtifacts(root, { yes: true, now: expiredAt })[0]?.classification).toBe(
      "managed-held",
    );
  });

  test("malformed holds and symlink manifests are retained and cannot be mutated", () => {
    const root = repo();
    const artifact = create(root);
    for (const holds of [
      undefined,
      null,
      {},
      [{}],
      [artifact.manifest.holds[0], artifact.manifest.holds[0]],
    ]) {
      const malformed = { ...artifact.manifest, holds };
      expect(parseArtifactManifest(malformed).ok).toBe(false);
      writeFileSync(join(artifact.path, ARTIFACT_MANIFEST), JSON.stringify(malformed));
      expect(cleanArtifacts(root, { yes: true, now: expiredAt })[0]?.action).toBe("keep");
      expect(() => releaseArtifact(root, artifact.path)).toThrow("invalid holds");
    }
    const target = join(root, "external.json");
    writeFileSync(target, JSON.stringify(artifact.manifest));
    rmSync(join(artifact.path, ARTIFACT_MANIFEST));
    symlinkSync(target, join(artifact.path, ARTIFACT_MANIFEST));
    expect(() => unholdArtifact(root, artifact.path, "transfer-123", { actor: owner })).toThrow(
      "regular file",
    );
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(artifact.manifest);
  });
});

describe("explicit artifact migration", () => {
  function legacy(root: string) {
    const artifact = create(root, "legacy", false);
    const { holds: _holds, activity: _activity, ...fields } = artifact.manifest;
    const value = {
      ...fields,
      schema_version: 1,
      released_at: createdAt.toISOString(),
      oversize_acknowledged: true,
    };
    const bytes = `${JSON.stringify(value, null, 4)}\n`;
    writeFileSync(join(artifact.path, ARTIFACT_MANIFEST), bytes);
    return { ...artifact, value, bytes };
  }
  test("dry run is read-only; apply preserves preimage, identity and retention; repeat is inert", () => {
    const root = repo();
    const artifact = legacy(root);
    expect(cleanArtifacts(root, { yes: true, now: expiredAt })[0]?.classification).toBe(
      "invalid-manifest",
    );
    expect(() =>
      holdArtifact(root, artifact.path, { id: "pending", reason: "pending", actor: owner }),
    ).toThrow("unsupported schema_version 1");
    const preview = migrateArtifacts(root);
    expect(preview[0]?.action).toBe("would-migrate");
    expect(existsSync(preview[0]!.preimage_path!)).toBe(false);
    expect(readFileSync(join(artifact.path, ARTIFACT_MANIFEST), "utf8")).toBe(artifact.bytes);
    const applied = migrateArtifacts(root, { yes: true });
    expect(applied[0]?.action).toBe("migrated");
    expect(readFileSync(applied[0]!.preimage_path!, "utf8")).toBe(artifact.bytes);
    expect(showArtifact(root, artifact.path).manifest).toMatchObject({
      ...artifact.value,
      schema_version: 2,
      holds: [],
    });
    expect(migrateArtifacts(root, { yes: true })[0]?.action).toBe("keep");
  });
  test("invalid, future, and unexpected v1 holds are never rewritten", () => {
    const root = repo();
    const artifact = legacy(root);
    for (const value of [
      { ...artifact.value, schema_version: 99 },
      { ...artifact.value, holds: [] },
      { ...artifact.value, purpose: "" },
    ]) {
      const bytes = JSON.stringify(value);
      writeFileSync(join(artifact.path, ARTIFACT_MANIFEST), bytes);
      expect(migrateArtifacts(root, { yes: true })[0]?.action).toBe("keep");
      expect(readFileSync(join(artifact.path, ARTIFACT_MANIFEST), "utf8")).toBe(bytes);
    }
  });
  test("preimage failure prevents manifest replacement", () => {
    const root = repo();
    const artifact = legacy(root);
    writeFileSync(join(root, ".harnery/artifact-migrations"), "blocked");
    expect(migrateArtifacts(root, { yes: true })[0]?.action).toBe("keep");
    expect(readFileSync(join(artifact.path, ARTIFACT_MANIFEST), "utf8")).toBe(artifact.bytes);
  });
});

describe("hold expiry", () => {
  test("holds expire after the configured default, --days, or --minutes", () => {
    const root = repo();
    const artifact = create(root);
    expect(artifact.manifest.holds[0]?.expires_at).toBe(at(14).toISOString());
    const days = holdArtifact(root, artifact.path, {
      id: "short",
      reason: "brief review",
      actor: owner,
      days: 3,
      now: createdAt,
    });
    expect(days.holds.find((hold) => hold.id === "short")?.expires_at).toBe(at(3).toISOString());
    const minutes = holdArtifact(root, artifact.path, {
      id: "minutes",
      reason: "quick check",
      actor: owner,
      minutes: 90,
      now: createdAt,
    });
    expect(minutes.holds.find((hold) => hold.id === "minutes")?.expires_at).toBe(
      new Date(createdAt.getTime() + 90 * 60_000).toISOString(),
    );
    setEnv("HARNERY_ARTIFACT_HOLD_DAYS", "2");
    expect(create(root, "configured").manifest.holds[0]?.expires_at).toBe(at(2).toISOString());
    for (const bad of [{ days: 0 }, { days: 366 }, { minutes: 0 }, { days: 1, minutes: 1 }])
      expect(() =>
        holdArtifact(root, artifact.path, { id: "bad", reason: "bad", actor: owner, ...bad }),
      ).toThrow();
  });

  test("re-holding with the same id and reason renews; another owner or reason still fails", () => {
    const root = repo();
    const artifact = create(root);
    const renewed = holdArtifact(root, artifact.path, {
      id: "transfer-123",
      reason: "pending handoff",
      actor: owner,
      now: at(10),
    });
    expect(renewed.holds[0]).toMatchObject({
      set_at: createdAt.toISOString(),
      expires_at: at(24).toISOString(),
    });
    expect(inventoryArtifacts(root, { now: at(20) })[0]?.classification).toBe("managed-held");
    expect(() =>
      holdArtifact(root, artifact.path, { id: "transfer-123", reason: "other", actor: owner }),
    ).toThrow("different owner or reason");
  });

  test("a lapsed hold returns the workspace to retention, anchored at the lapse", () => {
    const root = repo();
    const artifact = create(root);
    releaseArtifact(root, artifact.path, { now: createdAt });
    expect(inventoryArtifacts(root, { now: at(13) })[0]?.classification).toBe("managed-held");
    const lapsed = inventoryArtifacts(root, { now: at(14.5) })[0];
    expect(lapsed).toMatchObject({
      classification: "managed-expired",
      action: "would-delete",
      expires_at: at(14).toISOString(),
    });
    expect(lapsed?.reason).toContain(`transfer-123 lapsed at ${at(14).toISOString()}`);
    // The lapsed hold stays recorded; re-holding renews it and protects again.
    expect(showArtifact(root, artifact.path).manifest.holds).toHaveLength(1);
    holdArtifact(root, artifact.path, {
      id: "transfer-123",
      reason: "pending handoff",
      actor: owner,
      now: at(14.5),
    });
    expect(inventoryArtifacts(root, { now: at(15) })[0]?.classification).toBe("managed-held");

    const longer = create(root, "longer", true, createdAt, 30);
    releaseArtifact(root, longer.path, { now: createdAt });
    expect(
      inventoryArtifacts(root, { now: at(20) }).find((row) => row.path === longer.path),
    ).toMatchObject({ classification: "managed-current", expires_at: at(30).toISOString() });
    expect(
      cleanArtifacts(root, { yes: true, now: at(40) }).find((row) => row.path === longer.path)
        ?.action,
    ).toBe("deleted");
    expect(existsSync(longer.path)).toBe(false);
  });

  test("a hold recorded before expiry existed stays in force and warns", () => {
    const root = repo();
    const artifact = create(root);
    const { expires_at: _expires, ...legacy } = artifact.manifest.holds[0]!;
    writeFileSync(
      join(artifact.path, ARTIFACT_MANIFEST),
      JSON.stringify({ ...artifact.manifest, holds: [legacy] }),
    );
    const row = inventoryArtifacts(root, { now: at(1000) })[0];
    expect(row?.classification).toBe("managed-held");
    expect(row?.warning).toContain("has no expiry");
    expect(row?.warning).toContain(`artifacts hold ${row?.name} --id transfer-123`);
    const renewed = holdArtifact(root, artifact.path, {
      id: "transfer-123",
      reason: "pending handoff",
      actor: owner,
      now: at(1000),
    });
    expect(renewed.holds[0]?.expires_at).toBe(at(1014).toISOString());
  });

  test("a persistent hold never lapses and stays persistent when repeated", () => {
    const root = repo();
    const artifact = create(root, "lease", false);
    const held = holdArtifact(root, artifact.path, {
      id: "open-checkout",
      reason: "unsynchronized changes",
      actor: owner,
      persistent: true,
      now: createdAt,
    });
    expect(held.holds[0]).toMatchObject({ persistent: true });
    expect(held.holds[0]?.expires_at).toBeUndefined();
    const row = inventoryArtifacts(root, { now: at(3000) })[0];
    expect(row).toMatchObject({ classification: "managed-held", warning: null });
    const repeated = holdArtifact(root, artifact.path, {
      id: "open-checkout",
      reason: "unsynchronized changes",
      actor: owner,
      now: at(3000),
    });
    expect(repeated.holds[0]).toEqual(held.holds[0]!);
    expect(() =>
      holdArtifact(root, artifact.path, {
        id: "other",
        reason: "x",
        actor: owner,
        persistent: true,
        days: 2,
      }),
    ).toThrow("persistent");
    const both: ArtifactHold = { ...held.holds[0]!, expires_at: at(1).toISOString() };
    expect(parseArtifactManifest({ ...artifact.manifest, holds: [both] }).ok).toBe(false);
  });

  test("a hold lapsing within 48 hours carries a renewal warning", () => {
    const root = repo();
    create(root);
    expect(inventoryArtifacts(root, { now: at(10) })[0]?.warning).toBeNull();
    const row = inventoryArtifacts(root, { now: at(12.1) })[0];
    expect(row?.warning).toContain(`hold transfer-123 lapses at ${at(14).toISOString()}`);
    expect(row?.warning).toContain(
      `artifacts hold ${row?.name} --id transfer-123 --reason "pending handoff"`,
    );
    expect(artifactCapabilities()).toMatchObject({
      hold_expiry: true,
      held_budget: true,
      disk_free_report: true,
    });
  });
});

describe("held budget and free disk", () => {
  test("held bytes over budget warn, list the largest holds, and never delete", () => {
    const root = repo();
    setEnv("HARNERY_ARTIFACT_MAX_HELD_BYTES", String(64 * 1024 * 1024));
    setEnv("HARNERY_ARTIFACT_MIN_FREE_BYTES", "0");
    const held = create(root, "held", true, new Date());
    writeFileSync(join(held.path, "payload.bin"), Buffer.alloc(66 * 1024 * 1024, 1));
    const rows = cleanArtifacts(root, { yes: true });
    expect(rows[0]).toMatchObject({ classification: "managed-held", action: "keep" });
    const report = artifactUsageReport(root, rows);
    expect(report.held_over_budget).toBe(true);
    expect(report.held_bytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(report.largest_holds[0]).toMatchObject({
      name: rows[0]!.name,
      holds: [{ id: "transfer-123", set_by: owner.instance_id, persistent: false }],
    });
    expect(report.warnings[0]).toContain("never deleted automatically");
    expect(report.warnings[0]).toContain(rows[0]!.name);
    expect(report.low_disk).toBe(false);
    expect(existsSync(held.path)).toBe(true);

    // The inventory recorded its measurement; the cheap path reads it back.
    const cache = JSON.parse(readFileSync(join(root, ".harnery/artifact-usage.json"), "utf8"));
    expect(cache.held_bytes).toBe(report.held_bytes);
    const quick = artifactQuickUsage(root);
    expect(quick.usage).toMatchObject({
      held_bytes: report.held_bytes,
      held_measured_at: cache.measured_at,
    });
    expect(quick.warnings[0]).toContain("held budget");
  });

  test("free disk below the floor is reported and refuses large work", () => {
    const root = repo();
    create(root, "plain", false, new Date());
    setEnv("HARNERY_ARTIFACT_MIN_FREE_BYTES", String(1024 ** 5));
    const report = artifactUsageReport(root, inventoryArtifacts(root));
    expect(report.free_bytes).toBeGreaterThan(0);
    expect(report.low_disk).toBe(true);
    expect(report.warnings.join(" ")).toContain("artifacts.min_free_bytes");
    expect(artifactQuickUsage(root).low_disk).toBe(true);
    expect(() => assertArtifactDiskFloor(root)).toThrow("--allow-low-disk");
    setEnv("HARNERY_ARTIFACT_MIN_FREE_BYTES", "0");
    expect(() => assertArtifactDiskFloor(root)).not.toThrow();
  });
});
