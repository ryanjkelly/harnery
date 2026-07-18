import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupConfig,
  coordFreshnessSeconds,
  DEFAULT_BIN_NAME,
  DEFAULT_FRESHNESS_SECS,
  pinnedBinName,
  resolveBinName,
  stripJsonComments,
  syncJsoncConfig,
} from "./config.ts";

function makeRoot(configBody?: string): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-config-"));
  mkdirSync(join(root, ".harnery"), { recursive: true });
  if (configBody !== undefined) {
    writeFileSync(join(root, ".harnery", "config.jsonc"), configBody);
  }
  return root;
}

describe("resolveBinName", () => {
  const roots: string[] = [];
  const savedBin = process.env.HARNERY_BIN;

  beforeEach(() => {
    // env vars must be unset, not set to the string "undefined"
    delete process.env.HARNERY_BIN;
  });
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    if (savedBin === undefined) {
      // env vars must be unset, not set to the string "undefined"
      delete process.env.HARNERY_BIN;
    } else {
      process.env.HARNERY_BIN = savedBin;
    }
  });

  test("HARNERY_BIN env wins over config + default", () => {
    process.env.HARNERY_BIN = "envbin";
    const root = makeRoot(`{ "binName": "cfgbin" }`);
    roots.push(root);
    expect(resolveBinName(root)).toBe("envbin");
  });

  test("reads binName from config.jsonc when no env", () => {
    const root = makeRoot(`{ "binName": "acme" }`);
    roots.push(root);
    expect(resolveBinName(root)).toBe("acme");
  });

  test("parses JSONC with comments", () => {
    const root = makeRoot(`{\n  // host CLI\n  "binName": "myapp"\n}`);
    roots.push(root);
    expect(resolveBinName(root)).toBe("myapp");
  });

  test("falls back to harn when config has no binName", () => {
    const root = makeRoot(`{ "files": { "deny_globs": [] } }`);
    roots.push(root);
    expect(resolveBinName(root)).toBe(DEFAULT_BIN_NAME);
  });

  test("falls back to harn when config.jsonc is absent", () => {
    const root = makeRoot();
    roots.push(root);
    expect(resolveBinName(root)).toBe(DEFAULT_BIN_NAME);
  });

  test("falls back to harn when config.jsonc is unparseable", () => {
    const root = makeRoot(`{ "binName": `);
    roots.push(root);
    expect(resolveBinName(root)).toBe(DEFAULT_BIN_NAME);
  });
});

describe("pinnedBinName", () => {
  const roots: string[] = [];
  const savedBin = process.env.HARNERY_BIN;

  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    if (savedBin === undefined) {
      // env vars must be unset, not set to the string "undefined"
      delete process.env.HARNERY_BIN;
    } else {
      process.env.HARNERY_BIN = savedBin;
    }
  });

  test("returns the config pin, ignoring HARNERY_BIN", () => {
    // init must honor the committed pin even under an env override — the pin
    // guards committed surfaces, not per-process display strings.
    process.env.HARNERY_BIN = "envbin";
    const root = makeRoot(`{ "binName": "harn" }`);
    roots.push(root);
    expect(pinnedBinName(root)).toBe("harn");
  });

  test("returns null when nothing is pinned (absent file or field)", () => {
    const empty = makeRoot();
    const noField = makeRoot(`{ "files": { "deny_globs": [] } }`);
    roots.push(empty, noField);
    expect(pinnedBinName(empty)).toBeNull();
    expect(pinnedBinName(noField)).toBeNull();
  });
});

describe("stripJsonComments", () => {
  test("leaves comment-like runs inside strings alone", () => {
    const out = stripJsonComments(`{ "url": "http://x/y", "n": 1 /* c */ }`);
    expect(JSON.parse(out)).toEqual({ url: "http://x/y", n: 1 });
  });
});

// The tunable coord/backup/sync accessors — the config keys the schema declares
// and that (post-A) src/core/config.ts actually honors.

