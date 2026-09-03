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
import {
  ARTIFACT_MANIFEST,
  artifactCapabilities,
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
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repo() {
  const root = mkdtempSync(join(tmpdir(), "harnery-holds-"));
  roots.push(root);
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  return root;
}
function create(root: string, slug = "held", held = true) {
  return createArtifact(root, {
    slug,
    purpose: "Retain unsynchronized working files",
    retentionDays: 1,
    now: createdAt,
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
    const held = create(root);
    const payload = join(held.path, "large.bin");
    writeFileSync(payload, "");
    truncateSync(payload, 80 * 1024 * 1024);
    expect(cleanArtifacts(root, { yes: true }).find((row) => row.path === held.path)).toMatchObject(
      { classification: "managed-held", action: "keep" },
    );
  });

  test("retries preserve original hold; renewal and release preserve all holds", () => {
    const root = repo();
    const artifact = create(root);
    const held = holdArtifact(root, artifact.path, {
      id: "transfer-123",
      reason: "pending handoff",
      actor: owner,
    });
    expect(held.holds).toEqual(artifact.manifest.holds);
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
    const { holds: _holds, ...fields } = artifact.manifest;
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
    expect(showArtifact(root, artifact.path).manifest).toEqual({
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
