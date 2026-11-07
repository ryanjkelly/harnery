import { describe, expect, test } from "bun:test";
import type { ComputerStatus, PermissionsReport } from "@/lib/permissions";
import {
  claudeBypasses,
  claudeSummary,
  codexSummary,
  computerSummary,
  cursorSummary,
} from "./levels";

function claude(
  defaultMode: string,
  extra: Partial<PermissionsReport["claude"]["effective"]> = {},
): PermissionsReport["claude"] {
  return {
    configDir: "/x",
    sources: [],
    effective: {
      defaultMode,
      defaultModeSource: "user",
      allow: [{ rule: "Read", source: "project (shared)" }],
      ask: [],
      deny: [],
      additionalDirectories: [],
      bypassDisabled: false,
      sandboxEnabled: false,
      ...extra,
    },
  };
}

function computer(mode: string, extra: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    enabled: true,
    mode,
    project_mode: "ask-each-task",
    mode_source: "project",
    host: { kind: "linux" },
    default_driver: null,
    drivers: [],
    lease: null,
    ...extra,
  };
}

describe("tool summaries", () => {
  test("computer use: on is amber, the project switch wins, a read error is red", () => {
    expect(computerSummary(computer("on"))).toMatchObject({ level: "No limits", tone: "warn" });
    expect(computerSummary(computer("ask-once-per-session")).tone).toBe("neutral");
    expect(computerSummary(computer("on", { project_mode: "off" })).level).toBe("Off");
    expect(computerSummary(undefined, "boom")).toMatchObject({ tone: "danger" });
  });

  test("Claude Code: bypass is amber unless policy turns it off", () => {
    expect(claudeSummary(claude("bypassPermissions"))).toMatchObject({
      level: "No limits",
      tone: "warn",
    });
    expect(claudeBypasses(claude("bypassPermissions"))).toBe(true);
    const blocked = claude("bypassPermissions", { bypassDisabled: true });
    expect(claudeBypasses(blocked)).toBe(false);
    expect(claudeSummary(blocked).tone).toBe("neutral");
    expect(claudeSummary(claude("default")).sentence).toContain("1 allowed action.");
  });

  test("Codex: amber for any wide-open value, plain default when unset", () => {
    const base = { available: true, hooks: [] };
    expect(codexSummary(base).level).toBe("Codex default");
    expect(
      codexSummary({ ...base, approvalPolicy: "never", sandboxMode: "danger-full-access" }),
    ).toMatchObject({ level: "No limits", tone: "warn" });
    expect(codexSummary({ ...base, approvalPolicy: "never" }).tone).toBe("warn");
    expect(
      codexSummary({ ...base, approvalPolicy: "untrusted", sandboxMode: "workspace-write" }),
    ).toMatchObject({ level: "Asks first", tone: "neutral" });
    expect(codexSummary({ available: false, error: "x", hooks: [] }).tone).toBe("danger");
  });

  test("Cursor: run-everything is amber; no settings is not set up", () => {
    const src = [{ scope: "user", path: "/x", exists: true, allow: [], deny: [] }];
    expect(
      cursorSummary({
        sources: src,
        effective: { approvalMode: "run-everything", allow: [], deny: [] },
      }),
    ).toMatchObject({ level: "No limits", tone: "warn" });
    expect(
      cursorSummary({ sources: [{ ...src[0], exists: false }], effective: { allow: [], deny: [] } })
        .level,
    ).toBe("Not set up");
  });
});
