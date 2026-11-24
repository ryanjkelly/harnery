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

const BOTH = JSON.stringify({ schedule: { disabledReaders: ["t3-code", "codex-app"] } });

describe("scheduleConfig", () => {
  test("defaults to no reader switched off", () => {
    expect(scheduleConfig(makeRoot({})).disabledReaders).toEqual([]);
    expect(scheduleConfig(makeRoot({ project: "{}" })).disabledReaders).toEqual([]);
  });

  test("the project file switches readers off", () => {
    const cfg = scheduleConfig(makeRoot({ project: `// comment\n${BOTH}` }));
    expect(cfg.disabledReaders).toEqual(["t3-code", "codex-app"]);
    expect(cfg.disabledIn).toEqual({ "t3-code": ["project"], "codex-app": ["project"] });
  });

  test("a user-global value also switches a reader off", () => {
    expect(scheduleConfig(makeRoot({ user: BOTH })).disabledIn["t3-code"]).toEqual(["user"]);
  });

  test("a machine-local value also switches a reader off", () => {
    expect(scheduleConfig(makeRoot({ local: BOTH })).disabledIn["codex-app"]).toEqual(["local"]);
  });

  test("layers are joined, so no layer turns back on what another switched off", () => {
    const cfg = scheduleConfig(
      makeRoot({
        user: JSON.stringify({ schedule: { disabledReaders: ["os-timer"] } }),
        project: JSON.stringify({ schedule: { disabledReaders: [] } }),
        local: JSON.stringify({ schedule: { disabledReaders: ["harnery", "os-timer"] } }),
      }),
    );
    expect(cfg.disabledReaders).toEqual(["os-timer", "harnery"]);
    expect(cfg.disabledIn).toEqual({ "os-timer": ["user", "local"], harnery: ["local"] });
  });

  test("drops unknown ids, non-strings, duplicates and captured", () => {
    const root = makeRoot({
      project: JSON.stringify({
        schedule: { disabledReaders: ["codex-app", "captured", 3, "nope", "codex-app", "t3-code"] },
      }),
    });
    expect(scheduleConfig(root).disabledReaders).toEqual(["t3-code", "codex-app"]);
  });

  test("a malformed section switches nothing off", () => {
    expect(
      scheduleConfig(
        makeRoot({ project: JSON.stringify({ schedule: { disabledReaders: "t3-code" } }) }),
      ).disabledReaders,
    ).toEqual([]);
    expect(
      scheduleConfig(makeRoot({ project: JSON.stringify({ schedule: [] }) })).disabledReaders,
    ).toEqual([]);
  });
});
