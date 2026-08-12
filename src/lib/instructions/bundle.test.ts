import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInstructionBundle } from "./bundle.ts";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-bundle-"));
  mkdirSync(join(root, ".agents", "skills", "review"), { recursive: true });
  mkdirSync(join(root, ".harnery", "skills", "review"), { recursive: true });
  mkdirSync(join(root, ".codex"), { recursive: true });
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "root instructions\n");
  writeFileSync(join(root, ".agents", "skills", "review", "SKILL.md"), "canonical skill\n");
  writeFileSync(join(root, ".harnery", "skills", "review", "SKILL.md"), "rendered skill\n");
  writeFileSync(join(root, ".codex", "hooks.json"), "{}\n");
  writeFileSync(join(root, ".harnery", "config.jsonc"), "{}\n");
  return root;
}

describe("instruction bundle identity", () => {
  test("is stable for identical effective content", () => {
    const root = fixture();
    const first = buildInstructionBundle({ coordRoot: root, cwd: root, adapter: "codex" });
    const second = buildInstructionBundle({ coordRoot: root, cwd: root, adapter: "codex" });
    expect(second.instruction_bundle_id).toBe(first.instruction_bundle_id);
    expect(second.components.map((component) => component.path)).toEqual([
      ".codex/hooks.json",
      ".harnery/config.jsonc",
      ".harnery/skills/review/SKILL.md",
      "AGENTS.md",
    ]);
  });

  test("changes effective and canonical identities independently", () => {
    const root = fixture();
    const before = buildInstructionBundle({ coordRoot: root, cwd: root, adapter: "codex" });
    writeFileSync(join(root, ".agents", "skills", "review", "SKILL.md"), "canonical changed\n");
    const sourceChanged = buildInstructionBundle({ coordRoot: root, cwd: root, adapter: "codex" });
    expect(sourceChanged.instruction_bundle_id).toBe(before.instruction_bundle_id);
    expect(sourceChanged.canonical_source_id).not.toBe(before.canonical_source_id);

    writeFileSync(join(root, ".harnery", "skills", "review", "SKILL.md"), "rendered changed\n");
    const renderedChanged = buildInstructionBundle({
      coordRoot: root,
      cwd: root,
      adapter: "codex",
    });
    expect(renderedChanged.instruction_bundle_id).not.toBe(before.instruction_bundle_id);
  });

  test("adds directory-scoped instructions for a nested profile", () => {
    const root = fixture();
    writeFileSync(join(root, "app", "AGENTS.md"), "app instructions\n");
    const bundle = buildInstructionBundle({
      coordRoot: root,
      cwd: join(root, "app"),
      adapter: "codex",
    });
    expect(bundle.profile_root).toBe("app");
    expect(bundle.instruction_roots).toEqual([".", "app"]);
    expect(bundle.components.some((component) => component.path === "app/AGENTS.md")).toBe(true);
  });

  test("canonical source identity is adapter independent", () => {
    const root = fixture();
    const codex = buildInstructionBundle({ coordRoot: root, cwd: root, adapter: "codex" });
    const cursor = buildInstructionBundle({ coordRoot: root, cwd: root, adapter: "cursor" });
    expect(cursor.canonical_source_id).toBe(codex.canonical_source_id);
  });
});
