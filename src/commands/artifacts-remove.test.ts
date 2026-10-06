import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../tests/helpers/event-v3-runtime.ts";
import { ARTIFACT_MANIFEST, createArtifact, holdArtifact } from "../core/artifacts/index.ts";

const roots: string[] = [];
const owner = "artifact_remove_cli_owner";
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harnery-artifact-remove-cli-"));
  roots.push(root);
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  initializeV3Fixture(root);
  seedV3Session(root, owner);
  const unit = createArtifact(root, {
    slug: "capture",
    purpose: "QA",
    retentionDays: 3,
    actor: { instance_id: owner },
  });
  writeFileSync(join(unit.path, "capture.png"), "evidence");
  const invoke = (args: string[], identity = owner) =>
    Bun.spawnSync(
      [process.execPath, "run", join(import.meta.dir, "../cli.ts"), "artifacts", ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          HARNERY_COORD_ROOT_OVERRIDE: root,
          HARNERY_AGENT_COORD_OWNER: identity,
          HARNERY_AGENT_COORD_BRIDGE: "",
          CLAUDE_PROJECT_DIR: "",
          CODEX_THREAD_ID: "",
        },
      },
    );
  return { root, unit, invoke };
}

test("CLI previews one current artifact, requires a reason, and deletes its folder only with yes", () => {
  const { unit, invoke } = fixture();
  const before = readFileSync(join(unit.path, ARTIFACT_MANIFEST), "utf8");
  expect(invoke(["remove", unit.manifest.artifact_id]).exitCode).toBe(1);
  const preview = invoke(["remove", unit.manifest.artifact_id, "--reason", "Reviewed"]);
  expect(preview.exitCode).toBe(0);
  expect(JSON.parse(preview.stdout.toString())).toMatchObject({
    deleted: false,
    reason: "Reviewed",
  });
  expect(readFileSync(join(unit.path, ARTIFACT_MANIFEST), "utf8")).toBe(before);
  const removed = invoke(["remove", unit.manifest.artifact_id, "--reason", "Reviewed", "--yes"]);
  expect(removed.exitCode).toBe(0);
  expect(JSON.parse(removed.stdout.toString())).toMatchObject({
    deleted: true,
    reason: "Reviewed",
  });
  expect(existsSync(unit.path)).toBe(false);
}, 15_000);

test("CLI refuses a different agent and an outstanding hold without deleting files", () => {
  const { root, unit, invoke } = fixture();
  const args = ["remove", unit.manifest.artifact_id, "--reason", "Reviewed", "--yes"];
  expect(invoke(args, "different_agent").exitCode).toBe(1);
  expect(existsSync(unit.path)).toBe(true);
  holdArtifact(root, unit.path, { id: "review", reason: "Pending", actor: { instance_id: owner } });
  const held = invoke(args);
  expect(held.exitCode).toBe(1);
  expect(held.stderr.toString()).toContain("held: review");
  expect(existsSync(join(unit.path, "capture.png"))).toBe(true);
}, 15_000);
