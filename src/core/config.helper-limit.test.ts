import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import { helperLimitSkipped, resolveHelperLimit } from "./config.ts";

const roots: string[] = [];
const savedSkip = process.env.HARNERY_HELPER_LIMIT_SKIP;

function makeRoot(configBody?: string): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-helper-limit-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  if (configBody !== undefined) {
    writeFileSync(join(root, ".harnery", "config.jsonc"), configBody);
  }
  return root;
}

const OPUS_MEDIUM = { max_model: "opus", max_effort: "medium" };
const PROJECT = `{
  // the project's default for helper agents
  "helpers": { "claude-code": { "max_model": "Opus", "max_effort": "medium" } }
}`;

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
  if (savedSkip === undefined) delete process.env.HARNERY_HELPER_LIMIT_SKIP;
  else process.env.HARNERY_HELPER_LIMIT_SKIP = savedSkip;
});

describe("resolveHelperLimit", () => {
  test("applies the project default when the person made no choice", () => {
    const coordRoot = makeRoot(PROJECT);
    expect(resolveHelperLimit("claude-code", { coordRoot, preferences: {} })).toEqual({
      tool: "claude-code",
      limit: OPUS_MEDIUM,
      source: "project",
      project_default: OPUS_MEDIUM,
    });
  });

  test("the project default is per adapter", () => {
    const coordRoot = makeRoot(PROJECT);
    expect(resolveHelperLimit("codex", { coordRoot, preferences: {} })).toEqual({
      tool: "codex",
      limit: null,
      source: "none",
      project_default: null,
    });
  });

  test("the person's choice wins over a looser and a stricter project default", () => {
    const coordRoot = makeRoot(PROJECT);
    const looser = { max_model: "fable" };
    const stricter = { max_model: "haiku", max_effort: "low" };
    for (const user of [looser, stricter]) {
      expect(
        resolveHelperLimit("claude-code", {
          coordRoot,
          preferences: { helpers: { "claude-code": user } },
        }),
      ).toEqual({
        tool: "claude-code",
        limit: user,
        source: "user",
        user,
        project_default: OPUS_MEDIUM,
      });
    }
  });

  test("the person's explicit no-limit wins over the project default", () => {
    const coordRoot = makeRoot(PROJECT);
    expect(
      resolveHelperLimit("claude-code", {
        coordRoot,
        preferences: { helpers: { "claude-code": {} } },
      }),
    ).toEqual({
      tool: "claude-code",
      limit: null,
      source: "user",
      user: {},
      project_default: OPUS_MEDIUM,
    });
  });

  test("a malformed project entry is ignored", () => {
    for (const body of [
      `{ "helpers": { "claude-code": "opus" } }`,
      `{ "helpers": { "claude-code": { "max_model": 5 } } }`,
      `{ "helpers": { "claude-code": {} } }`,
      `{ "helpers": ["claude-code"] }`,
      `{ "helpers": "opus" }`,
    ]) {
      const coordRoot = makeRoot(body);
      const resolved = resolveHelperLimit("claude-code", { coordRoot, preferences: {} });
      expect(resolved.limit).toBeNull();
      expect(resolved.source).toBe("none");
      expect(resolved.project_default).toBeNull();
    }
  });

  test("a root with no config file has no project default", () => {
    const coordRoot = makeRoot();
    expect(resolveHelperLimit("claude-code", { coordRoot, preferences: {} }).source).toBe("none");
  });

  test("coordRoot null skips the project layer", () => {
    expect(resolveHelperLimit("claude-code", { coordRoot: null, preferences: {} })).toEqual({
      tool: "claude-code",
      limit: null,
      source: "none",
      project_default: null,
    });
    const user = { max_effort: "high" };
    expect(
      resolveHelperLimit("claude-code", {
        coordRoot: null,
        preferences: { helpers: { "claude-code": user } },
      }),
    ).toEqual({
      tool: "claude-code",
      limit: user,
      source: "user",
      user,
      project_default: null,
    });
  });
});

describe("helperLimitSkipped", () => {
  test("is true only for HARNERY_HELPER_LIMIT_SKIP=1", () => {
    delete process.env.HARNERY_HELPER_LIMIT_SKIP;
    expect(helperLimitSkipped()).toBe(false);
    process.env.HARNERY_HELPER_LIMIT_SKIP = "0";
    expect(helperLimitSkipped()).toBe(false);
    process.env.HARNERY_HELPER_LIMIT_SKIP = "1";
    expect(helperLimitSkipped()).toBe(true);
  });
});
