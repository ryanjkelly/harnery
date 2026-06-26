/**
 * Locks the read-only wiring inspection that powers `harn doctor`'s harness-hook
 * check and the SessionStart drift nudge. The load-bearing rule: drift is only
 * reported for a harness the project has ALREADY opted into (≥1 hook wired), so
 * a bare `.claude/settings.json` never false-warns.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE_EVENTS, HARNESS_SPECS } from "./events.ts";
import { diffWiring, loadHarnessWiring, type SettingsFile } from "./wiring.ts";

const CLAUDE = HARNESS_SPECS["claude-code"];
const HOOK_BASE = "/repo/harnery/bin/agent-hook";

/** Build a Claude Code settings object wiring exactly the given subcommands. */
function settingsWiring(subcommands: string[]): SettingsFile {
  const hooks: Record<string, { hooks: { type: string; command: string }[] }[]> = {};
  for (const sub of subcommands) {
    const event = CLAUDE_CODE_EVENTS.find((e) => e.subcommand === sub);
    if (!event) throw new Error(`no spec event for ${sub}`);
    hooks[event.settingsKey] = [
      { hooks: [{ type: "command", command: `bash ${HOOK_BASE} ${sub} --harness claude-code` }] },
    ];
  }
  return { hooks };
}

describe("diffWiring", () => {
  test("fully wired → no missing, all present, no orphans", () => {
    const settings = settingsWiring(CLAUDE_CODE_EVENTS.map((e) => e.subcommand));
    const diff = diffWiring(settings, CLAUDE);
    expect(diff.missing).toHaveLength(0);
    expect(diff.present).toHaveLength(CLAUDE_CODE_EVENTS.length);
    expect(diff.orphans).toHaveLength(0);
  });

  test("partial wiring → reports exactly the missing events", () => {
    const wired = ["session-start", "stop"];
    const diff = diffWiring(settingsWiring(wired), CLAUDE);
    expect(diff.present.map((e) => e.subcommand).sort()).toEqual([...wired].sort());
    expect(diff.missing.map((e) => e.subcommand)).toContain("pre-tool-use");
    expect(diff.missing).toHaveLength(CLAUDE_CODE_EVENTS.length - wired.length);
  });

  test("empty settings → every spec event missing, none present", () => {
    const diff = diffWiring({}, CLAUDE);
    expect(diff.present).toHaveLength(0);
    expect(diff.missing).toHaveLength(CLAUDE_CODE_EVENTS.length);
  });

  test("`stop` does not falsely match `stop-failure` (trailing-space rule)", () => {
    // Wire ONLY stop-failure; `stop` must still read as missing.
    const diff = diffWiring(settingsWiring(["stop-failure"]), CLAUDE);
    expect(diff.present.map((e) => e.subcommand)).toEqual(["stop-failure"]);
    expect(diff.missing.map((e) => e.subcommand)).toContain("stop");
  });

  test("a wired subcommand not in the spec is reported as an orphan", () => {
    const settings: SettingsFile = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: `bash ${HOOK_BASE} session-start --harness claude-code` },
            ],
          },
        ],
        // A removed/renamed event left behind by an old init:
        LegacyEvent: [
          {
            hooks: [
              { type: "command", command: `bash ${HOOK_BASE} legacy-thing --harness claude-code` },
            ],
          },
        ],
      },
    };
    const diff = diffWiring(settings, CLAUDE);
    expect(diff.orphans).toEqual(["legacy-thing"]);
    expect(diff.present.map((e) => e.subcommand)).toEqual(["session-start"]);
  });

  test("non-harnery hooks are ignored (not counted as present or orphan)", () => {
    const settings: SettingsFile = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "bash /repo/scripts/my-own-hook.sh" }] },
        ],
      },
    };
    const diff = diffWiring(settings, CLAUDE);
    expect(diff.present).toHaveLength(0);
    expect(diff.orphans).toHaveLength(0);
    expect(diff.missing).toHaveLength(CLAUDE_CODE_EVENTS.length);
  });
});

describe("loadHarnessWiring (fs-backed)", () => {
  let dir: string;

  function setup(): string {
    dir = mkdtempSync(join(tmpdir(), "harnery-wiring-"));
    return dir;
  }
  function teardown(): void {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  function writeClaudeSettings(root: string, settings: SettingsFile): void {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  }

  test("no settings file → no drift", () => {
    const root = setup();
    try {
      expect(loadHarnessWiring(root)).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  test("opted-in + fully current → no drift", () => {
    const root = setup();
    try {
      writeClaudeSettings(root, settingsWiring(CLAUDE_CODE_EVENTS.map((e) => e.subcommand)));
      expect(loadHarnessWiring(root)).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  test("opted-in + missing some → drift reported with the missing subcommands", () => {
    const root = setup();
    try {
      writeClaudeSettings(root, settingsWiring(["session-start", "stop"]));
      const drift = loadHarnessWiring(root);
      expect(drift).toHaveLength(1);
      expect(drift[0]!.harness).toBe("claude-code");
      expect(drift[0]!.missing.map((m) => m.subcommand)).toContain("pre-tool-use");
    } finally {
      teardown();
    }
  });

  test("NOT opted in (zero harnery hooks present) → NOT drift, even with a settings file", () => {
    const root = setup();
    try {
      // A generic Claude Code settings.json with only the user's own hooks.
      writeClaudeSettings(root, {
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      });
      expect(loadHarnessWiring(root)).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  test("unparseable settings file → skipped (no throw)", () => {
    const root = setup();
    try {
      mkdirSync(join(root, ".claude"), { recursive: true });
      writeFileSync(join(root, ".claude", "settings.json"), "{ not valid json");
      expect(loadHarnessWiring(root)).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  test("orphan-only drift is reported when opted in", () => {
    const root = setup();
    try {
      writeClaudeSettings(root, {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `bash ${HOOK_BASE} session-start --harness claude-code`,
                },
              ],
            },
          ],
          ...settingsWiring(CLAUDE_CODE_EVENTS.map((e) => e.subcommand)).hooks,
          LegacyEvent: [
            {
              hooks: [
                { type: "command", command: `bash ${HOOK_BASE} gone-event --harness claude-code` },
              ],
            },
          ],
        },
      });
      const drift = loadHarnessWiring(root);
      expect(drift).toHaveLength(1);
      expect(drift[0]!.missing).toHaveLength(0);
      expect(drift[0]!.orphans).toEqual(["gone-event"]);
    } finally {
      teardown();
    }
  });
});
