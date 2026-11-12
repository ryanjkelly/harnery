import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { canonicalJsonV3, sha256V3 } from "../events/v3/canonical.ts";
import { adapterCapabilityProfileDigestV3 } from "../events/v3/capabilities.ts";
import {
  buildCandidateGenesisManifestV3,
  EVENT_V3_GENESIS_MANIFEST,
} from "../events/v3/control.ts";
import { repairEventV3ControlPair } from "../events/v3/control-writer.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "../events/v3/fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../events/v3/generated.ts";
import { buildHelperLimitNote } from "./helper-limit-note.ts";

const OPUS_MEDIUM = { max_model: "opus", max_effort: "medium" };
const EXPECTED =
  "Helper limit: the person has limited helper agents (subagents) to Opus at Medium effort or cheaper. " +
  "Start helpers at that level or lower; Harnery lowers a helper above it where it can. " +
  "If the person asks for a stronger helper, tell them the limit applies. " +
  "`acme devtools helpers` changes it.";

describe("buildHelperLimitNote", () => {
  test("words the limit and the host's bin name for Claude Code", () => {
    expect(
      buildHelperLimitNote({
        adapter: "claude-code",
        limit: OPUS_MEDIUM,
        skipped: false,
        bin: "acme",
      }),
    ).toBe(EXPECTED);
    expect(
      buildHelperLimitNote({
        adapter: "claude-code",
        limit: { max_effort: "low" },
        skipped: false,
        bin: "harn",
      }),
    ).toContain("to Low effort or cheaper. ");
  });

  test("adds nothing for another adapter, no limit, or the skip switch", () => {
    const base = { adapter: "claude-code", limit: OPUS_MEDIUM, skipped: false, bin: "acme" };
    for (const adapter of ["codex", "cursor", "opencode"]) {
      expect(buildHelperLimitNote({ ...base, adapter })).toBe("");
    }
    expect(buildHelperLimitNote({ ...base, limit: null })).toBe("");
    expect(buildHelperLimitNote({ ...base, limit: {} })).toBe("");
    expect(buildHelperLimitNote({ ...base, skipped: true })).toBe("");
  });
});

// SessionStart integration: the line reaches the agent's opening context.
const HARNERY_DIR = resolve(import.meta.dir, "../../..");
const AGENT_HOOK = join(HARNERY_DIR, "bin", "agent-hook");
const HOOK_ENTRY = join(HARNERY_DIR, "src", "core", "hooks", "cli.ts");
const roots: string[] = [];

setDefaultTimeout(process.platform === "win32" ? 90_000 : 15_000);

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root, 30_000);
});

function candidateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harn-helper-note-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery", "active"), { recursive: true });
  mkdirSync(join(root, ".harnery", "pid-map"), { recursive: true });
  writeFileSync(join(root, ".harnery", ".lock"), "");
  symlinkSync(HARNERY_DIR, join(root, "harnery"));
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(["add", "seed.txt"]);
  git(["commit", "-qm", "seed"]);

  const keys = loadOrCreateFingerprintKeyStoreV3(root);
  const manifest = buildCandidateGenesisManifestV3({
    profile: {
      initial_schema_digest: EVENT_V3_SCHEMA_DIGEST,
      contract_source_digest: sha256V3("contract"),
      harnery_commit: "fixture",
      host_repository_commit: "fixture",
      producer_build_ids: ["build_fixture"],
      adapter_capability_profile_digests: [
        `sha256:${adapterCapabilityProfileDigestV3("claude-code").slice(4)}`,
      ],
      config_digest: sha256V3("config"),
      canonicalizer_version: "harnery-jcs-nfc-v1",
      fingerprint_version: "hmac-sha256-v1",
      privacy_key_epoch: keys.active_epoch_id,
      candidate_created_at: "2026-08-16T18:00:00.000Z",
    },
    root_id: "root_fixture",
    instance_id: "inst_cutover",
    producer: {
      producer_id: "prd_cutover",
      boot_id: "boot_cutover",
      sequence: 1,
      build_id: "build_fixture",
      platform: "linux",
    },
  });
  const manifestPath = join(root, EVENT_V3_GENESIS_MANIFEST);
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, `${canonicalJsonV3(manifest)}\n`, { mode: 0o600 });
  expect(repairEventV3ControlPair(root).state).toBe("candidate");
  return root;
}

