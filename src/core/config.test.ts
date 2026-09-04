import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentsFinalizationRoots,
  agentsRequireGitFinalization,
  artifactDefaultRetentionDays,
  artifactMaxBytes,
  artifactMaxUnitBytes,
  backupConfig,
  coordFreshnessSeconds,
  DEFAULT_BIN_NAME,
  DEFAULT_FRESHNESS_SECS,
  endOfTurnStatusCommand,
  eventLedgerArchivePolicy,
  hostPromptContextConfig,
  hostPromptReminder,
  logStorageConfigSource,
  MAX_HOST_PROMPT_REMINDER_CHARS,
  pinnedBinName,
  resolveBinName,
  sessionFinalizationConfig,
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

describe("logStorageConfigSource", () => {
  const roots: string[] = [];
  const savedXdg = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  test("preserves user and project layers for provenance-aware resolution", () => {
    const xdg = mkdtempSync(join(tmpdir(), "harnery-log-config-xdg-"));
    const root = makeRoot(
      `{ "logs": { "storage": { "classes": { "debug-log": { "max_age_days": 2 } } } } }`,
    );
    roots.push(xdg, root);
    mkdirSync(join(xdg, "harnery"), { recursive: true });
    writeFileSync(
      join(xdg, "harnery", "config.jsonc"),
      `{ "logs": { "storage": { "classes": { "debug-log": { "max_bytes": 10485760 } } } } }`,
    );
    process.env.XDG_CONFIG_HOME = xdg;

    const source = logStorageConfigSource(root);
    expect(source.layers.map(({ layer, invalid }) => ({ layer, invalid }))).toEqual([
      { layer: "user", invalid: false },
      { layer: "project", invalid: false },
    ]);
    expect(source.layers[0].value).toMatchObject({
      classes: { "debug-log": { max_bytes: 10_485_760 } },
    });
    expect(source.layers[1].value).toMatchObject({
      classes: { "debug-log": { max_age_days: 2 } },
    });
  });

  test("reports a malformed layer instead of substituting retention defaults", () => {
    const xdg = mkdtempSync(join(tmpdir(), "harnery-log-config-invalid-xdg-"));
    const root = makeRoot(`{ "logs": {`);
    roots.push(xdg, root);
    mkdirSync(join(xdg, "harnery"), { recursive: true });
    writeFileSync(join(xdg, "harnery", "config.jsonc"), `{}`);
    process.env.XDG_CONFIG_HOME = xdg;

    const source = logStorageConfigSource(root);
    expect(source.layers[0].invalid).toBeFalse();
    expect(source.layers[1]).toMatchObject({ layer: "project", invalid: true, value: undefined });
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

describe("agentsRequireGitFinalization", () => {
  const roots: string[] = [];
  const saved = process.env.HARNERY_AGENTS_REQUIRE_GIT_FINALIZATION;

  beforeEach(() => {
    delete process.env.HARNERY_AGENTS_REQUIRE_GIT_FINALIZATION;
  });
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    if (saved === undefined) delete process.env.HARNERY_AGENTS_REQUIRE_GIT_FINALIZATION;
    else process.env.HARNERY_AGENTS_REQUIRE_GIT_FINALIZATION = saved;
  });

  test("defaults off and keeps the ordinary status command", () => {
    const root = makeRoot(`{ "binName": "acme" }`);
    roots.push(root);
    expect(agentsRequireGitFinalization(root)).toBe(false);
    expect(endOfTurnStatusCommand(root)).toBe("acme agents status");
  });

  test("project config opts into the guarded status command", () => {
    const root = makeRoot(`{ "binName": "acme", "agents": { "requireGitFinalization": true } }`);
    roots.push(root);
    expect(agentsRequireGitFinalization(root)).toBe(true);
    expect(endOfTurnStatusCommand(root)).toBe("acme agents status --end-turn");
  });

  test("environment override wins in both directions", () => {
    const enabled = makeRoot(`{ "agents": { "requireGitFinalization": true } }`);
    const disabled = makeRoot(`{}`);
    roots.push(enabled, disabled);

    process.env.HARNERY_AGENTS_REQUIRE_GIT_FINALIZATION = "0";
    expect(agentsRequireGitFinalization(enabled)).toBe(false);

    process.env.HARNERY_AGENTS_REQUIRE_GIT_FINALIZATION = "1";
    expect(agentsRequireGitFinalization(disabled)).toBe(true);
  });
});

describe("hostPromptReminder", () => {
  const roots: string[] = [];
  const savedXdg = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  test("reads and trims one bounded project-owned line", () => {
    const root = makeRoot(`{ "instructions": { "promptReminder": "  Use the host voice.  " } }`);
    roots.push(root);
    expect(hostPromptReminder(root)).toBe("Use the host voice.");
  });

  test("ignores blank, multiline, oversized, and non-string values", () => {
    const values = ["   ", "first\nsecond", "x".repeat(MAX_HOST_PROMPT_REMINDER_CHARS + 1), 42];
    for (const value of values) {
      const root = makeRoot(JSON.stringify({ instructions: { promptReminder: value } }));
      roots.push(root);
      expect(hostPromptReminder(root)).toBeNull();
    }
  });

  test("does not carry a user-global host reminder into another project", () => {
    const xdg = mkdtempSync(join(tmpdir(), "harnery-reminder-xdg-"));
    const root = makeRoot(`{}`);
    roots.push(xdg, root);
    mkdirSync(join(xdg, "harnery"), { recursive: true });
    writeFileSync(
      join(xdg, "harnery", "config.jsonc"),
      `{ "instructions": { "promptReminder": "private global wording" } }`,
    );
    process.env.XDG_CONFIG_HOME = xdg;
    expect(hostPromptReminder(root)).toBeNull();
  });
});

describe("hostPromptContextConfig", () => {
  const roots: string[] = [];
  const savedXdg = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  test("defaults off in project config", () => {
    const root = makeRoot(`{}`);
    roots.push(root);
    expect(hostPromptContextConfig(root)).toEqual({
      enabled: false,
      timeoutMs: 15_000,
      maxOutputBytes: 65_536,
    });
  });

  test("reads bounded settings only from the project", () => {
    const xdg = mkdtempSync(join(tmpdir(), "harnery-prompt-context-xdg-"));
    const root = makeRoot(
      `{ "hooks": { "promptContext": { "enabled": true, "timeoutMs": 2500, "maxOutputBytes": 8192 } } }`,
    );
    roots.push(xdg, root);
    mkdirSync(join(xdg, "harnery"), { recursive: true });
    writeFileSync(
      join(xdg, "harnery", "config.jsonc"),
      `{ "hooks": { "promptContext": { "enabled": true, "timeoutMs": 9999 } } }`,
    );
    process.env.XDG_CONFIG_HOME = xdg;

    expect(hostPromptContextConfig(root)).toEqual({
      enabled: true,
      timeoutMs: 2_500,
      maxOutputBytes: 8_192,
    });
  });

  test("rejects malformed enabled settings", () => {
    const root = makeRoot(
      `{ "hooks": { "promptContext": { "enabled": true, "maxOutputBytes": 0 } } }`,
    );
    roots.push(root);
    expect(hostPromptContextConfig(root)).toBeNull();
  });
});

describe("agentsFinalizationRoots", () => {
  const roots: string[] = [];
  const savedXdg = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  test("reads valid roots from project config", () => {
    const root = makeRoot(
      `{ "agents": { "finalizationRoots": [` +
        `{ "path": "../sibling", "disposition": "git" },` +
        `{ "path": "../exports", "disposition": "output" }` +
        `] } }`,
    );
    roots.push(root);
    expect(agentsFinalizationRoots(root)).toEqual([
      { path: "../sibling", disposition: "git" },
      { path: "../exports", disposition: "output" },
    ]);
  });

  test("does not grant filesystem authority from user-global config", () => {
    const xdg = mkdtempSync(join(tmpdir(), "harnery-user-config-"));
    const root = makeRoot(`{}`);
    roots.push(xdg, root);
    mkdirSync(join(xdg, "harnery"), { recursive: true });
    writeFileSync(
      join(xdg, "harnery", "config.jsonc"),
      `{ "agents": { "finalizationRoots": [` +
        `{ "path": "/tmp/global-grant", "disposition": "output" }` +
        `] } }`,
    );
    process.env.XDG_CONFIG_HOME = xdg;

    expect(agentsFinalizationRoots(root)).toEqual([]);
  });
});

describe("stripJsonComments", () => {
  test("leaves comment-like runs inside strings alone", () => {
    const out = stripJsonComments(`{ "url": "http://x/y", "n": 1 /* c */ }`);
    expect(JSON.parse(out)).toEqual({ url: "http://x/y", n: 1 });
  });
});

// The tunable coord/artifact/backup/sync accessors and the config keys they honor.

describe("coordFreshnessSeconds", () => {
  const roots: string[] = [];
  const saved = {
    coord: process.env.HARNERY_AGENT_COORD_FRESHNESS,
  };
  beforeEach(() => {
    delete process.env.HARNERY_AGENT_COORD_FRESHNESS;
  });
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    for (const [k, v] of [["HARNERY_AGENT_COORD_FRESHNESS", saved.coord]] as const) {
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

  test("invalid config value falls back to the default", () => {
    const root = makeRoot(`{ "coord": { "freshness_seconds": -5 } }`);
    roots.push(root);
    expect(coordFreshnessSeconds(root)).toBe(DEFAULT_FRESHNESS_SECS);
  });
});

describe("sessionFinalizationConfig", () => {
  test("uses safe defaults and clamps idle finalization after observation", () => {
    const empty = makeRoot(`{}`);
    const configured = makeRoot(
      JSON.stringify({
        coord: {
          finalization: {
            archive_grace_seconds: 90,
            idle_observe_seconds: 500,
            idle_finalize_seconds: 100,
            cascade_grace_seconds: 30,
            reconcile_interval_seconds: 45,
          },
        },
      }),
    );
    expect(sessionFinalizationConfig(empty)).toMatchObject({
      archiveGraceSeconds: 600,
      idleObserveSeconds: 259_200,
      idleFinalizeSeconds: 604_800,
      cascadeGraceSeconds: 3_600,
      reconcileIntervalSeconds: 900,
    });
    expect(sessionFinalizationConfig(configured)).toEqual({
      archiveGraceSeconds: 90,
      idleObserveSeconds: 500,
      idleFinalizeSeconds: 500,
      cascadeGraceSeconds: 30,
      reconcileIntervalSeconds: 45,
    });
    rmSync(empty, { recursive: true, force: true });
    rmSync(configured, { recursive: true, force: true });
  });
});

describe("artifactDefaultRetentionDays", () => {
  const roots: string[] = [];
  const saved = process.env.HARNERY_ARTIFACT_RETENTION_DAYS;

  beforeEach(() => {
    delete process.env.HARNERY_ARTIFACT_RETENTION_DAYS;
  });
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    if (saved === undefined) delete process.env.HARNERY_ARTIFACT_RETENTION_DAYS;
    else process.env.HARNERY_ARTIFACT_RETENTION_DAYS = saved;
  });

  test("defaults to three days and reads project config", () => {
    const empty = makeRoot(`{}`);
    const configured = makeRoot(`{ "artifacts": { "default_retention_days": 7 } }`);
    roots.push(empty, configured);
    expect(artifactDefaultRetentionDays(empty)).toBe(3);
    expect(artifactDefaultRetentionDays(configured)).toBe(7);
  });

  test("environment override wins and invalid values fail closed to config", () => {
    const root = makeRoot(`{ "artifacts": { "default_retention_days": 5 } }`);
    roots.push(root);
    process.env.HARNERY_ARTIFACT_RETENTION_DAYS = "9";
    expect(artifactDefaultRetentionDays(root)).toBe(9);
    process.env.HARNERY_ARTIFACT_RETENTION_DAYS = "-1";
    expect(artifactDefaultRetentionDays(root)).toBe(5);
  });
});

describe("bounded local storage settings", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("uses conservative artifact and closed-epoch defaults", () => {
    const root = makeRoot(`{}`);
    roots.push(root);
    expect(artifactMaxBytes(root)).toBe(20 * 1024 * 1024 * 1024);
    expect(artifactMaxUnitBytes(root)).toBe(1024 * 1024 * 1024);
    expect(eventLedgerArchivePolicy(root)).toEqual({
      maxBytes: 1024 * 1024 * 1024,
      maxAgeDays: 7,
      keepMin: 2,
      autoClean: true,
    });
  });

  test("reads valid project overrides and ignores unsafe values", () => {
    const root = makeRoot(`{
      "artifacts": { "max_bytes": 134217728, "max_unit_bytes": 33554432 },
      "events": {
        "archive_max_bytes": 268435456,
        "archive_max_age_days": 14,
        "archive_keep_min": 4,
        "archive_auto_clean": false
      }
    }`);
    const invalid = makeRoot(`{
      "artifacts": { "max_bytes": 1, "max_unit_bytes": -1 },
      "events": { "archive_max_bytes": 1, "archive_max_age_days": 0, "archive_keep_min": 0 }
    }`);
    roots.push(root, invalid);
    expect(artifactMaxBytes(root)).toBe(134217728);
    expect(artifactMaxUnitBytes(root)).toBe(33554432);
    expect(eventLedgerArchivePolicy(root)).toEqual({
      maxBytes: 268435456,
      maxAgeDays: 14,
      keepMin: 4,
      autoClean: false,
    });
    expect(artifactMaxBytes(invalid)).toBe(20 * 1024 * 1024 * 1024);
    expect(eventLedgerArchivePolicy(invalid).keepMin).toBe(2);
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
    expect(c.include).toEqual([]);
    expect(c.exclude).toEqual([]);
    expect(c.maxBytes).toBe(50 * 1_024 * 1_024);
    expect(c.schedule).toBeNull();
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

  test("reads selection, size, schedule, and a root-relative password file", () => {
    const root = makeRoot(
      `{ "backup": { "password_file": ".credentials/restic.password", "include": ["extra"], "exclude": ["workflow-run-history"], "max_bytes": 12345, "schedule": { "if_stale": "24h", "tags": ["daily"] } } }`,
    );
    roots.push(root);
    expect(backupConfig(root)).toMatchObject({
      passwordFile: join(root, ".credentials", "restic.password"),
      include: ["extra"],
      exclude: ["workflow-run-history"],
      maxBytes: 12345,
      schedule: { ifStale: "24h", tags: ["daily"] },
    });
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
