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
  expect(nativeRevealPlan("C:\\repo\\a file.txt", { platform: "win32", wsl: false })).toEqual({
    command: "explorer.exe",
    args: ["/select,C:\\repo\\a file.txt"],
    manager: "Explorer",
  });
  expect(
    nativeRevealPlan("/home/me/repo/a file.txt", {
      platform: "linux",
      wsl: true,
      wslExplorerPath: "/mnt/c/Windows/explorer.exe",
      wslWindowsPath: "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\a file.txt",
    }),
  ).toEqual({
    command: "/mnt/c/Windows/explorer.exe",
    args: ["/select,\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\a file.txt"],
    manager: "Explorer",
  });
});

test("opens the containing directory with the Linux file manager", () => {
  expect(nativeRevealPlan("/repo/docs/a.txt", { platform: "linux", wsl: false })).toEqual({
    command: "xdg-open",
    args: ["/repo/docs"],
    manager: "file manager",
  });
});

test("Explorer launch acknowledges dispatch even when its process exits nonzero", async () => {
  await launchNativeReveal({
    command: process.execPath,
    args: ["-e", "process.exit(1)"],
    manager: "Explorer",
  });
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
