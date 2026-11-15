import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { resolveStatusStyle } from "./status-style.ts";

const dirs: string[] = [];
const saved = { style: process.env.HARNERY_STATUS_STYLE, xdg: process.env.XDG_CONFIG_HOME };

function project(files: { project?: string; local?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "harn-status-style-"));
  dirs.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  if (files.project) writeFileSync(join(root, ".harnery", "config.jsonc"), files.project);
  if (files.local) writeFileSync(join(root, ".harnery", "config.local.jsonc"), files.local);
  return root;
}

beforeEach(() => {
  delete process.env.HARNERY_STATUS_STYLE;
  const xdg = mkdtempSync(join(tmpdir(), "harn-status-style-xdg-"));
  dirs.push(xdg);
  process.env.XDG_CONFIG_HOME = xdg;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
  if (saved.style === undefined) delete process.env.HARNERY_STATUS_STYLE;
  else process.env.HARNERY_STATUS_STYLE = saved.style;
  if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved.xdg;
});

describe("resolveStatusStyle", () => {
  test("defaults to the box", () => {
    expect(resolveStatusStyle(project({}))).toBe("box");
    expect(resolveStatusStyle(null)).toBe("box");
  });

  test("the machine-local file overrides the project file", () => {
    const root = project({
      project: '{ "agents": { "statusStyle": "box" } }',
      local: '// this machine\n{ "agents": { "statusStyle": "plain" } }',
    });
    expect(resolveStatusStyle(root)).toBe("plain");
  });

  test("the project file applies when no local value exists", () => {
    expect(
      resolveStatusStyle(project({ project: '{ "agents": { "statusStyle": "plain" } }' })),
    ).toBe("plain");
  });

  test("an unknown value falls through to the next layer", () => {
    const root = project({
      project: '{ "agents": { "statusStyle": "plain" } }',
      local: '{ "agents": { "statusStyle": "fancy" } }',
    });
    expect(resolveStatusStyle(root)).toBe("plain");
  });

  test("the environment overrides every file", () => {
    const root = project({ local: '{ "agents": { "statusStyle": "plain" } }' });
    process.env.HARNERY_STATUS_STYLE = "box";
    expect(resolveStatusStyle(root)).toBe("box");
  });
});
