import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarneryProgram, type EmitContext, loadLazyCommand } from "../commander.ts";
import { type ArtifactManifestV2, showArtifact } from "../core/artifacts/index.ts";

describe("artifacts command", () => {
  test("minute durations and reviewed discard are available through the CLI with strict validation", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "harnery-artifact-duration-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: repoRoot });
    try {
      const invoke = async (args: string[]) => {
        const data: Record<string, unknown>[] = [];
        const errors: unknown[] = [];
        const program = createHarneryProgram({
          context: { repoRoot },
          emit: {
            config() {},
            data: (value) => {
              data.push(value as Record<string, unknown>);
            },
            rows() {},
            text() {},
            file() {},
            log() {},
            error: (value) => {
              errors.push(value);
            },
            setExitCode() {},
          },
        });
        await program.parseAsync(["artifacts", ...args], { from: "user" });
        return { data, errors };
      };
      const created = await invoke([
        "create",
        "short",
        "--purpose",
        "Temporary",
        "--minutes",
        "90",
      ]);
      expect(created.errors).toEqual([]);
      const id = created.data[0].artifact_id as string;
      const manifest = showArtifact(repoRoot, id).manifest;
      expect(Date.parse(manifest.retention.expires_at) - Date.parse(manifest.created_at)).toBe(
        90 * 60_000,
      );
      expect(created.data[0].after_review).toContain("artifacts discard");
      const released = await invoke(["release", id]);
      expect(released.errors).toEqual([]);
      expect(released.data[0].after_review).toContain("artifacts discard");
      expect(released.data[0].retention).toEqual(manifest.retention);
      expect(released.data[0].released_at).toBeDefined();
      expect(
        (await invoke(["renew", id, "--minutes", "120", "--reason", "Pending"])).errors,
      ).toEqual([]);
      const discarded = await invoke(["discard", id, "--minutes", "15", "--reason", "Reviewed"]);
      expect(discarded.errors).toEqual([]);
      expect(discarded.data[0].deleted).toBe(false);
      const retired = discarded.data[0].manifest as ArtifactManifestV2;
      expect(
        Date.parse(retired.retention.expires_at) - Date.parse(retired.retention.renewed_at!),
      ).toBe(15 * 60_000);
      for (const args of [
        ["create", "bad", "--purpose", "bad", "--minutes", "0"],
        ["create", "bad", "--purpose", "bad", "--minutes", "1", "--days", "1"],
        ["renew", id, "--reason", "bad"],
        ["renew", id, "--reason", "bad", "--days", "1", "--minutes", "1"],
        ["discard", id, "--reason", "bad", "--minutes", "0.5"],
      ])
        expect((await invoke(args)).errors).toHaveLength(1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
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
      "allow-big",
      "release",
      "discard",
      "remove",
      "capabilities",
      "migrate",
      "repair-activity",
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
      writeFileSync(join(artifactPath, "debug.json"), "{}");
      const automatic = await invoke(["delivery-card", id]);
      expect(automatic.errors).toEqual([]);
      expect(automatic.texts[0]).toContain("[frames](");
      expect(automatic.texts[0]).toContain("[motion-map.png](");
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
      expect(saved.texts[0]).not.toContain("debug.json");
      const reproduced = await invoke(["delivery-card", id]);
      expect(reproduced.errors).toEqual([]);
      expect(reproduced.texts).toEqual(saved.texts);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("create --big refuses below the free-disk floor unless --allow-low-disk; hold takes --days", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "harnery-artifact-disk-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: repoRoot });
    const saved = process.env.HARNERY_ARTIFACT_MIN_FREE_BYTES;
    process.env.HARNERY_ARTIFACT_MIN_FREE_BYTES = String(1024 ** 5);
    try {
      const invoke = async (args: string[]) => {
        const data: Record<string, unknown>[] = [];
        const errors: { message?: string }[] = [];
        const logs: string[] = [];
        const program = createHarneryProgram({
          context: { repoRoot },
          emit: {
            config() {},
            data: (value) => {
              data.push(value as Record<string, unknown>);
            },
            rows() {},
            text() {},
            file() {},
            log: (message) => {
              logs.push(message);
            },
            error: (value) => {
              errors.push(value as { message?: string });
            },
            setExitCode() {},
          },
        });
        await program.parseAsync(["artifacts", ...args], { from: "user" });
        return { data, errors, logs };
      };
      const refused = await invoke(["create", "huge", "--purpose", "Large", "--big"]);
      expect(refused.data).toEqual([]);
      expect(refused.errors[0]?.message).toContain("artifacts.min_free_bytes");
      expect(refused.errors[0]?.message).toContain("--allow-low-disk");
      const allowed = await invoke([
        "create",
        "huge",
        "--purpose",
        "Large",
        "--big",
        "--allow-low-disk",
      ]);
      expect(allowed.errors).toEqual([]);
      expect(allowed.data[0]?.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("min_free_bytes")]),
      );
      expect(allowed.logs.some((line) => line.includes("min_free_bytes"))).toBe(true);
      const plain = await invoke(["create", "small", "--purpose", "Small"]);
      expect(plain.errors).toEqual([]);
      // The cleanup sweep before this create measured the store; create read that cache.
      expect(plain.data[0]?.usage).toMatchObject({
        held_bytes: 0,
        held_measured_at: expect.any(String),
      });

      const listed = await invoke(["list"]);
      const meta = listed.data[0]?.meta as Record<string, unknown>;
      expect(meta).toMatchObject({ low_disk: true, held_over_budget: false, held_bytes: 0 });
      expect(typeof meta.row_warnings).toBe("number");
      const id = plain.data[0]?.artifact_id as string;
      const held = await invoke([
        "hold",
        id,
        "--id",
        "review",
        "--reason",
        "Pending review",
        "--actor",
        "binding_first_123",
        "--days",
        "2",
      ]);
      expect(held.errors).toEqual([]);
      const hold = (held.data[0]?.holds as { expires_at: string; set_at: string }[])[0]!;
      expect(Date.parse(hold.expires_at) - Date.parse(hold.set_at)).toBe(2 * 24 * 60 * 60 * 1000);
      expect(held.data[0]?.usage).toMatchObject({ held_bytes: 0 });
      expect(
        (
          await invoke([
            "hold",
            id,
            "--id",
            "x",
            "--reason",
            "x",
            "--actor",
            "binding_first_123",
            "--days",
            "1",
            "--minutes",
            "1",
          ])
        ).errors,
      ).toHaveLength(1);

      const leased = await invoke([
        "create",
        "leased",
        "--purpose",
        "Open checkout",
        "--hold",
        "lease-1",
        "--hold-reason",
        "Unsynchronized work",
        "--hold-persistent",
        "--actor",
        "binding_first_123",
      ]);
      expect(leased.errors).toEqual([]);
      const leasedHold = (leased.data[0]?.holds as Record<string, unknown>[])[0]!;
      expect(leasedHold).toMatchObject({ id: "lease-1", persistent: true });
      expect(leasedHold.expires_at).toBeUndefined();
      expect(
        (await invoke(["create", "x", "--purpose", "x", "--hold-persistent"])).errors[0]?.message,
      ).toContain("--hold-persistent requires --hold");
      const upgraded = await invoke([
        "hold",
        id,
        "--id",
        "review",
        "--reason",
        "Pending review",
        "--actor",
        "binding_first_123",
        "--persistent",
      ]);
      expect(upgraded.errors).toEqual([]);
      const upgradedHold = (upgraded.data[0]?.holds as Record<string, unknown>[])[0]!;
      expect(upgradedHold).toMatchObject({ id: "review", persistent: true });
      expect(upgradedHold.expires_at).toBeUndefined();
      expect(
        (
          await invoke([
            "hold",
            id,
            "--id",
            "y",
            "--reason",
            "y",
            "--actor",
            "binding_first_123",
            "--persistent",
            "--days",
            "2",
          ])
        ).errors[0]?.message,
      ).toContain("--persistent cannot be combined");
    } finally {
      if (saved === undefined) delete process.env.HARNERY_ARTIFACT_MIN_FREE_BYTES;
      else process.env.HARNERY_ARTIFACT_MIN_FREE_BYTES = saved;
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
