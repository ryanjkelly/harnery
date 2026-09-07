import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_DELIVERY_AUTO_ITEM_LIMIT,
  readArtifactDeliveryManifest,
  renderArtifactDeliveryCard,
  writeArtifactDeliveryManifest,
} from "./delivery-card.ts";
import { createArtifact } from "./index.ts";

describe("artifact delivery cards", () => {
  test("needs no manifest and inventories safe visible root items", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "harnery-delivery-card-auto-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: repoRoot });
    try {
      const created = createArtifact(repoRoot, {
        slug: "automatic-card",
        purpose: "Exercise automatic inventory",
        retentionDays: 3,
        id: "automatic-card-id",
      });
      mkdirSync(join(created.path, "frames"));
      writeFileSync(join(created.path, "report.json"), "{}");
      writeFileSync(join(created.path, ".private-note"), "hidden");

      const card = renderArtifactDeliveryCard(repoRoot, created.manifest.artifact_id, undefined, {
        platform: "linux",
        wslDistroName: "Test-Distro",
      });

      expect(card.markdown).toContain("### Artifact delivery");
      expect(card.markdown).toContain("[frames](<");
      expect(card.markdown).toContain("[report.json](<");
      expect(card.markdown.indexOf("[frames](<")).toBeLessThan(
        card.markdown.indexOf("[report.json](<"),
      );
      expect(card.markdown).not.toContain(".harnery-artifact.json");
      expect(card.markdown).not.toContain(".private-note");
      expect(card.auto_items).toBe(2);
      expect(card.omitted_auto_items).toBe(0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

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
      writeFileSync(join(created.path, "debug.json"), "{}");

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
        webPort: 5100,
        tunnelUrl: null,
      });
      expect(card.markdown).toContain("### Review files");
      expect(card.markdown).toContain("[Video](<https://media.example/video.mp4>)");
      expect(card.markdown).not.toContain("[https://media.example/video.mp4]");
      expect(card.markdown).toContain("\\\\wsl.localhost\\Test-Distro");
      expect(card.markdown).toContain("http://localhost:5100/browse?dir=");
      expect(card.markdown).toContain("http://localhost:5100/files?path=");
      expect(card.markdown).toContain("```text");
      expect(card.markdown).toContain("ARTIFACT FOLDER");
      expect(card.markdown).toContain("MOTION MAP");
      expect(card.markdown).not.toContain("debug.json");
      const [linkedList, plainText] = card.markdown.split("\n\n```text\n");
      expect(linkedList).not.toContain("\\\\wsl.localhost");
      expect(plainText).toContain("\\\\wsl.localhost\\Test-Distro");
      expect(card.auto_items).toBe(0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("ignores a same-port tunnel that does not serve the dashboard", () => {
    // A files tunnel and the dashboard tunnel can both forward to the web port
    // and be told apart only by Host. Publishing the files host here produced a
    // card whose every link returned HTTP 400, so the card must fall back to the
    // local dashboard URL rather than name a host that cannot answer its routes.
    const repoRoot = mkdtempSync(join(tmpdir(), "harnery-delivery-card-vhost-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: repoRoot });
    try {
      const created = createArtifact(repoRoot, {
        slug: "vhost-card",
        purpose: "Exercise same-port tunnels",
        retentionDays: 3,
        id: "vhost-card-id",
      });
      writeFileSync(join(created.path, "video.mp4"), "video");
      const tunnelDir = join(repoRoot, ".cache", "tunnel");
      mkdirSync(tunnelDir, { recursive: true });
      writeFileSync(
        join(tunnelDir, "state-harnery-files.json"),
        JSON.stringify({
          name: "harnery-files",
          provider: "cloudflare",
          url: "https://files.example/",
          gate_pid: process.pid,
          cloudflared_pid: process.pid,
          started_at: "2026-09-06T20:00:00.000Z",
          target: "127.0.0.1:4276",
          vhost: "harnery-files.localhost",
          gate_port: 9001,
        }),
      );

      const card = renderArtifactDeliveryCard(repoRoot, created.manifest.artifact_id, undefined, {
        platform: "linux",
        webPort: 4276,
      });

      expect(card.markdown).not.toContain("files.example");
      expect(card.markdown).toContain("[Artifact folder](<http://localhost:4276/browse?dir=");
      expect(card.markdown).toContain("[video.mp4](<http://localhost:4276/files?path=");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("uses a live tunnel base for every artifact path link", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "harnery-delivery-card-tunnel-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: repoRoot });
    try {
      const created = createArtifact(repoRoot, {
        slug: "tunnel-card",
        purpose: "Exercise public links",
        retentionDays: 3,
        id: "tunnel-card-id",
      });
      writeFileSync(join(created.path, "video.mp4"), "video");
      const tunnelDir = join(repoRoot, ".cache", "tunnel");
      mkdirSync(tunnelDir, { recursive: true });
      writeFileSync(
        join(tunnelDir, "state-harnery-web.json"),
        JSON.stringify({
          name: "harnery-web",
          provider: "cloudflare",
          url: "https://public.example/",
          gate_pid: process.pid,
          cloudflared_pid: process.pid,
          started_at: "2026-09-06T13:00:00.000Z",
          target: "127.0.0.1:4276",
          vhost: "localhost:4276",
          gate_port: 9001,
        }),
      );

      const card = renderArtifactDeliveryCard(repoRoot, created.manifest.artifact_id, undefined, {
        platform: "linux",
        webPort: 4276,
      });

      expect(card.markdown).toContain("[Artifact folder](<https://public.example/browse?dir=");
      expect(card.markdown).toContain("[video.mp4](<https://public.example/files?path=");
      expect(card.markdown).not.toContain("http://localhost:4276");
      expect(card.markdown).toContain("ARTIFACT FOLDER\n");
      expect(card.markdown).toContain("VIDEO.MP4\n");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("bounds automatic root inventory and reports omitted entries", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "harnery-delivery-card-bound-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: repoRoot });
    try {
      const created = createArtifact(repoRoot, {
        slug: "bounded-card",
        purpose: "Exercise output ceiling",
        retentionDays: 3,
        id: "bounded-card-id",
      });
      for (let index = 0; index < ARTIFACT_DELIVERY_AUTO_ITEM_LIMIT + 2; index += 1) {
        writeFileSync(join(created.path, `item-${String(index).padStart(3, "0")}.txt`), "file");
      }

      const card = renderArtifactDeliveryCard(repoRoot, created.manifest.artifact_id);
      expect(ARTIFACT_DELIVERY_AUTO_ITEM_LIMIT).toBe(5);
      expect(card.auto_items).toBe(ARTIFACT_DELIVERY_AUTO_ITEM_LIMIT);
      expect(card.omitted_auto_items).toBe(2);
      expect(card.markdown).toContain("**More root items:** 2 additional entries");
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
