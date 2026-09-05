import { expect, test } from "bun:test";
import { launchNativeReveal, nativeRevealPlan } from "./file-reveal";

test("routes native file reveal through Finder on macOS", () => {
  expect(nativeRevealPlan("/repo/a file.txt", { platform: "darwin", wsl: false })).toEqual({
    command: "open",
    args: ["-R", "/repo/a file.txt"],
    manager: "Finder",
  });
});

test("routes native and WSL Windows paths through Explorer", () => {
  const native = nativeRevealPlan("C:\\repo\\a file.txt", { platform: "win32", wsl: false });
  const wsl = nativeRevealPlan("/home/me/repo/a file.txt", {
    platform: "linux",
    wsl: true,
    wslPowerShellPath: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    wslWindowsPath: "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\a file.txt",
  });
  expect(native?.command).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  expect(wsl?.command).toBe("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
  for (const [plan, filename] of [
    [native, "C:\\repo\\a file.txt"],
    [wsl, "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\a file.txt"],
  ] as const) {
    expect(plan?.manager).toBe("Explorer");
    expect(plan?.args.slice(0, -1)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-EncodedCommand",
    ]);
    const script = Buffer.from(plan!.args.at(-1)!, "base64").toString("utf16le");
    const encodedPath = /FromBase64String\('([^']+)'\)/.exec(script)?.[1];
    expect(Buffer.from(encodedPath!, "base64").toString("utf8")).toBe(filename);
  }
});

test("opens the containing directory with the Linux file manager", () => {
  expect(nativeRevealPlan("/repo/docs/a.txt", { platform: "linux", wsl: false })).toEqual({
    command: "xdg-open",
    args: ["/repo/docs"],
    manager: "file manager",
  });
});

test("Windows shell API failures are reported by the single reveal command", async () => {
  await expect(
    launchNativeReveal({
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      manager: "Explorer",
    }),
  ).rejects.toMatchObject({ code: 1 });
});

test("Explorer launch still rejects an executable that cannot be started", async () => {
  await expect(
    launchNativeReveal({
      command: "harnery-nonexistent-file-manager-executable",
      args: [],
      manager: "Explorer",
    }),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("other native file managers still report unsuccessful exits", async () => {
  await expect(
    launchNativeReveal({
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      manager: "Finder",
    }),
  ).rejects.toMatchObject({ code: 1 });
});
