import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../tests/helpers/event-v3-runtime.ts";
import {
  ARTIFACT_MANIFEST,
  createArtifact,
  holdArtifact,
  readArtifactDeletions,
  releaseArtifact,
  removeArtifact,
} from "./index.ts";

const roots: string[] = [];
const actor = { instance_id: "artifact_remove_owner" };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harnery-remove-artifact-"));
  roots.push(root);
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  initializeV3Fixture(root);
  seedV3Session(root, actor.instance_id);
  const unit = createArtifact(root, { slug: "capture", purpose: "QA", retentionDays: 3, actor });
  const payload = join(unit.path, "capture.png");
  writeFileSync(payload, "evidence");
  return { root, unit, payload };
}

test("preview preserves an active owner's files and retention; yes deletes exactly one unit and records why", () => {
  const { root, unit, payload } = fixture();
  const other = createArtifact(root, { slug: "keep", purpose: "review", retentionDays: 3, actor });
  const before = readFileSync(join(unit.path, ARTIFACT_MANIFEST), "utf8");
  const preview = removeArtifact(root, unit.manifest.artifact_id, "Reviewed; superseded", {
    actor,
  });
  expect(preview.deleted).toBe(false);
  expect(preview.entry.classification).toBe("managed-active");
  expect(existsSync(payload)).toBe(true);
  expect(readFileSync(join(unit.path, ARTIFACT_MANIFEST), "utf8")).toBe(before);
  expect(readArtifactDeletions(root)).toEqual([]);
  const result = removeArtifact(root, unit.manifest.artifact_id, "Reviewed; superseded", {
    actor,
    yes: true,
  });
  expect(result.deleted).toBe(true);
  expect(existsSync(unit.path)).toBe(false);
  expect(existsSync(other.path)).toBe(true);
  expect(readArtifactDeletions(root)).toHaveLength(1);
  expect(readArtifactDeletions(root)[0]).toMatchObject({
    artifact_id: unit.manifest.artifact_id,
    reason: "Reviewed; superseded",
    removed_by: actor,
  });
});

test("another actor cannot remove even a released artifact; an absent identity or reason also refuses", () => {
  for (const input of [{}, { actor: { instance_id: "other_owner" } }, { actor }]) {
    const { root, unit, payload } = fixture();
    releaseArtifact(root, unit.manifest.artifact_id, { actor });
    expect(() =>
      removeArtifact(root, unit.path, input.actor === actor ? " " : "Reviewed", {
        ...input,
        yes: true,
      }),
    ).toThrow();
    expect(existsSync(payload)).toBe(true);
  }
});

for (const mode of [
  "held",
  "tracked",
  "invalid",
  "root-link",
  "payload-link",
  "manifest-link",
  "nested-git",
  "nested-artifact",
  "lock",
]) {
  test(`removal refuses ${mode} units in preview and apply`, () => {
    const { root, unit, payload } = fixture();
    if (mode === "held")
      holdArtifact(root, unit.path, { id: "review", reason: "Pending review", actor });
    if (mode === "tracked") Bun.spawnSync(["git", "add", "-f", payload], { cwd: root });
    if (mode === "invalid") writeFileSync(join(unit.path, ARTIFACT_MANIFEST), "{}");
    if (mode === "payload-link") symlinkSync(payload, join(unit.path, "link"));
    if (mode === "manifest-link") {
      renameSync(join(unit.path, ARTIFACT_MANIFEST), join(root, "manifest.json"));
      symlinkSync(join(root, "manifest.json"), join(unit.path, ARTIFACT_MANIFEST));
    }
    if (mode === "nested-git") mkdirSync(join(unit.path, ".git"));
    if (mode === "nested-artifact") {
      mkdirSync(join(unit.path, "nested"));
      writeFileSync(join(unit.path, "nested", ARTIFACT_MANIFEST), "{}");
    }
    if (mode === "lock") mkdirSync(join(root, ".harnery/artifacts-mutation.lock"));
    const link = join(root, ".harnery/artifacts/link");
    if (mode === "root-link") symlinkSync(unit.path, link);
    for (const yes of [false, true]) {
      expect(() =>
        removeArtifact(root, mode === "root-link" ? link : unit.path, "Reviewed", { actor, yes }),
      ).toThrow();
      expect(existsSync(payload)).toBe(true);
    }
    expect(readArtifactDeletions(root)).toEqual([]);
  });
}

for (const kind of ["ancestor", "exact", "descendant"]) {
  test(`another agent's ${kind} claim prevents removal`, () => {
    const { root, unit, payload } = fixture();
    const claimed =
      kind === "ancestor"
        ? ".harnery/artifacts"
        : relative(root, kind === "exact" ? unit.path : payload);
    seedV3Session(root, "artifact_remove_peer", { claims: [claimed] });
    expect(() => removeArtifact(root, unit.path, "Reviewed", { actor, yes: true })).toThrow(
      "another agent's claim",
    );
    expect(existsSync(payload)).toBe(true);
  });
}

test("symlinked store and references outside the direct-child boundary cannot delete files", () => {
  const { root, unit, payload } = fixture();
  for (const ref of [root, join(root, ".harnery/artifacts"), payload, "../outside", "*"]) {
    expect(() => removeArtifact(root, ref, "Reviewed", { actor, yes: true })).toThrow();
    expect(existsSync(payload)).toBe(true);
  }
  const store = join(root, ".harnery/artifacts");
  const moved = join(root, "moved-artifacts");
  renameSync(store, moved);
  symlinkSync(moved, store);
  expect(() => removeArtifact(root, unit.path, "Reviewed", { actor, yes: true })).toThrow(
    "real directories",
  );
  expect(existsSync(join(moved, basename(unit.path), "capture.png"))).toBe(true);
});

test("removal cannot delete the current working directory or its ancestor", () => {
  const { root, unit, payload } = fixture();
  const before = process.cwd();
  const nested = join(unit.path, "nested");
  mkdirSync(nested);
  try {
    for (const cwd of [unit.path, nested]) {
      process.chdir(cwd);
      expect(() => removeArtifact(root, unit.path, "Reviewed", { actor, yes: true })).toThrow(
        "working directory",
      );
      expect(existsSync(payload)).toBe(true);
    }
  } finally {
    process.chdir(before);
  }
});
