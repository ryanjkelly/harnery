import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripJsonComments } from "../core/config.ts";
import { initializeEventLedgerV3, sha256V3 } from "../core/events/v3/index.ts";
import { ADAPTER_SPECS } from "../core/hooks/adapter/events.ts";
import {
  codexHookReviewAction,
  eventLedgerV3RuntimeIssues,
  stampBinName,
  stampWorkflowDefaults,
  wireHooks,
} from "./init.ts";

const HOOK = "harnery/bin/agent-hook";
// Claude Code exports CLAUDE_PROJECT_DIR to hook processes; init anchors the
// path on it so hooks survive the session shell `cd`ing away from the root.
const CLAUDE_HOOK = `"\${CLAUDE_PROJECT_DIR:-.}"/${HOOK}`;
const CLAUDE = ADAPTER_SPECS["claude-code"];
const CURSOR = ADAPTER_SPECS.cursor;
const CODEX = ADAPTER_SPECS.codex;

describe("wireHooks: Claude Code", () => {
  test("wires every event into an empty settings object", () => {
    const settings: Record<string, unknown> = {};
    const { wired, already } = wireHooks(settings as never, CLAUDE, HOOK, "claude-code");
    expect(wired).toBe(CLAUDE.events.length);
    expect(already).toBe(0);
    const hooks = (settings as { hooks: Record<string, unknown[]> }).hooks;
    expect(Object.keys(hooks).length).toBe(CLAUDE.events.length);
    expect(hooks.Stop[0]).toEqual({
      hooks: [{ type: "command", command: `bash ${CLAUDE_HOOK} stop --adapter claude-code` }],
    });
  });

  test("is idempotent: second pass wires nothing", () => {
    const settings: Record<string, unknown> = {};
    wireHooks(settings as never, CLAUDE, HOOK, "claude-code");
    const second = wireHooks(settings as never, CLAUDE, HOOK, "claude-code");
    expect(second.wired).toBe(0);
    expect(second.upgraded).toBe(0);
    expect(second.already).toBe(CLAUDE.events.length);
    const hooks = (settings as { hooks: Record<string, unknown[]> }).hooks;
    expect(hooks.Stop.length).toBe(1); // no duplicate groups appended
  });

  test("preserves unrelated hooks + an already-present harnery hook", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: `bash ${CLAUDE_HOOK} stop --adapter claude-code` }],
          },
        ],
        Notification: [{ hooks: [{ type: "command", command: "echo keep-me" }] }],
      },
    };
    const { wired, already, upgraded } = wireHooks(settings as never, CLAUDE, HOOK, "claude-code");
    expect(already).toBe(1); // Stop
    expect(upgraded).toBe(0); // already canonical
    expect(wired).toBe(CLAUDE.events.length - 1);
    expect(settings.hooks.Stop.length).toBe(1); // not duplicated
    expect(settings.hooks.Notification[0].hooks[0].command).toBe("echo keep-me");
  });

  test("upgrades a stale bare-relative command in place (no duplicate entry)", () => {
    const settings = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: `bash ${HOOK} stop --adapter claude-code` }] },
        ],
      },
    };
    const { already, upgraded } = wireHooks(settings as never, CLAUDE, HOOK, "claude-code");
    expect(already).toBe(1);
    expect(upgraded).toBe(1);
    expect(settings.hooks.Stop.length).toBe(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(
      `bash ${CLAUDE_HOOK} stop --adapter claude-code`,
    );
  });

  test("`stop` does not match `stop-failure` (trailing-space disambiguation)", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: `bash ${CLAUDE_HOOK} stop --adapter claude-code` }],
          },
        ],
      },
    };
    wireHooks(settings as never, CLAUDE, HOOK, "claude-code");
    const sf = (settings as never as { hooks: Record<string, unknown[]> }).hooks.StopFailure;
    expect(sf.length).toBe(1); // stop-failure was still wired
  });
});

describe("wireHooks: Cursor", () => {
  test("uses the flat entry shape, sets version, and installs shell fallbacks without StopFailure", () => {
    const settings: Record<string, unknown> = {};
    const { wired, already } = wireHooks(settings as never, CURSOR, HOOK, "cursor");
    expect(wired).toBe(CURSOR.events.length);
    expect(already).toBe(0);
    expect((settings as { version: number }).version).toBe(1);
    const hooks = (settings as { hooks: Record<string, unknown[]> }).hooks;
    // Flat `{ command }`, no inner `hooks` array.
    expect(hooks.stop[0]).toEqual({ command: `bash ${HOOK} stop --adapter cursor` });
    expect(hooks.preCompact[0]).toEqual({ command: `bash ${HOOK} pre-compact --adapter cursor` });
    expect(hooks.beforeShellExecution[0]).toEqual({
      command: `bash ${HOOK} before-shell-execution --adapter cursor`,
    });
    expect(hooks.afterShellExecution[0]).toEqual({
      command: `bash ${HOOK} after-shell-execution --adapter cursor`,
    });
    expect(hooks.StopFailure).toBeUndefined(); // Cursor has no StopFailure event
  });

  test("is idempotent with the flat shape", () => {
    const settings: Record<string, unknown> = {};
    wireHooks(settings as never, CURSOR, HOOK, "cursor");
    const second = wireHooks(settings as never, CURSOR, HOOK, "cursor");
    expect(second.wired).toBe(0);
    expect(second.already).toBe(CURSOR.events.length);
    const hooks = (settings as { hooks: Record<string, unknown[]> }).hooks;
    expect(hooks.stop.length).toBe(1); // not duplicated
  });

  test("keeps the canonical shell fallback and preserves unrelated commands", () => {
    const settings = {
      version: 1,
      hooks: {
        beforeShellExecution: [
          { command: `bash ${HOOK} before-shell-execution --adapter cursor` },
          { command: "bash scripts/hooks/host-shell-check" },
        ],
      },
    };
    const result = wireHooks(settings as never, CURSOR, HOOK, "cursor");
    expect(result.removed).toBe(0);
    expect(settings.hooks.beforeShellExecution).toEqual([
      { command: `bash ${HOOK} before-shell-execution --adapter cursor` },
      { command: "bash scripts/hooks/host-shell-check" },
    ]);
  });
});

