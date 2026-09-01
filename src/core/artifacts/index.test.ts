import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../tests/helpers/event-v3-runtime.ts";
import {
  ARTIFACT_MANIFEST,
  adoptUnmanagedArtifactFiles,
  artifactsRoot,
  cleanArtifacts,
  createArtifact,
  inventoryArtifacts,
  releaseArtifact,
  renewArtifact,
} from "./index.ts";

const roots: string[] = [];
const now = new Date("2026-07-26T12:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "harnery-artifacts-"));
  roots.push(path);
  Bun.spawnSync(["git", "init", "-q"], { cwd: path });
  return path;
}

describe("managed artifacts", () => {
  test("creates a collision-safe unit with an atomic, versioned manifest", () => {
    const repo = root();
    const created = createArtifact(repo, {
      slug: "Theme Audit",
      purpose: "Compare page screenshots",
      retentionDays: 3,
      now,
      id: "artifact_12345678",
      actor: { instance_id: "agent_12345678", session_id: "session_12345678", name: "Nico" },
    });
    expect(created.path).toEndWith("2026-07-26_theme-audit_artifact");
    expect(JSON.parse(readFileSync(join(created.path, ARTIFACT_MANIFEST), "utf8"))).toEqual(
      created.manifest,
    );
    expect(created.manifest.retention.expires_at).toBe("2026-07-29T12:00:00.000Z");
  });

  test("rejects slugs that normalize to empty", () => {
    const repo = root();
    expect(() =>
      createArtifact(repo, {
        slug: "!!!",
        purpose: "Invalid workspace name",
        retentionDays: 3,
        now,
      }),
    ).toThrow("slug must contain at least one ASCII letter or digit");
  });

  test("requires retention to use whole days", () => {
    const repo = root();
    expect(() =>
      createArtifact(repo, {
        slug: "fractional",
        purpose: "Invalid retention",
        retentionDays: 0.5,
        now,
      }),
    ).toThrow("retention days must be between 1 and 3650");
  });

  test("keeps an expired artifact while its owner has a live V3 generation", () => {
    const repo = root();
    createArtifact(repo, {
      slug: "capture",
      purpose: "Browser capture",
      retentionDays: 1,
      now: new Date("2026-07-20T12:00:00.000Z"),
      id: "artifact_abcdefgh",
      actor: { instance_id: "agent_abcdefgh" },
    });
    initializeV3Fixture(repo);
    seedV3Session(repo, "agent_abcdefgh");
    expect(inventoryArtifacts(repo, { now })[0]?.classification).toBe("managed-active");
  });

  test("release removes active protection but not retention", () => {
    const repo = root();
    const created = createArtifact(repo, {
      slug: "capture",
      purpose: "Browser capture",
      retentionDays: 1,
      now: new Date("2026-07-20T12:00:00.000Z"),
      id: "artifact_release1",
      actor: { instance_id: "agent_release1" },
    });
    initializeV3Fixture(repo);
    seedV3Session(repo, "agent_release1");
    releaseArtifact(repo, created.manifest.artifact_id, { now });
    expect(inventoryArtifacts(repo, { now })[0]?.classification).toBe("managed-expired");
  });

  test("renewal writes an explicit future expiry and reason", () => {
    const repo = root();
    const created = createArtifact(repo, {
      slug: "rollback",
      purpose: "Short rollback window",
      retentionDays: 1,
      now,
      id: "artifact_renew123",
    });
    const renewed = renewArtifact(repo, created.manifest.artifact_id, 7, "keep through soak", {
      now,
    });
    expect(renewed.retention).toEqual({
      expires_at: "2026-08-02T12:00:00.000Z",
      renewed_at: now.toISOString(),
      reason: "keep through soak",
    });
  });

  test("resets expiration from the newest artifact change", () => {
    const repo = root();
    const created = createArtifact(repo, {
      slug: "rolling",
      purpose: "Active working files",
      retentionDays: 3,
      now: new Date("2026-07-20T12:00:00.000Z"),
      id: "artifact_rolling1",
    });
    const payload = join(created.path, "payload.txt");
    writeFileSync(payload, "updated");
    const changedAt = new Date("2026-07-25T09:30:00.000Z");
    utimesSync(payload, changedAt, changedAt);

    const entry = inventoryArtifacts(repo, { now })[0];
    expect(entry?.classification).toBe("managed-current");
    expect(entry?.last_modified_at).toBe(changedAt.toISOString());
    expect(entry?.expires_at).toBe("2026-07-28T09:30:00.000Z");
  });

  test("expires after one full retention window without another change", () => {
    const repo = root();
    const created = createArtifact(repo, {
      slug: "rolling-expired",
      purpose: "Finished working files",
      retentionDays: 3,
      now: new Date("2026-07-20T12:00:00.000Z"),
      id: "artifact_rolling2",
    });
    const changedAt = new Date("2026-07-22T08:00:00.000Z");
    writeFileSync(join(created.path, "payload.txt"), "done");
    utimesSync(join(created.path, "payload.txt"), changedAt, changedAt);

    const entry = inventoryArtifacts(repo, {
      now: new Date("2026-07-25T08:00:00.001Z"),
    })[0];
    expect(entry?.classification).toBe("managed-expired");
    expect(entry?.expires_at).toBe("2026-07-25T08:00:00.000Z");
  });

  test("clean previews by default and deletes only with yes", () => {
    const repo = root();
    const created = createArtifact(repo, {
      slug: "expired",
      purpose: "Expired output",
      retentionDays: 1,
      now: new Date("2026-07-20T12:00:00.000Z"),
      id: "artifact_expired1",
    });
    writeFileSync(join(created.path, "payload.txt"), "data");
    expect(cleanArtifacts(repo, { now })[0]?.action).toBe("would-delete");
    expect(cleanArtifacts(repo, { yes: true, now })[0]?.action).toBe("deleted");
    expect(inventoryArtifacts(repo, { now })).toEqual([]);
  });

  test("requires --big acknowledgement above the per-bundle ceiling", () => {
    const repo = root();
    const saved = process.env.HARNERY_ARTIFACT_MAX_UNIT_BYTES;
    process.env.HARNERY_ARTIFACT_MAX_UNIT_BYTES = String(16 * 1024 * 1024);
    try {
      const ordinary = createArtifact(repo, {
        slug: "ordinary-large",
        purpose: "Unacknowledged large output",
        retentionDays: 3,
        now,
        id: "artifact_largeordinary",
      });
      writeFileSync(join(ordinary.path, "payload.bin"), "");
      truncateSync(join(ordinary.path, "payload.bin"), 17 * 1024 * 1024);
      const acknowledged = createArtifact(repo, {
        slug: "expected-large",
        purpose: "Expected large output",
        retentionDays: 3,
        now,
        id: "artifact_largeexpected",
        big: true,
      });
      writeFileSync(join(acknowledged.path, "payload.bin"), "");
      truncateSync(join(acknowledged.path, "payload.bin"), 17 * 1024 * 1024);

      const rows = inventoryArtifacts(repo, { now: new Date() });
      expect(rows.find((row) => row.artifact_id === ordinary.manifest.artifact_id)).toMatchObject({
        classification: "managed-oversize",
        action: "would-delete",
        oversize_acknowledged: false,
      });
      expect(
        rows.find((row) => row.artifact_id === acknowledged.manifest.artifact_id),
      ).toMatchObject({
        classification: "managed-current",
        action: "keep",
        oversize_acknowledged: true,
      });
    } finally {
      if (saved === undefined) delete process.env.HARNERY_ARTIFACT_MAX_UNIT_BYTES;
      else process.env.HARNERY_ARTIFACT_MAX_UNIT_BYTES = saved;
    }
  });

  test("plans earliest-expiring inactive bundles until the repository fits its byte budget", () => {
    const repo = root();
    const saved = process.env.HARNERY_ARTIFACT_MAX_BYTES;
    process.env.HARNERY_ARTIFACT_MAX_BYTES = String(64 * 1024 * 1024);
    try {
      const early = createArtifact(repo, {
        slug: "early",
        purpose: "Expires first",
        retentionDays: 2,
        now,
        id: "artifact_budgetearly",
        big: true,
      });
      const late = createArtifact(repo, {
        slug: "late",
        purpose: "Expires later",
        retentionDays: 5,
        now,
        id: "artifact_budgetlate",
        big: true,
      });
      writeFileSync(join(early.path, "payload.bin"), "");
      truncateSync(join(early.path, "payload.bin"), 40 * 1024 * 1024);
      writeFileSync(join(late.path, "payload.bin"), "");
      truncateSync(join(late.path, "payload.bin"), 40 * 1024 * 1024);

      const rows = inventoryArtifacts(repo, { now: new Date() });
      expect(rows.find((row) => row.artifact_id === early.manifest.artifact_id)).toMatchObject({
        classification: "managed-over-budget",
        action: "would-delete",
      });
      expect(rows.find((row) => row.artifact_id === late.manifest.artifact_id)).toMatchObject({
        classification: "managed-current",
        action: "keep",
      });
    } finally {
      if (saved === undefined) delete process.env.HARNERY_ARTIFACT_MAX_BYTES;
      else process.env.HARNERY_ARTIFACT_MAX_BYTES = saved;
    }
  });

  test("protects unmanaged, invalid, symlinked, and current entries", () => {
    const repo = root();
    const workspace = artifactsRoot(repo);
    mkdirSync(join(workspace, "unmanaged"), { recursive: true });
    mkdirSync(join(workspace, "invalid"), { recursive: true });
    writeFileSync(join(workspace, "invalid", ARTIFACT_MANIFEST), "{");
    symlinkSync(tmpdir(), join(workspace, "link"));
    createArtifact(repo, {
      slug: "current",
      purpose: "Current output",
      retentionDays: 3,
      now,
      id: "artifact_current1",
    });
    const classes = inventoryArtifacts(repo, { now }).map((entry) => entry.classification);
    expect(classes).toEqual(["managed-current", "invalid-manifest", "symlink", "unmanaged"]);
    expect(cleanArtifacts(repo, { yes: true, now }).every((entry) => entry.action === "keep")).toBe(
      true,
    );
  });

  test("previews loose files and adopts untracked legacy directories in place", () => {
    const repo = root();
    const workspace = artifactsRoot(repo);
    mkdirSync(join(workspace, "legacy-directory"), { recursive: true });
    writeFileSync(join(workspace, "legacy-directory", "keep.txt"), "keep");
    writeFileSync(join(workspace, "loose-one.bin"), "one");
    writeFileSync(join(workspace, "loose-two.bin"), "two");

    const preview = adoptUnmanagedArtifactFiles(repo, {
      purpose: "Adopt old loose files",
      retentionDays: 3,
      now,
    });
    expect(preview.candidates.map((row) => [row.name, row.kind])).toEqual([
      ["legacy-directory", "directory"],
      ["loose-one.bin", "file"],
      ["loose-two.bin", "file"],
    ]);
    expect(preview.adopted_artifact_id).toBeNull();

    const adopted = adoptUnmanagedArtifactFiles(repo, {
      yes: true,
      purpose: "Adopt old loose files",
      retentionDays: 3,
      now,
    });
    expect(adopted.adopted_artifact_id).not.toBeNull();
    expect(readFileSync(join(adopted.adopted_path!, "loose-one.bin"), "utf8")).toBe("one");
    expect(readFileSync(join(workspace, "legacy-directory", "keep.txt"), "utf8")).toBe("keep");
    expect(adopted.adopted_directories).toBe(1);
    expect(existsSync(join(workspace, "legacy-directory", ARTIFACT_MANIFEST))).toBe(true);
  });

  test("protects force-tracked content inside an expired artifact", () => {
    const repo = root();
    const created = createArtifact(repo, {
      slug: "tracked",
      purpose: "Tracked by mistake",
      retentionDays: 1,
      now: new Date("2026-07-20T12:00:00.000Z"),
      id: "artifact_tracked1",
    });
    writeFileSync(join(created.path, "payload.txt"), "tracked");
    Bun.spawnSync(["git", "add", "-f", created.path], { cwd: repo });
    expect(inventoryArtifacts(repo, { now })[0]?.classification).toBe("managed-tracked");
  });

  test("deleting an expired unit unlinks nested symlinks without following them", () => {
    const repo = root();
    const outside = join(repo, "outside.txt");
    writeFileSync(outside, "must survive");
    const created = createArtifact(repo, {
      slug: "linked",
      purpose: "Contains a link",
      retentionDays: 1,
      now: new Date("2026-07-20T12:00:00.000Z"),
      id: "artifact_linked12",
    });
    symlinkSync(outside, join(created.path, "outside-link"));
    expect(cleanArtifacts(repo, { yes: true, now })[0]?.action).toBe("deleted");
    expect(readFileSync(outside, "utf8")).toBe("must survive");
  });
});
