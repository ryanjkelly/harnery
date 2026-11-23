import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import { scheduleConfig } from "./config.ts";

const dirs: string[] = [];
const savedXdg = process.env.XDG_CONFIG_HOME;
let userHome: string;

beforeEach(() => {
  userHome = mkdtempSync(join(tmpdir(), "harnery-schedule-user-"));
  dirs.push(userHome);
  process.env.XDG_CONFIG_HOME = userHome;
});

afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
});

function makeRoot(files: { project?: string; local?: string; user?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-schedule-"));
  dirs.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  if (files.project !== undefined)
    writeFileSync(join(root, ".harnery", "config.jsonc"), files.project);
  if (files.local !== undefined)
    writeFileSync(join(root, ".harnery", "config.local.jsonc"), files.local);
  if (files.user !== undefined) {
    mkdirSync(join(userHome, "harnery"), { recursive: true });
    writeFileSync(join(userHome, "harnery", "config.jsonc"), files.user);
  }
  return root;
}

const BOTH = JSON.stringify({ schedule: { readers: ["t3-code", "codex-app"] } });

describe("scheduleConfig", () => {
  test("defaults to no readers", () => {
    expect(scheduleConfig(makeRoot({})).readers).toEqual([]);
    expect(scheduleConfig(makeRoot({ project: "{}" })).readers).toEqual([]);
  });

  test("the project file turns readers on", () => {
    const root = makeRoot({ project: `// comment\n${BOTH}` });
    expect(scheduleConfig(root).readers).toEqual(["t3-code", "codex-app"]);
  });

  test("a user-global value never turns a reader on", () => {
    expect(scheduleConfig(makeRoot({ user: BOTH })).readers).toEqual([]);
  });

  test("a machine-local value never turns a reader on", () => {
    expect(scheduleConfig(makeRoot({ local: BOTH })).readers).toEqual([]);
  });

  test("drops unknown ids, non-strings, duplicates and non-opt-in sources", () => {
    const root = makeRoot({
      project: JSON.stringify({
        schedule: { readers: ["codex-app", "os-timer", 3, "nope", "codex-app", "t3-code"] },
      }),
    });
    expect(scheduleConfig(root).readers).toEqual(["codex-app", "t3-code"]);
  });

  test("a malformed section reads as no readers", () => {
    expect(
      scheduleConfig(makeRoot({ project: JSON.stringify({ schedule: { readers: "t3-code" } }) }))
        .readers,
    ).toEqual([]);
    expect(scheduleConfig(makeRoot({ project: JSON.stringify({ schedule: [] }) })).readers).toEqual(
      [],
    );
  });
});
