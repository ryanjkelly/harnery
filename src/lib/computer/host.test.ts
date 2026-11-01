import { describe, expect, test } from "bun:test";
import { detectHost } from "./host.ts";

describe("detectHost", () => {
  test("native Windows uses LOCALAPPDATA\\harnery", () => {
    const host = detectHost({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    });
    expect(host).toEqual({
      kind: "windows",
      desktopStateDir: "C:\\Users\\me\\AppData\\Local\\harnery",
    });
  });

  test("native Windows without LOCALAPPDATA is unsupported", () => {
    const host = detectHost({ platform: "win32", env: {} });
    expect(host.kind).toBe("unsupported");
    expect(host.reason).toContain("LOCALAPPDATA");
  });

  test("WSL maps LOCALAPPDATA to its /mnt form", () => {
    const host = detectHost({
      platform: "linux",
      env: {},
      isWsl: () => true,
      localAppData: () => "C:\\Users\\me\\AppData\\Local",
    });
    expect(host).toEqual({ kind: "wsl", desktopStateDir: "/mnt/c/Users/me/AppData/Local/harnery" });
  });

  test("WSL without interop is unsupported with a reason", () => {
    const host = detectHost({
      platform: "linux",
      env: {},
      isWsl: () => true,
      localAppData: () => undefined,
    });
    expect(host.kind).toBe("unsupported");
    expect(host.reason).toContain("interop");
  });

  test("macOS uses Application Support/harnery", () => {
    const mac = detectHost({ platform: "darwin", env: {}, home: () => "/Users/me" });
    expect(mac).toEqual({
      kind: "macos",
      desktopStateDir: "/Users/me/Library/Application Support/harnery",
    });
  });

  test("Linux uses XDG_STATE_HOME, else ~/.local/state, and notes a missing session", () => {
    const xdg = detectHost({
      platform: "linux",
      env: { XDG_STATE_HOME: "/state", DISPLAY: ":0" },
      isWsl: () => false,
      home: () => "/home/me",
    });
    expect(xdg).toEqual({ kind: "linux", desktopStateDir: "/state/harnery" });
    const bare = detectHost({
      platform: "linux",
      env: {},
      isWsl: () => false,
      home: () => "/home/me",
    });
    expect(bare.kind).toBe("linux");
    expect(bare.desktopStateDir).toBe("/home/me/.local/state/harnery");
    expect(bare.note).toContain("graphical session");
    const wayland = detectHost({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      isWsl: () => false,
      home: () => "/home/me",
    });
    expect(wayland.note).toBeUndefined();
  });

  test("other platforms are unsupported", () => {
    const host = detectHost({ platform: "freebsd", env: {}, home: () => "/home/me" });
    expect(host.kind).toBe("unsupported");
    expect(host.reason).toContain("freebsd");
  });

  test("the default result is cached per process", () => {
    expect(detectHost()).toBe(detectHost());
  });
});