describe("coordFreshnessSeconds", () => {
  const roots: string[] = [];
  const saved = {
    coord: process.env.HARNERY_AGENT_COORD_FRESHNESS,
    legacy: process.env.HARNERY_AGENT_FRESHNESS,
  };
  beforeEach(() => {
    delete process.env.HARNERY_AGENT_COORD_FRESHNESS;
    delete process.env.HARNERY_AGENT_FRESHNESS;
  });
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    for (const [k, v] of [
      ["HARNERY_AGENT_COORD_FRESHNESS", saved.coord],
      ["HARNERY_AGENT_FRESHNESS", saved.legacy],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("defaults to 600 when nothing set", () => {
    const root = makeRoot(`{}`);
    roots.push(root);
    expect(coordFreshnessSeconds(root)).toBe(DEFAULT_FRESHNESS_SECS);
  });

  test("reads coord.freshness_seconds from config", () => {
    const root = makeRoot(`{ "coord": { "freshness_seconds": 1200 } }`);
    roots.push(root);
    expect(coordFreshnessSeconds(root)).toBe(1200);
  });

  test("canonical env wins over config", () => {
    process.env.HARNERY_AGENT_COORD_FRESHNESS = "45";
    const root = makeRoot(`{ "coord": { "freshness_seconds": 1200 } }`);
    roots.push(root);
    expect(coordFreshnessSeconds(root)).toBe(45);
  });

  test("legacy HARNERY_AGENT_FRESHNESS alias is honored", () => {
    process.env.HARNERY_AGENT_FRESHNESS = "90";
    const root = makeRoot(`{}`);
    roots.push(root);
    expect(coordFreshnessSeconds(root)).toBe(90);
  });

  test("invalid config value falls back to the default", () => {
    const root = makeRoot(`{ "coord": { "freshness_seconds": -5 } }`);
    roots.push(root);
    expect(coordFreshnessSeconds(root)).toBe(DEFAULT_FRESHNESS_SECS);
  });
});

describe("backupConfig", () => {
  const roots: string[] = [];
  const saved = {
    repo: process.env.HARNERY_RESTIC_REPO,
    pw: process.env.HARNERY_RESTIC_PASSWORD_FILE,
  };
  beforeEach(() => {
    delete process.env.HARNERY_RESTIC_REPO;
    delete process.env.HARNERY_RESTIC_PASSWORD_FILE;
  });
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    for (const [k, v] of [
      ["HARNERY_RESTIC_REPO", saved.repo],
      ["HARNERY_RESTIC_PASSWORD_FILE", saved.pw],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("built-in defaults when config is empty", () => {
    const root = makeRoot(`{}`);
    roots.push(root);
    const c = backupConfig(root);
    expect(c.repo).toContain(join("harnery", "restic-repo"));
    expect(c.passwordFile).toContain(join("harnery", "restic-password"));
    expect([c.keepDaily, c.keepWeekly, c.keepMonthly]).toEqual([7, 4, 6]);
  });

  test("reads repo/password_file/keep_* from config", () => {
    const root = makeRoot(
      `{ "backup": { "repo": "rclone:gdrive:hb/proj", "password_file": "/etc/pw", "keep_daily": 14, "keep_weekly": 8, "keep_monthly": 12 } }`,
    );
    roots.push(root);
    const c = backupConfig(root);
    expect(c.repo).toBe("rclone:gdrive:hb/proj");
    expect(c.passwordFile).toBe("/etc/pw");
    expect([c.keepDaily, c.keepWeekly, c.keepMonthly]).toEqual([14, 8, 12]);
  });

  test("env repo wins over config repo", () => {
    process.env.HARNERY_RESTIC_REPO = "/env/repo";
    const root = makeRoot(`{ "backup": { "repo": "/cfg/repo" } }`);
    roots.push(root);
    expect(backupConfig(root).repo).toBe("/env/repo");
  });
});

describe("syncJsoncConfig", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  test("null when no sync section", () => {
    const root = makeRoot(`{}`);
    roots.push(root);
    expect(syncJsoncConfig(root)).toBeNull();
  });

  test("reads remote + prefix; prefix defaults to harnery", () => {
    const root = makeRoot(`{ "sync": { "remote": "gdrive" } }`);
    roots.push(root);
    expect(syncJsoncConfig(root)).toEqual({ remote: "gdrive", prefix: "harnery" });
  });

  test("honors an explicit prefix", () => {
    const root = makeRoot(`{ "sync": { "remote": "gdrive", "prefix": "hq/coord" } }`);
    roots.push(root);
    expect(syncJsoncConfig(root)).toEqual({ remote: "gdrive", prefix: "hq/coord" });
  });
});

describe("user-global config layer", () => {
  const roots: string[] = [];
  const savedXdg = process.env.XDG_CONFIG_HOME;
  const savedBin = process.env.HARNERY_BIN;

  beforeEach(() => {
    delete process.env.HARNERY_BIN;
  });
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedBin === undefined) delete process.env.HARNERY_BIN;
    else process.env.HARNERY_BIN = savedBin;
  });

  /** Point XDG_CONFIG_HOME at a temp dir carrying a user-global config, return the project root. */
  function withGlobal(globalBody: string, projectBody?: string): string {
    const xdg = mkdtempSync(join(tmpdir(), "harnery-xdg-"));
    roots.push(xdg);
    mkdirSync(join(xdg, "harnery"), { recursive: true });
    writeFileSync(join(xdg, "harnery", "config.jsonc"), globalBody);
    process.env.XDG_CONFIG_HOME = xdg;
    const root = makeRoot(projectBody);
    roots.push(root);
    return root;
  }

  test("a user-global value is read when the project omits it", () => {
    const root = withGlobal(`{ "coord": { "freshness_seconds": 300 } }`, `{}`);
    delete process.env.HARNERY_AGENT_COORD_FRESHNESS;
    delete process.env.HARNERY_AGENT_FRESHNESS;
    expect(coordFreshnessSeconds(root)).toBe(300);
  });

  test("project overrides the user-global value field-by-field", () => {
    const root = withGlobal(
      `{ "backup": { "repo": "/global/repo", "keep_daily": 30 } }`,
      `{ "backup": { "repo": "/project/repo" } }`,
    );
    delete process.env.HARNERY_RESTIC_REPO;
    const c = backupConfig(root);
    // project wins on repo; global keep_daily survives the merge (not wiped).
    expect(c.repo).toBe("/project/repo");
    expect(c.keepDaily).toBe(30);
  });

  test("pinnedBinName ignores a user-global binName (project-only)", () => {
    const root = withGlobal(`{ "binName": "globalcli" }`, `{}`);
    expect(pinnedBinName(root)).toBeNull();
    // resolveBinName, by contrast, DOES honor the global fallback.
    expect(resolveBinName(root)).toBe("globalcli");
  });
});
