import { describe, expect, test } from "bun:test";
import { HARNESS_SPECS } from "../core/hooks/harness/events.ts";
import { engineRemovalHint, shouldPromptForState } from "./deinit.ts";
import { type SettingsFile, unwireHooks, wireHooks } from "./init.ts";

const HOOK = "harnery/bin/agent-hook";
const CLAUDE = HARNESS_SPECS["claude-code"];
const CURSOR = HARNESS_SPECS.cursor;

describe("unwireHooks", () => {
  test("round-trips wireHooks: removes exactly what init wired", () => {
    const settings: SettingsFile = {};
    const { wired } = wireHooks(settings, CLAUDE, HOOK, "claude-code");
    const { removed, remaining } = unwireHooks(settings);
    expect(removed).toBe(wired);
    expect(remaining).toBe(0);
    expect(settings.hooks).toBeUndefined(); // emptied hooks object dropped
  });

  test("preserves a non-harnery hook, drops only harnery's, keeps the key alive", () => {
    const settings: SettingsFile = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: `bash ${HOOK} stop --harness claude-code` }] },
          { hooks: [{ type: "command", command: "echo keep-me" }] },
        ],
        Notification: [{ hooks: [{ type: "command", command: "echo also-keep" }] }],
      },
    };
    const { removed, remaining } = unwireHooks(settings);
    expect(removed).toBe(1); // only the agent-hook Stop entry
    expect(remaining).toBe(2); // keep-me + also-keep
    expect(settings.hooks?.Stop.length).toBe(1);
    expect((settings.hooks?.Stop[0] as { hooks: { command: string }[] }).hooks[0].command).toBe(
      "echo keep-me",
    );
    expect(settings.hooks?.Notification[0]).toBeDefined();
  });

  test("drops a key whose only entries were harnery's", () => {
    const settings: SettingsFile = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: `bash ${HOOK} stop --harness claude-code` }] },
        ],
        Notification: [{ hooks: [{ type: "command", command: "echo keep" }] }],
      },
    };
    unwireHooks(settings);
    expect(settings.hooks?.Stop).toBeUndefined(); // emptied → dropped
    expect(settings.hooks?.Notification).toBeDefined(); // untouched
  });

  test("is idempotent: second pass removes nothing", () => {
    const settings: SettingsFile = {};
    wireHooks(settings, CLAUDE, HOOK, "claude-code");
    unwireHooks(settings);
    const second = unwireHooks(settings);
    expect(second.removed).toBe(0);
    expect(second.remaining).toBe(0);
  });

  test("no-op on a settings object with no hooks", () => {
    const settings: SettingsFile = { version: 1 };
    const { removed, remaining } = unwireHooks(settings);
    expect(removed).toBe(0);
    expect(remaining).toBe(0);
    expect(settings.version).toBe(1); // untouched
  });

  test("handles the Cursor flat entry shape", () => {
    const settings: SettingsFile = {};
    wireHooks(settings, CURSOR, HOOK, "cursor");
    const { removed } = unwireHooks(settings);
    expect(removed).toBe(CURSOR.events.length);
    expect(settings.hooks).toBeUndefined();
    expect(settings.version).toBe(1); // init's version key is left for the caller to judge
  });
});

describe("shouldPromptForState", () => {
  const base = {
    standalone: true,
    interactive: true,
    dryRun: false,
    purgeState: false,
    coordExists: true,
  };

  test("prompts for standalone harn on a TTY with state present", () => {
    expect(shouldPromptForState(base)).toBe(true);
  });

  test("never prompts off a TTY: scripts / CI stay flag-driven", () => {
    expect(shouldPromptForState({ ...base, interactive: false })).toBe(false);
  });

  test("never prompts for an embedding host (it owns its own UX)", () => {
    expect(shouldPromptForState({ ...base, standalone: false })).toBe(false);
  });

  test("skips the prompt when --purge-state already answered it", () => {
    expect(shouldPromptForState({ ...base, purgeState: true })).toBe(false);
  });

  test("skips the prompt during a dry run", () => {
    expect(shouldPromptForState({ ...base, dryRun: true })).toBe(false);
  });

  test("skips the prompt when there's no .harnery/ to delete", () => {
    expect(shouldPromptForState({ ...base, coordExists: false })).toBe(false);
  });
});

describe("engineRemovalHint", () => {
  test("names the npm removal and the clone path", () => {
    const hint = engineRemovalHint();
    expect(hint).toContain("npm rm -g harnery");
    expect(hint).toContain("teardown.sh");
  });
});
