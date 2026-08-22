import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentArtifactDirectories, artifactOwnerInstanceIds } from "./artifact-browser";

function workspace(root: string, name: string, manifest: unknown): void {
  const dir = join(root, ".harnery/artifacts", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".harnery-artifact.json"), JSON.stringify(manifest));
}

describe("agentArtifactDirectories", () => {
  test("returns the requested agent's workspaces newest first, skipping others", () => {
    const root = mkdtempSync(join(tmpdir(), "artifact-browser-"));
    workspace(root, "older", {
      created_by: { instance_id: "inst-a" },
      created_at: "2026-08-20T10:00:00.000Z",
    });
    workspace(root, "other-agent", {
      created_by: { instance_id: "inst-b" },
      created_at: "2026-08-22T10:00:00.000Z",
    });
    workspace(root, "newer", {
      created_by: { instance_id: "inst-a" },
      created_at: "2026-08-21T10:00:00.000Z",
    });
    // Unmanaged directory (no manifest) and a broken manifest are skipped.
    mkdirSync(join(root, ".harnery/artifacts", "unmanaged"), { recursive: true });
    const broken = join(root, ".harnery/artifacts", "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, ".harnery-artifact.json"), "not json");

    expect(agentArtifactDirectories(root, "inst-a")).toEqual([
      ".harnery/artifacts/newer",
      ".harnery/artifacts/older",
    ]);
    expect([...artifactOwnerInstanceIds(root)].sort()).toEqual(["inst-a", "inst-b"]);
  });

  test("returns an empty list when the artifact root is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "artifact-browser-empty-"));
    expect(agentArtifactDirectories(root, "inst-missing")).toEqual([]);
    expect(artifactOwnerInstanceIds(root).size).toBe(0);
  });
});
