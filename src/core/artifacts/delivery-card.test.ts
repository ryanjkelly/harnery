import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readArtifactDeliveryManifest,
  renderArtifactDeliveryCard,
  writeArtifactDeliveryManifest,
} from "./delivery-card.ts";
import { createArtifact } from "./index.ts";

describe("artifact delivery cards", () => {
  test("persists destinations and renders WSL links plus copyable paths", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "harnery-delivery-card-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: repoRoot });
    try {
      const created = createArtifact(repoRoot, {
        slug: "video-review",
        purpose: "Review generated video",
        retentionDays: 3,
        id: "delivery-card-id",
      });
      mkdirSync(join(created.path, "frames"));
      writeFileSync(join(created.path, "motion-map.png"), "image");

      const manifest = writeArtifactDeliveryManifest(repoRoot, created.manifest.artifact_id, {
        title: "Review files",
        items: [
          { kind: "url", label: "Video", target: "https://media.example/video.mp4" },
          { kind: "path", label: "Motion map", path: "motion-map.png" },
          { kind: "path", label: "Frames", path: "frames" },
        ],
      });
      expect(readArtifactDeliveryManifest(repoRoot, created.manifest.artifact_id)).toEqual(
        manifest,
      );

      const card = renderArtifactDeliveryCard(repoRoot, created.manifest.artifact_id, manifest, {
        platform: "linux",
        wslDistroName: "Test-Distro",
      });
      expect(card.markdown).toContain("### Review files");
      expect(card.markdown).toContain("[https://media.example/video.mp4]");
      expect(card.markdown).toContain("\\\\wsl.localhost\\\\Test-Distro");
      expect(card.markdown).toContain("//wsl.localhost/Test-Distro/");
      expect(card.markdown).toContain("```text");
      expect(card.markdown).toContain("ARTIFACT FOLDER");
      expect(card.markdown).toContain("MOTION MAP");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("rejects missing, escaping, and duplicate destinations", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "harnery-delivery-card-invalid-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: repoRoot });
    try {
      const created = createArtifact(repoRoot, {
        slug: "invalid-card",
        purpose: "Exercise validation",
        retentionDays: 3,
        id: "invalid-card-id",
      });
      expect(() =>
        writeArtifactDeliveryManifest(repoRoot, created.manifest.artifact_id, {
          title: "Delivery",
          items: [{ kind: "path", label: "Missing", path: "missing.txt" }],
        }),
      ).toThrow("delivery path does not exist");
      expect(() =>
        writeArtifactDeliveryManifest(repoRoot, created.manifest.artifact_id, {
          title: "Delivery",
          items: [{ kind: "path", label: "Outside", path: "../outside.txt" }],
        }),
      ).toThrow("delivery path escapes the artifact folder");
      expect(() =>
        writeArtifactDeliveryManifest(repoRoot, created.manifest.artifact_id, {
          title: "Delivery",
          items: [
            { kind: "url", label: "Video", target: "https://media.example/one" },
            { kind: "url", label: "video", target: "https://media.example/two" },
          ],
        }),
      ).toThrow("duplicate delivery label");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
