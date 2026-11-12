import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import { preferencesPath, readPreferences, writeHelperLimit } from "./preferences.ts";

const dirs: string[] = [];
const savedXdg = process.env.XDG_CONFIG_HOME;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "harnery-prefs-"));
  dirs.push(dir);
  return dir;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
});

describe("preferencesPath", () => {
  test("honors XDG_CONFIG_HOME", () => {
    const dir = tempDir();
    process.env.XDG_CONFIG_HOME = dir;
    expect(preferencesPath()).toBe(join(dir, "harnery", "preferences.json"));
  });

  test("falls back to ~/.config when XDG_CONFIG_HOME is unset or blank", () => {
    const expected = join(homedir(), ".config", "harnery", "preferences.json");
    delete process.env.XDG_CONFIG_HOME;
    expect(preferencesPath()).toBe(expected);
    process.env.XDG_CONFIG_HOME = "  ";
    expect(preferencesPath()).toBe(expected);
  });
});

describe("readPreferences", () => {
  test("a missing file is no preferences", () => {
    expect(readPreferences(join(tempDir(), "nope", "preferences.json"))).toEqual({});
  });

  test("malformed JSON or a non-object is no preferences", () => {
    const dir = tempDir();
    for (const body of ["{not json", "[1,2]", '"text"', "null"]) {
      const path = join(dir, "preferences.json");
      writeFileSync(path, body);
      expect(readPreferences(path)).toEqual({});
    }
  });

  test("malformed entries are dropped and good ones kept", () => {
    const path = join(tempDir(), "preferences.json");
    writeFileSync(
      path,
      JSON.stringify({
        helpers: {
          "claude-code": { max_model: "Opus", max_effort: 7 },
          codex: "high",
          cursor: null,
          opencode: {},
        },
      }),
    );
    expect(readPreferences(path)).toEqual({
      helpers: { "claude-code": { max_model: "opus" }, opencode: {} },
    });
  });

  test("a helpers section with nothing usable is omitted", () => {
    const path = join(tempDir(), "preferences.json");
    writeFileSync(path, JSON.stringify({ helpers: { codex: 1 } }));
    expect(readPreferences(path)).toEqual({});
    writeFileSync(path, JSON.stringify({ helpers: ["claude-code"] }));
    expect(readPreferences(path)).toEqual({});
  });
});

describe("writeHelperLimit", () => {
  test("round trips through readPreferences, creating the directory", () => {
    const path = join(tempDir(), "nested", "harnery", "preferences.json");
    writeHelperLimit("claude-code", { max_model: "opus", max_effort: "medium" }, path);
    writeHelperLimit("codex", {}, path);
    expect(readPreferences(path)).toEqual({
      helpers: {
        "claude-code": { max_model: "opus", max_effort: "medium" },
        codex: {},
      },
    });
  });

  test("null removes the choice, and removes an emptied helpers section", () => {
    const path = join(tempDir(), "preferences.json");
    writeHelperLimit("claude-code", { max_model: "opus" }, path);
    writeHelperLimit("codex", { max_effort: "low" }, path);
    writeHelperLimit("claude-code", null, path);
    expect(readJson(path)).toEqual({ helpers: { codex: { max_effort: "low" } } });
    writeHelperLimit("codex", null, path);
    expect(readJson(path)).toEqual({});
    expect(readPreferences(path)).toEqual({});
  });

  test("null on a missing file writes an empty object", () => {
    const path = join(tempDir(), "preferences.json");
    writeHelperLimit("claude-code", null, path);
    expect(readJson(path)).toEqual({});
  });

  test("unknown top-level sections and other tools' entries survive a write", () => {
    const path = join(tempDir(), "preferences.json");
    writeFileSync(
      path,
      JSON.stringify({ theme: { dark: true }, helpers: { codex: { future_field: 1 } } }),
    );
    writeHelperLimit("claude-code", { max_effort: "high" }, path);
    expect(readJson(path)).toEqual({
      theme: { dark: true },
      helpers: { codex: { future_field: 1 }, "claude-code": { max_effort: "high" } },
    });
  });

  test("a malformed file is replaced cleanly", () => {
    const path = join(tempDir(), "preferences.json");
    writeFileSync(path, "{broken");
    writeHelperLimit("claude-code", { max_model: "sonnet" }, path);
    expect(readJson(path)).toEqual({ helpers: { "claude-code": { max_model: "sonnet" } } });
  });

  test("leaves no temp file behind", () => {
    const dir = tempDir();
    const path = join(dir, "preferences.json");
    writeHelperLimit("claude-code", { max_model: "opus" }, path);
    writeHelperLimit("claude-code", null, path);
    expect(readdirSync(dir)).toEqual(["preferences.json"]);
  });
});
