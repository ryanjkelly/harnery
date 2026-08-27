import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIndexerExclusions, removeIndexerExclusions } from "./indexer-exclusions.ts";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-indexer-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("applyIndexerExclusions", () => {
  test("creates both files in a fresh project", () => {
    const root = makeRoot();
    const actions = applyIndexerExclusions(root, false);
    expect(actions.join("\n")).toContain("+ created .cursorindexingignore");
    expect(actions.join("\n")).toContain("+ created .vscode/settings.json");
    expect(readFileSync(join(root, ".cursorindexingignore"), "utf8")).toContain(".harnery/");
    const settings = JSON.parse(readFileSync(join(root, ".vscode", "settings.json"), "utf8"));
    expect(settings["files.watcherExclude"]["**/.harnery/**"]).toBe(true);
  });

  test("is idempotent", () => {
    const root = makeRoot();
    applyIndexerExclusions(root, false);
    const ignoreBefore = readFileSync(join(root, ".cursorindexingignore"), "utf8");
    const settingsBefore = readFileSync(join(root, ".vscode", "settings.json"), "utf8");
    const actions = applyIndexerExclusions(root, false);
    expect(actions.every((a) => a.startsWith("·"))).toBe(true);
    expect(readFileSync(join(root, ".cursorindexingignore"), "utf8")).toBe(ignoreBefore);
    expect(readFileSync(join(root, ".vscode", "settings.json"), "utf8")).toBe(settingsBefore);
  });

  test("dry run reports without writing", () => {
    const root = makeRoot();
    const actions = applyIndexerExclusions(root, true);
    expect(actions.join("\n")).toContain("+ would create");
    expect(existsSync(join(root, ".cursorindexingignore"))).toBe(false);
    expect(existsSync(join(root, ".vscode"))).toBe(false);
  });

  test("appends to an existing .cursorindexingignore, preserving content", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".cursorindexingignore"), "dist/\n");
    applyIndexerExclusions(root, false);
    const raw = readFileSync(join(root, ".cursorindexingignore"), "utf8");
    expect(raw.startsWith("dist/\n")).toBe(true);
    expect(raw).toContain(".harnery/\n");
  });

  test("respects a consumer's own .harnery entry", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".cursorindexingignore"), "/.harnery/\n");
    const actions = applyIndexerExclusions(root, false);
    expect(actions[0]).toContain("already excludes");
    expect(readFileSync(join(root, ".cursorindexingignore"), "utf8")).toBe("/.harnery/\n");
  });

  test("merges into an existing plain-JSON settings file, keeping other keys", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".vscode"));
    writeFileSync(
      join(root, ".vscode", "settings.json"),
      `${JSON.stringify({ "editor.tabSize": 2, "files.watcherExclude": { "**/dist/**": true } }, null, 2)}\n`,
    );
    applyIndexerExclusions(root, false);
    const settings = JSON.parse(readFileSync(join(root, ".vscode", "settings.json"), "utf8"));
    expect(settings["editor.tabSize"]).toBe(2);
    expect(settings["files.watcherExclude"]["**/dist/**"]).toBe(true);
    expect(settings["files.watcherExclude"]["**/.harnery/**"]).toBe(true);
  });

  test("leaves a commented (JSONC) settings file byte-identical and reports a manual step", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".vscode"));
    const jsonc = '{\n  // keep\n  "editor.tabSize": 2\n}\n';
    writeFileSync(join(root, ".vscode", "settings.json"), jsonc);
    const actions = applyIndexerExclusions(root, false);
    expect(actions.join("\n")).toContain("! .vscode/settings.json is not plain JSON");
    expect(readFileSync(join(root, ".vscode", "settings.json"), "utf8")).toBe(jsonc);
  });
});

describe("removeIndexerExclusions", () => {
  test("reverses a fresh apply completely", () => {
    const root = makeRoot();
    applyIndexerExclusions(root, false);
    const actions = removeIndexerExclusions(root, false);
    expect(actions.join("\n")).toContain("removed .cursorindexingignore (was harnery-only)");
    expect(actions.join("\n")).toContain("removed .vscode/settings.json (was harnery-only)");
    expect(existsSync(join(root, ".cursorindexingignore"))).toBe(false);
    expect(existsSync(join(root, ".vscode", "settings.json"))).toBe(false);
  });

  test("keeps consumer content while removing the managed pieces", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".cursorindexingignore"), "dist/\n");
    mkdirSync(join(root, ".vscode"));
    writeFileSync(
      join(root, ".vscode", "settings.json"),
      `${JSON.stringify({ "editor.tabSize": 2 }, null, 2)}\n`,
    );
    applyIndexerExclusions(root, false);
    removeIndexerExclusions(root, false);
    expect(readFileSync(join(root, ".cursorindexingignore"), "utf8")).toBe("dist/\n");
    const settings = JSON.parse(readFileSync(join(root, ".vscode", "settings.json"), "utf8"));
    expect(settings["editor.tabSize"]).toBe(2);
    expect(settings["files.watcherExclude"]).toBeUndefined();
  });

  test("never removes a consumer's own .harnery entry", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".cursorindexingignore"), ".harnery/\n");
    const actions = removeIndexerExclusions(root, false);
    expect(actions.join("\n")).not.toContain(".cursorindexingignore");
    expect(readFileSync(join(root, ".cursorindexingignore"), "utf8")).toBe(".harnery/\n");
  });

  test("is silent when nothing is ours", () => {
    const root = makeRoot();
    expect(removeIndexerExclusions(root, false)).toEqual([]);
  });
});
