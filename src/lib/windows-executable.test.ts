import { describe, expect, test } from "bun:test";
import { windowsExecutable } from "./windows-executable.ts";

describe("windowsExecutable", () => {
  test("WSL uses the standard install path when it exists", () => {
    expect(windowsExecutable("cmd.exe", { platform: "linux", exists: () => true })).toBe(
      "/mnt/c/Windows/System32/cmd.exe",
    );
    expect(windowsExecutable("powershell.exe", { platform: "linux", exists: () => true })).toBe(
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    );
  });

  test("falls back to the bare name", () => {
    expect(windowsExecutable("cmd.exe", { platform: "linux", exists: () => false })).toBe(
      "cmd.exe",
    );
    expect(windowsExecutable("powershell.exe", { platform: "win32", exists: () => true })).toBe(
      "powershell.exe",
    );
  });
});
