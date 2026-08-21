import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../tests/helpers/event-v3-runtime.ts";
import {
  ARTIFACT_MANIFEST,
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
