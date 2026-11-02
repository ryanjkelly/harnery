import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexProjectKey,
  readClaudePermissions,
  readCursorPermissions,
  summarizeCodex,
} from "./index.ts";

let dir: string;
let project: string;
let home: string;

function write(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harnery-permissions-"));
  project = join(dir, "project");
  home = join(dir, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readClaudePermissions", () => {
  test("merges rules from every file and takes the mode from the most specific one", () => {
    write(join(home, ".claude", "settings.json"), {
      permissions: { defaultMode: "acceptEdits", allow: ["Bash(git status)"] },
      env: { SECRET_TOKEN: "do-not-read" },
    });
    write(join(project, ".claude", "settings.json"), {
      permissions: { deny: ["Read(.credentials/**)"] },
      sandbox: { enabled: true },
    });
    // JSONC comments are tolerated, as Claude Code allows them.
    write(
      join(project, ".claude", "settings.local.json"),
      '{ // mine\n "permissions": { "defaultMode": "plan", "ask": ["Bash(git push:*)"] } }',
    );
    const result = readClaudePermissions(project, { env: {}, home, platform: "linux" });
    expect(result.effective.defaultMode).toBe("plan");
    expect(result.effective.defaultModeSource).toBe("project (this computer)");
    expect(result.effective.allow).toEqual([{ rule: "Bash(git status)", source: "user" }]);
    expect(result.effective.ask).toEqual([
      { rule: "Bash(git push:*)", source: "project (this computer)" },
    ]);
    expect(result.effective.deny).toEqual([
      { rule: "Read(.credentials/**)", source: "project (shared)" },
    ]);
    expect(result.effective.sandboxEnabled).toBe(true);
    // Only permission fields are read back.
    expect(JSON.stringify(result)).not.toContain("do-not-read");
  });

  test("honours CLAUDE_CONFIG_DIR and reports a broken file without failing", () => {
    const custom = join(dir, "profile");
    write(join(custom, "settings.json"), "{ not json");
    const result = readClaudePermissions(project, {
      env: { CLAUDE_CONFIG_DIR: custom },
      home,
      platform: "linux",
    });
    expect(result.configDir).toBe(custom);
    const user = result.sources.find((s) => s.scope === "user");
    expect(user?.exists).toBe(true);
    expect(user?.error).toBeTruthy();
    expect(result.effective.defaultMode).toBe("default");
  });
});

describe("readCursorPermissions", () => {
  test("reads the allow and deny lists, approval mode and sandbox, never account details", () => {
    write(join(home, ".cursor", "cli-config.json"), {
      permissions: { allow: ["Shell(ls)"], deny: [] },
      approvalMode: "allowlist",
      sandbox: { mode: "disabled", networkAccess: "user_config_with_defaults" },
      autoAcceptWebSearch: false,
      authInfo: { email: "person@example.com" },
    });
    write(join(project, ".cursor", "cli.json"), { permissions: { deny: ["Shell(rm)"] } });
    const result = readCursorPermissions(project, { home });
    expect(result.effective.approvalMode).toBe("allowlist");
    expect(result.effective.sandboxMode).toBe("disabled");
    expect(result.effective.allow).toEqual([{ rule: "Shell(ls)", source: "user" }]);
    expect(result.effective.deny).toEqual([{ rule: "Shell(rm)", source: "project" }]);
    expect(JSON.stringify(result)).not.toContain("person@example.com");
  });

  test("missing files are reported, not errors", () => {
    const result = readCursorPermissions(project, { home });
    expect(result.sources.every((s) => !s.exists && !s.error)).toBe(true);
    expect(result.effective.allow).toEqual([]);
  });
});

describe("Codex", () => {
  test("codexProjectKey matches Codex's lower-cased, prefix-free Windows keys", () => {
    expect(codexProjectKey("C:\\Users\\Me\\Repo\\")).toBe("c:\\users\\me\\repo");
    expect(codexProjectKey("\\\\?\\C:\\Users\\Me\\Repo")).toBe("c:\\users\\me\\repo");
    expect(codexProjectKey("C:/Users/Me/Repo")).toBe("c:\\users\\me\\repo");
  });

  test("summarizeCodex reads policy, sandbox, this project's trust and hook trust", () => {
    const config = {
      config: {
        approval_policy: "on-request",
        sandbox_mode: "workspace-write",
        sandbox_workspace_write: { network_access: false },
        projects: {
          "c:\\work\\other": { trust_level: "untrusted" },
          "c:\\work\\repo": { trust_level: "trusted" },
        },
        env_vars: { TOKEN: "do-not-read" },
      },
    };
    const hooks = {
      data: [
        {
          cwd: "C:\\work\\repo",
          hooks: [
            { eventName: "PreToolUse", command: "agent-hook pre-tool-use", trustStatus: "trusted" },
            { eventName: "Stop", command: "agent-hook stop", trustStatus: "modified" },
          ],
        },
      ],
    };
    const result = summarizeCodex("C:\\Work\\Repo", config, hooks);
    expect(result).toMatchObject({
      available: true,
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      networkAccess: false,
      projectTrust: "trusted",
    });
    expect(result.hooks.map((h) => h.trust)).toEqual(["trusted", "modified"]);
    expect(JSON.stringify(result)).not.toContain("do-not-read");
  });

  test("an untrusted project has no trust entry", () => {
    expect(summarizeCodex("/work/new", { config: {} }, { data: [] }).projectTrust).toBeUndefined();
  });
});