function sessionStart(root: string, extraEnv: Record<string, string>): string {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of [
    "HARNERY_AGENT_COORD_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "HARNERY_AGENT_COORD_OWNER",
    "HARNERY_AGENT_COORD_BRIDGE",
    "HARNERY_WORKFLOW_CHILD",
    "HARNERY_HELPER_LIMIT_SKIP",
  ]) {
    delete env[key];
  }
  // The hook installs the helper plugin into the Claude Code user settings when a
  // limit is in effect, so keep the home folder and Claude Code's config folder
  // inside the test root as well as the config home.
  const home = join(root, "home");
  const claudeConfig = join(root, "claude-config");
  mkdirSync(home, { recursive: true });
  mkdirSync(claudeConfig, { recursive: true });
  const native = process.platform === "win32";
  const result = spawnSync(
    native ? process.execPath : "bash",
    [native ? HOOK_ENTRY : AGENT_HOOK, "session-start", "--adapter", "claude-code"],
    {
      input: JSON.stringify({
        session_id: `helper-note-${roots.length}`,
        cwd: root,
        source: "startup",
        hook_event_name: "SessionStart",
      }),
      cwd: root,
      encoding: "utf8",
      env: {
        ...env,
        HARNERY_COORD_ROOT_OVERRIDE: root,
        HARNERY_AGENT_COORD_BYPASS_STOP: "1",
        HARNERY_BIN: "acme",
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: claudeConfig,
        ...extraEnv,
      },
    },
  );
  expect(result.status).toBe(0);
  return result.stdout ?? "";
}

describe("SessionStart helper-limit line", () => {
  test("appears when the project sets a limit and is absent when none is set", () => {
    // An empty config home keeps the real person's preferences out of the test.
    const unlimited = candidateRoot();
    const noneOut = sessionStart(unlimited, { XDG_CONFIG_HOME: join(unlimited, "xdg") });
    expect(noneOut).toContain("SessionStart");
    expect(noneOut).not.toContain("Helper limit:");

    const limited = candidateRoot();
    writeFileSync(
      join(limited, ".harnery", "config.jsonc"),
      JSON.stringify({ helpers: { "claude-code": OPUS_MEDIUM } }),
    );
    const limitedOut = sessionStart(limited, { XDG_CONFIG_HOME: join(limited, "xdg") });
    expect(limitedOut).toContain(EXPECTED);
    // The same session start installs the helper plugin, inside the test root only.
    const pluginDir = join(limited, "xdg", "harnery", "claude-code-plugin");
    expect(existsSync(join(pluginDir, "hooks", "register.js"))).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(limited, "claude-config", "settings.json"), "utf8"),
    );
    expect(settings.env.CLAUDE_CODE_PLUGIN_DIRS).toBe(pluginDir);
    expect(existsSync(join(unlimited, "claude-config", "settings.json"))).toBe(false);

    const skipped = sessionStart(limited, {
      XDG_CONFIG_HOME: join(limited, "xdg"),
      HARNERY_HELPER_LIMIT_SKIP: "1",
    });
    expect(skipped).not.toContain("Helper limit:");
  });

  test("the person's choice from preferences.json reaches the line", () => {
    const root = candidateRoot();
    const xdg = join(root, "xdg");
    mkdirSync(join(xdg, "harnery"), { recursive: true });
    writeFileSync(
      join(xdg, "harnery", "preferences.json"),
      JSON.stringify({ helpers: { "claude-code": { max_model: "sonnet" } } }),
    );
    const out = sessionStart(root, { XDG_CONFIG_HOME: xdg });
    expect(out).toContain("limited helper agents (subagents) to Sonnet or cheaper.");
  });
});
