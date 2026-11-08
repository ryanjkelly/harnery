import { describe, expect, test } from "bun:test";
import type { ComputerStatus, PermissionsReport } from "@/lib/permissions";
import {
  claudeBypasses,
  claudeSummary,
  codexSummary,
  computerAllowed,
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

  test("computer use: a person's own off is theirs, not the project's, and keeps the controls", () => {
    for (const mode_source of ["user-project", "user-default"]) {
      const own = computer("off", { enabled: false, mode_source });
      expect(computerAllowed(own)).toBe(true);
      expect(computerSummary(own)).toMatchObject({ level: "Off", tone: "neutral" });
      expect(computerSummary(own).sentence).toContain("You turned computer use off for yourself");
    }
    const saved = computer("off", {
      enabled: false,
      mode_source: "user-project",
      person_sign_in: true,
    });
    expect(computerSummary(saved).sentence).toContain("sign-in choice is saved");
    const projectOff = computer("off", { enabled: false, project_mode: "off" });
    expect(computerAllowed(projectOff)).toBe(false);
    expect(computerSummary(projectOff).sentence).toContain("This project does not let agents");
    const invalid = computer("off", {
      enabled: false,
      config_error: "computer.mode must be one of",
    });
    expect(computerAllowed(invalid)).toBe(false);
    expect(computerSummary(invalid)).toMatchObject({ level: "Off", tone: "danger" });
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
    expect(codexSummary(base).level).toBe("Default");
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