describe("wireHooks: Codex", () => {
  test("requires explicit hook review before a fresh task", () => {
    const action = codexHookReviewAction("codex");
    expect(action).toContain("/hooks");
    expect(action).toContain("Settings > Hooks");
    expect(action).toContain("fresh task");
    expect(codexHookReviewAction("cursor")).toBeNull();
  });

  test("uses the Claude entry shape with PascalCase keys and no version", () => {
    const settings: Record<string, unknown> = {};
    const { wired } = wireHooks(settings as never, CODEX, HOOK, "codex");
    expect(wired).toBe(CODEX.events.length);
    expect((settings as { version?: number }).version).toBeUndefined();
    const hooks = (settings as { hooks: Record<string, unknown[]> }).hooks;
    expect(hooks.SessionStart[0]).toEqual({
      hooks: [{ type: "command", command: `bash ${HOOK} session-start --adapter codex` }],
    });
    expect(hooks.PermissionRequest[0]).toEqual({
      hooks: [{ type: "command", command: `bash ${HOOK} permission-request --adapter codex` }],
    });
  });

  test("keeps current SessionEnd and removes legacy Codex events", () => {
    const settings = {
      description: "coord hooks",
      hooks: {
        SessionEnd: [
          { hooks: [{ type: "command", command: `bash ${HOOK} session-end --adapter codex` }] },
          { hooks: [{ type: "command", command: "echo keep-me" }] },
        ],
        StopFailure: [
          { hooks: [{ type: "command", command: `bash ${HOOK} stop-failure --adapter codex` }] },
        ],
      },
    };
    const { removed } = wireHooks(settings as never, CODEX, HOOK, "codex");
    expect(removed).toBe(1);
    expect(settings.hooks.SessionEnd).toHaveLength(2);
    expect(settings.hooks.SessionEnd[0]!.hooks[0]!.command).toContain(
      "session-end --adapter codex",
    );
    expect(settings.hooks.SessionEnd[1]!.hooks[0]!.command).toBe("echo keep-me");
    expect((settings.hooks as Record<string, unknown>).StopFailure).toBeUndefined();
  });

  test("wires the current SessionEnd lifecycle event", () => {
    const settings: Record<string, unknown> = {};
    wireHooks(settings as never, CODEX, HOOK, "codex");
    const hooks = (settings as { hooks: Record<string, unknown[]> }).hooks;
    expect(hooks.SessionEnd).toHaveLength(1);
  });
});

describe("wireHooks: migration cleanup", () => {
  test("deduplicates repeated Harnery commands while keeping host handlers in a mixed group", () => {
    const command = `bash ${CLAUDE_HOOK} session-start --adapter claude-code`;
    const settings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command },
              { type: "command", command: "bash scripts/hooks/host-start" },
              { type: "command", command },
            ],
          },
          { hooks: [{ type: "command", command }] },
        ],
      },
    };
    const result = wireHooks(settings as never, CLAUDE, HOOK, "claude-code");
    expect(result.removed).toBe(2);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0]!.hooks.map((hook) => hook.command)).toEqual([
      command,
      "bash scripts/hooks/host-start",
    ]);
  });

  test("moves a Harnery subcommand off the wrong event and preserves that event's host handler", () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: `bash ${HOOK} pre-compact --adapter claude-code` },
              { type: "command", command: "echo host-stop" },
            ],
          },
        ],
      },
    };
    const result = wireHooks(settings as never, CLAUDE, HOOK, "claude-code");
    expect(result.removed).toBe(1);
    expect(settings.hooks.Stop[0]!.hooks[0]!.command).toBe("echo host-stop");
    expect((settings.hooks as Record<string, unknown[]>).PreCompact).toHaveLength(1);
  });

  test("preserves Cursor metadata on the surviving canonical entry", () => {
    const settings = {
      version: 1,
      hooks: {
        stop: [
          { command: `bash ${HOOK} stop --adapter cursor`, loop_limit: 2 },
          { command: `bash ${HOOK} stop --adapter cursor` },
        ],
      },
    };
    const result = wireHooks(settings as never, CURSOR, HOOK, "cursor");
    expect(result.removed).toBe(1);
    expect(settings.hooks.stop).toEqual([
      { command: `bash ${HOOK} stop --adapter cursor`, loop_limit: 2 },
    ]);
  });
});

