import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarneryProgram, type EmitContext, loadLazyCommand } from "../commander.ts";
import { showArtifact } from "../core/artifacts/index.ts";

describe("artifacts command", () => {
  test("registers the managed artifact lifecycle", async () => {
    const program = createHarneryProgram();
    await loadLazyCommand(program, "artifacts");
    const command = program.commands.find((candidate) => candidate.name() === "artifacts");
    expect(command).toBeDefined();
    expect(command?.aliases()).toContain("artifact");
    expect(command?.commands.map((candidate) => candidate.name())).toEqual([
      "create",
      "adopt-unmanaged",
      "list",
      "show",
      "delivery-card",
      "renew",
      "release",
      "capabilities",
      "migrate",
      "hold",
      "unhold",
      "clean",
    ]);
  });

  test("stable binding owners can create and remove their own holds across CLI invocations", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "harnery-artifact-command-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: repoRoot });
    try {
      async function invoke(args: string[]) {
        const data: unknown[] = [];
        const errors: unknown[] = [];
        const exits: number[] = [];
        const texts: string[] = [];
        const emit: EmitContext = {
          config() {},
          data: (value) => {
            data.push(value);
          },
          rows() {},
          text: (value) => {
            texts.push(value);
          },
          file() {},
          error: (value) => {
            errors.push(value);
          },
          log() {},
          setExitCode: (value) => {
            exits.push(value);
          },
        };
        const program = createHarneryProgram({ context: { repoRoot }, emit });
        await program.parseAsync(["artifacts", ...args], { from: "user" });
        return { data, errors, exits, texts };
      }
      expect((await invoke(["capabilities", "--json"])).data[0]).toMatchObject({
        schema_version: 2,
        holds: true,
      });
      const created = await invoke([
        "create",
        "transfer",
        "--purpose",
        "pending",
        "--hold",
        "transfer-id",
        "--hold-reason",
        "pending upload",
        "--actor",
        "binding_first_123",
      ]);
      expect(created.errors).toEqual([]);
      const id = (created.data[0] as { artifact_id: string }).artifact_id;
      expect(
        (
          await invoke([
            "hold",
            id,
            "--id",
            "second-id",
            "--reason",
            "other job",
            "--actor",
            "binding_second_456",
          ])
        ).errors,
      ).toEqual([]);
      const refused = await invoke([
        "unhold",
        id,
        "--id",
        "transfer-id",
        "--actor",
        "binding_second_456",
      ]);
      expect(refused.exits).toEqual([1]);
      expect(showArtifact(repoRoot, id).manifest.holds).toHaveLength(2);
      expect(
        (await invoke(["unhold", id, "--id", "transfer-id", "--actor", "binding_first_123"]))
          .errors,
      ).toEqual([]);
      expect(showArtifact(repoRoot, id).manifest.holds.map((hold) => hold.id)).toEqual([
        "second-id",
      ]);

      const artifactPath = (created.data[0] as { path: string }).path;
      mkdirSync(join(artifactPath, "frames"));
      writeFileSync(join(artifactPath, "motion-map.png"), "image");
      const saved = await invoke([
        "delivery-card",
        id,
        "--title",
        "Review files",
        "--url",
        "Video=https://media.example/video.mp4",
        "--path",
        "Motion map=motion-map.png",
        "--path",
        "Frames=frames",
      ]);
      expect(saved.errors).toEqual([]);
      expect(saved.texts[0]).toContain("### Review files");
      expect(saved.texts[0]).toContain("https://media.example/video.mp4");
      expect(saved.texts[0]).toContain("ARTIFACT FOLDER");
      expect(saved.texts[0]).toContain("MOTION MAP");
      expect(saved.texts[0]).toContain("FRAMES");
      const reproduced = await invoke(["delivery-card", id]);
      expect(reproduced.errors).toEqual([]);
      expect(reproduced.texts).toEqual(saved.texts);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
