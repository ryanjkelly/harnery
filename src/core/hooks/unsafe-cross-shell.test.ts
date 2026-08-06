import { describe, expect, test } from "bun:test";
import { unsafeCrossShellReason } from "./unsafe-cross-shell.ts";

const cwd = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\dev\\projects\\example";

function inspect(command: string, overrides: Record<string, unknown> = {}) {
  return unsafeCrossShellReason({
    adapter: "codex",
    cwd,
    toolName: "Bash",
    toolInput: { command },
    ...overrides,
  });
}

describe("unsafeCrossShellReason", () => {
  test.each([
    'wsl.exe -d Ubuntu-22.04 -- bash -lc "acme agents whoami --json"',
    "wsl -- /bin/bash -c 'printf ok'",
    "git status; wsl.exe -e /bin/bash -cl 'printf ok'",
    "if ($true) { wsl.exe -- bash --login -c 'printf ok' }",
    "$(wsl.exe -- bash -lc 'printf ok')",
    "& wsl.exe -- bash -lc 'printf ok'",
    "& 'wsl.exe' -- /bin/bash -lc 'printf ok'",
  ])("denies direct WSL Bash command strings: %s", (command) => {
    expect(inspect(command)).toContain("argv-preserving WSL bridge");
  });

  test.each([
    "node.exe scripts/codex-wsl.cjs -- git status --short",
    "wsl.exe -d Ubuntu-22.04 -- /usr/bin/env git status --short",
    "wsl.exe -- /bin/bash -s -- arg1",
    'rg -n "wsl\\.exe.*bash -lc" docs/issues',
    'Write-Output "text | wsl.exe -- bash -lc not-an-invocation"',
    "Get-Command wsl.exe; Write-Output 'bash -lc'",
  ])("allows argv-safe or quoted non-invocations: %s", (command) => {
    expect(inspect(command)).toBeNull();
  });

  test("fails open outside the exact hybrid scope", () => {
    const unsafe = "wsl.exe -- bash -lc 'printf ok'";
    expect(inspect(unsafe, { adapter: "claude-code" })).toBeNull();
    expect(inspect(unsafe, { cwd: "/home/dev/projects/example" })).toBeNull();
    expect(inspect(unsafe, { toolName: "Read" })).toBeNull();
  });

  test("accepts serialized Codex tool input and shell_command naming", () => {
    expect(
      inspect("unused", {
        toolName: "shell_command",
        toolInput: JSON.stringify({ command: "wsl.exe -- bash -lc 'printf ok'" }),
      }),
    ).not.toBeNull();
  });
});
