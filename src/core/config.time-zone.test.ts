import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timeZoneCheck } from "../commands/doctor.ts";
import { canonicalTimeZone, inspectTimeZone, resolveTimeZone } from "./config.ts";

const dirs: string[] = [];
const saved = {
  zone: process.env.HARNERY_TIME_ZONE,
  xdg: process.env.XDG_CONFIG_HOME,
};

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function project(timeZone?: unknown): string {
  const root = tempDir("harnery-tz-project-");
  mkdirSync(join(root, ".harnery"), { recursive: true });
  if (timeZone !== undefined) {
    writeFileSync(
      join(root, ".harnery", "config.jsonc"),
      `{\n  // zone for human-facing times\n  "timeZone": ${JSON.stringify(timeZone)}\n}\n`,
    );
  }
  return root;
}

function userConfig(timeZone: unknown): void {
  const xdg = tempDir("harnery-tz-user-");
  mkdirSync(join(xdg, "harnery"), { recursive: true });
  writeFileSync(join(xdg, "harnery", "config.jsonc"), JSON.stringify({ timeZone }));
  process.env.XDG_CONFIG_HOME = xdg;
}

beforeEach(() => {
  delete process.env.HARNERY_TIME_ZONE;
  // An empty XDG dir: no user-global config unless a test writes one.
  process.env.XDG_CONFIG_HOME = tempDir("harnery-tz-empty-xdg-");
});

afterEach(() => {
  for (const [key, value] of [
    ["HARNERY_TIME_ZONE", saved.zone],
    ["XDG_CONFIG_HOME", saved.xdg],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveTimeZone precedence", () => {
  test("env beats project beats user", () => {
    userConfig("Asia/Tokyo");
    const root = project("Europe/Berlin");
    process.env.HARNERY_TIME_ZONE = "America/Denver";
    expect(inspectTimeZone(root)).toMatchObject({ zone: "America/Denver", source: "env" });
    delete process.env.HARNERY_TIME_ZONE;
    expect(inspectTimeZone(root)).toMatchObject({ zone: "Europe/Berlin", source: "project" });
    expect(inspectTimeZone(project())).toMatchObject({ zone: "Asia/Tokyo", source: "user" });
  });

  test("unset everywhere falls back to the system zone", () => {
    const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(inspectTimeZone(project())).toMatchObject({
      zone: canonicalTimeZone(system) ?? "UTC",
      source: canonicalTimeZone(system) ? "system" : "default",
      invalid: [],
    });
  });

  test("canonicalizes spelling", () => {
    expect(inspectTimeZone(project("europe/berlin")).zone).toBe("Europe/Berlin");
    expect(canonicalTimeZone("Not/AZone")).toBeNull();
    expect(canonicalTimeZone("  ")).toBeNull();
  });

  test("an invalid setting falls through to the next source and warns once", () => {
    userConfig("Asia/Tokyo");
    const root = project("Mars/Olympus_Mons");
    process.env.HARNERY_TIME_ZONE = "Not/AZone";
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(resolveTimeZone(root)).toBe("Asia/Tokyo");
      expect(resolveTimeZone(root)).toBe("Asia/Tokyo");
      const warnings = stderr.mock.calls.map((call) => String(call[0]));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('"Not/AZone" from HARNERY_TIME_ZONE');
      expect(warnings[1]).toContain('"Mars/Olympus_Mons" from project');
    } finally {
      stderr.mockRestore();
    }
  });

  test("a non-string setting is invalid, not ignored", () => {
    expect(inspectTimeZone(project(-6))).toMatchObject({
      invalid: [{ source: "project", value: "-6" }],
    });
  });
});

describe("doctor time zone check", () => {
  test("fails on an invalid explicit setting and passes otherwise", () => {
    const bad = timeZoneCheck(inspectTimeZone(project("Central")));
    expect(bad.severity).toBe("fail");
    expect(bad.detail).toContain('"Central" from project .harnery/config.jsonc timeZone');
    const good = timeZoneCheck(inspectTimeZone(project("UTC")));
    expect(good).toMatchObject({
      severity: "ok",
      detail: "UTC (project .harnery/config.jsonc timeZone)",
    });
  });
});