describe("event ledger V3 init compatibility", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("requires an epoch refresh when the live producer build changes", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-init-v3-runtime-"));
    dirs.push(root);
    const initialized = initializeEventLedgerV3({
      coordRoot: root,
      harneryBuild: "fixture",
      hostBuild: "fixture",
      configDigest: sha256V3("config"),
      approvalRecordId: "test-init-runtime",
      now: () => new Date("2026-08-18T12:00:00.000Z"),
    });
    expect(eventLedgerV3RuntimeIssues(initialized.control, "fixture")).toEqual([]);
    expect(eventLedgerV3RuntimeIssues(initialized.control, "next-build")).toContain(
      "producer build",
    );
  });
});

describe("stampBinName", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const cfgPath = () => {
    const d = mkdtempSync(join(tmpdir(), "harnery-stamp-"));
    dirs.push(d);
    return join(d, "config.jsonc");
  };
  const parse = (p: string) => JSON.parse(stripJsonComments(readFileSync(p, "utf8")));

  test("creates a commented stub when config is absent", () => {
    const p = cfgPath();
    const action = stampBinName(p, "acme", false);
    expect(action).toContain("stamped");
    expect(parse(p)).toEqual({ binName: "acme" });
    expect(readFileSync(p, "utf8")).toContain("//"); // keeps the explanatory comment
  });

  test("no-op when binName already matches", () => {
    const p = cfgPath();
    writeFileSync(p, `{ "binName": "acme" }`);
    expect(stampBinName(p, "acme", false)).toBeNull();
  });

  test("swaps an existing differing value, preserving comments", () => {
    const p = cfgPath();
    writeFileSync(p, `{\n  // host\n  "binName": "old"\n}`);
    const action = stampBinName(p, "myapp", false);
    expect(action).toContain("updated");
    expect(parse(p)).toEqual({ binName: "myapp" });
    expect(readFileSync(p, "utf8")).toContain("// host");
  });

  test("splices binName as first key, preserving a files section + comments", () => {
    const p = cfgPath();
    writeFileSync(p, `{\n  // policy\n  "files": { "deny_globs": ["**/*.secret"] }\n}\n`);
    const action = stampBinName(p, "acme", false);
    expect(action).toContain("added");
    const parsed = parse(p);
    expect(parsed.binName).toBe("acme");
    expect(parsed.files).toEqual({ deny_globs: ["**/*.secret"] });
    expect(readFileSync(p, "utf8")).toContain("// policy");
  });

  test("dry-run reports without writing", () => {
    const p = cfgPath();
    const action = stampBinName(p, "acme", true);
    expect(action).toContain("would");
    expect(existsSync(p)).toBe(false);
  });
});

describe("stampWorkflowDefaults", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const cfgPath = () => {
    const d = mkdtempSync(join(tmpdir(), "harnery-wfstamp-"));
    dirs.push(d);
    return join(d, "config.jsonc");
  };
  const parse = (p: string) => JSON.parse(stripJsonComments(readFileSync(p, "utf8")));

  test("creates a commented stub when config is absent", () => {
    const p = cfgPath();
    const action = stampWorkflowDefaults(p, false);
    expect(action).toContain("pinned");
    expect(parse(p)).toEqual({ workflow: { subscriptionOnly: true } });
    expect(readFileSync(p, "utf8")).toContain("HARNERY_WORKFLOW_SUBSCRIPTION_ONLY=0");
  });

  test("splices the pin as first key, preserving binName + comments", () => {
    const p = cfgPath();
    writeFileSync(p, `{\n  // host\n  "binName": "acme"\n}\n`);
    const action = stampWorkflowDefaults(p, false);
    expect(action).toContain("pinned");
    expect(parse(p)).toEqual({ workflow: { subscriptionOnly: true }, binName: "acme" });
    expect(readFileSync(p, "utf8")).toContain("// host");
  });

  test("a workflow key of ANY shape is a deliberate choice: never touched", () => {
    const p = cfgPath();
    writeFileSync(p, `{ "workflow": { "subscriptionOnly": false } }`);
    expect(stampWorkflowDefaults(p, false)).toBeNull();
    expect(parse(p)).toEqual({ workflow: { subscriptionOnly: false } });
    writeFileSync(p, `{ "workflow": {} }`);
    expect(stampWorkflowDefaults(p, false)).toBeNull();
  });

  test("unparseable config is skipped, not clobbered", () => {
    const p = cfgPath();
    writeFileSync(p, `{ not json`);
    const action = stampWorkflowDefaults(p, false);
    expect(action).toContain("skipped");
    expect(readFileSync(p, "utf8")).toBe(`{ not json`);
  });

  test("dry-run reports without writing", () => {
    const p = cfgPath();
    const action = stampWorkflowDefaults(p, true);
    expect(action).toContain("would");
    expect(existsSync(p)).toBe(false);
  });
});
