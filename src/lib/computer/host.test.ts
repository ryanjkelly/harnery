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

  test("plain Linux and macOS are unsupported", () => {
    const linux = detectHost({ platform: "linux", env: {}, isWsl: () => false });
    expect(linux.kind).toBe("unsupported");
    expect(linux.reason).toContain("Linux");
    const mac = detectHost({ platform: "darwin", env: {} });
    expect(mac.kind).toBe("unsupported");
    expect(mac.reason).toContain("macOS");
    expect(mac.reason).toContain("ADR 0228");
    expect(mac.desktopStateDir).toBeUndefined();
  });

  test("the default result is cached per process", () => {
    expect(detectHost()).toBe(detectHost());
  });
});
