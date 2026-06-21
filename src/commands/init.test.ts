import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripJsonComments } from "../core/config.ts";
import { HARNESS_SPECS } from "../core/hooks/harness/events.ts";
import { stampBinName, wireHooks } from "./init.ts";

const HOOK = "harnery/bin/agent-hook";
const CLAUDE = HARNESS_SPECS["claude-code"];
const CURSOR = HARNESS_SPECS.cursor;
const CODEX = HARNESS_SPECS.codex;

describe("wireHooks: Claude Code", () => {
  test("wires every event into an empty settings object", () => {
    const settings: Record<string, unknown> = {};
    const { wired, already } = wireHooks(settings as never, CLAUDE, HOOK, "claude-code");
    expect(wired).toBe(CLAUDE.events.length);
    expect(already).toBe(0);
    const hooks = (settings as { hooks: Record<string, unknown[]> }).hooks;
    expect(Object.keys(hooks).length).toBe(CLAUDE.events.length);
    expect(hooks.Stop[0]).toEqual({
      hooks: [{ type: "command", command: `bash ${HOOK} stop --harness claude-code` }],
    });
  });

  test("is idempotent: second pass wires nothing", () => {
    const settings: Record<string, unknown> = {};
    wireHooks(settings as never, CLAUDE, HOOK, "claude-code");
    const second = wireHooks(settings as never, CLAUDE, HOOK, "claude-code");
    expect(second.wired).toBe(0);
    expect(second.already).toBe(CLAUDE.events.length);
    const hooks = (settings as { hooks: Record<string, unknown[]> }).hooks;
    expect(hooks.Stop.length).toBe(1); // no duplicate groups appended
  });

  test("preserves unrelated hooks + an already-present harnery hook", () => {
    const settings = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: `bash ${HOOK} stop --harness claude-code` }] },
        ],
        Notification: [{ hooks: [{ type: "command", command: "echo keep-me" }] }],
      },
    };
    const { wired, already } = wireHooks(settings as never, CLAUDE, HOOK, "claude-code");
    expect(already).toBe(1); // Stop
    expect(wired).toBe(CLAUDE.events.length - 1);
    expect(settings.hooks.Stop.length).toBe(1); // not duplicated
    expect(settings.hooks.Notification[0].hooks[0].command).toBe("echo keep-me");
  });

  test("`stop` does not match `stop-failure` (trailing-space disambiguation)", () => {
    const settings = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: `bash ${HOOK} stop --harness claude-code` }] },
        ],
      },
    };
    wireHooks(settings as never, CLAUDE, HOOK, "claude-code");
    const sf = (settings as never as { hooks: Record<string, unknown[]> }).hooks.StopFailure;
    expect(sf.length).toBe(1); // stop-failure was still wired
  });
});

describe("wireHooks: Cursor", () => {
  test("uses the flat entry shape, sets version, wires beforeShellExecution, omits StopFailure", () => {
    const settings: Record<string, unknown> = {};
    const { wired, already } = wireHooks(settings as never, CURSOR, HOOK, "cursor");
    expect(wired).toBe(CURSOR.events.length);
    expect(already).toBe(0);
    expect((settings as { version: number }).version).toBe(1);
    const hooks = (settings as { hooks: Record<string, unknown[]> }).hooks;
    // Flat `{ command }`, no inner `hooks` array.
    expect(hooks.stop[0]).toEqual({ command: `bash ${HOOK} stop --harness cursor` });
    expect(hooks.beforeShellExecution[0]).toEqual({
      command: `bash ${HOOK} before-shell-execution --harness cursor`,
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
});

describe("wireHooks: Codex", () => {
  test("uses the Claude entry shape with PascalCase keys and no version", () => {
    const settings: Record<string, unknown> = {};
    const { wired } = wireHooks(settings as never, CODEX, HOOK, "codex");
    expect(wired).toBe(CODEX.events.length);
    expect((settings as { version?: number }).version).toBeUndefined();
    const hooks = (settings as { hooks: Record<string, unknown[]> }).hooks;
    expect(hooks.SessionStart[0]).toEqual({
      hooks: [{ type: "command", command: `bash ${HOOK} session-start --harness codex` }],
    });
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
    const action = stampBinName(p, "bp", false);
    expect(action).toContain("stamped");
    expect(parse(p)).toEqual({ binName: "bp" });
    expect(readFileSync(p, "utf8")).toContain("//"); // keeps the explanatory comment
  });

  test("no-op when binName already matches", () => {
    const p = cfgPath();
    writeFileSync(p, `{ "binName": "bp" }`);
    expect(stampBinName(p, "bp", false)).toBeNull();
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
    const action = stampBinName(p, "bp", false);
    expect(action).toContain("added");
    const parsed = parse(p);
    expect(parsed.binName).toBe("bp");
    expect(parsed.files).toEqual({ deny_globs: ["**/*.secret"] });
    expect(readFileSync(p, "utf8")).toContain("// policy");
  });

  test("dry-run reports without writing", () => {
    const p = cfgPath();
    const action = stampBinName(p, "bp", true);
    expect(action).toContain("would");
    expect(existsSync(p)).toBe(false);
  });
});
