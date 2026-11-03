import { describe, expect, test } from "bun:test";
import { detectOp, isWslRuntime, opEnvironment } from "./detect.ts";

function runtime(options: {
  env?: Record<string, string | undefined>;
  platform?: string;
  available?: string[];
  windowsOp?: string | null;
  bridge?: string | null;
  wslKernel?: boolean;
}) {
  const available = new Set(options.available ?? []);
  return {
    env: options.env ?? {},
    platform: options.platform ?? "linux",
    which: (binary: string) => (available.has(binary) ? `/path/${binary}` : null),
    locateWindowsOp: () => options.windowsOp ?? null,
    locateBridge: () => options.bridge ?? null,
    wslKernel: () => options.wslKernel ?? false,
  };
}

describe("detectOp", () => {
  test("explicit OP_BIN always wins", () => {
    expect(
      detectOp(
        runtime({
          env: { OP_BIN: "/custom/op" },
          available: ["op", "op.exe"],
          windowsOp: "/mnt/c/1Password/op.exe",
        }),
      ),
    ).toBe("/custom/op");
  });

  test("bridged WSL discovers Windows op.exe before a Linux op fallback", () => {
    expect(
      detectOp(
        runtime({
          env: { WSL_INTEROP: "/run/WSL/123_interop" },
          available: ["op"],
          windowsOp: "/mnt/c/Users/test/AppData/Local/1Password/op.exe",
        }),
      ),
    ).toBe("/mnt/c/Users/test/AppData/Local/1Password/op.exe");
  });

  test("WSL prefers the installed host helper over op.exe", () => {
    expect(
      detectOp(
        runtime({
          env: { WSL_INTEROP: "/run/WSL/123_interop" },
          available: ["op", "op.exe"],
          windowsOp: "/mnt/c/1Password/op.exe",
          bridge: "/mnt/c/Example/op-helper/0.1.1/op-helper.exe",
        }),
      ),
    ).toBe("/mnt/c/Example/op-helper/0.1.1/op-helper.exe");
  });

  test("WSL uses op.exe directly when Windows paths are already on PATH", () => {
    expect(
      detectOp(
        runtime({
          env: { WSL_DISTRO_NAME: "Ubuntu" },
          available: ["op", "op.exe"],
        }),
      ),
    ).toBe("op.exe");
  });

  test("a scrubbed environment on the WSL kernel still uses the host helper", () => {
    const bridge = "/mnt/c/Example/op-helper/op-helper.exe";
    expect(detectOp(runtime({ available: ["op"], bridge, wslKernel: true }))).toBe(bridge);
  });

  test("ordinary Linux ignores an installed Windows helper", () => {
    expect(
      detectOp(
        runtime({
          available: ["op"],
          bridge: "/mnt/c/Example/op-helper/op-helper.exe",
          wslKernel: false,
        }),
      ),
    ).toBe("op");
  });

  test("native Linux uses its native op CLI without Windows discovery", () => {
    let attemptedWindowsDiscovery = false;
    const detected = detectOp({
      ...runtime({ platform: "linux", available: ["op"] }),
      locateWindowsOp: () => {
        attemptedWindowsDiscovery = true;
        return "/mnt/c/op.exe";
      },
    });
    expect(detected).toBe("op");
    expect(attemptedWindowsDiscovery).toBe(false);
  });

  test("native Windows prefers op.exe", () => {
    expect(detectOp(runtime({ platform: "win32", available: ["op", "op.exe"] }))).toBe("op.exe");
  });

  test("WSL falls back to native op when Windows CLI is unavailable", () => {
    expect(
      detectOp(
        runtime({
          env: { WSL_INTEROP: "/run/WSL/123_interop" },
          available: ["op"],
          windowsOp: null,
        }),
      ),
    ).toBe("op");
  });

  test("returns null when no CLI is installed", () => {
    expect(detectOp(runtime({ platform: "linux" }))).toBeNull();
  });
  test("macOS prefers the host helper over native op", () => {
    expect(
      detectOp(
        runtime({ platform: "darwin", available: ["op"], bridge: "/Applications/Helper.app/op" }),
      ),
    ).toBe("/Applications/Helper.app/op");
  });

  test("macOS without a helper uses native op", () => {
    expect(detectOp(runtime({ platform: "darwin", available: ["op"] }))).toBe("op");
  });
});

describe("isWslRuntime", () => {
  test("recognizes WSL from its variables or the kernel, only on Linux", () => {
    expect(isWslRuntime({ WSL_DISTRO_NAME: "Ubuntu" }, "linux", () => false)).toBe(true);
    expect(isWslRuntime({}, "linux", () => true)).toBe(true);
    expect(isWslRuntime({}, "linux", () => false)).toBe(false);
    expect(isWslRuntime({ WSL_DISTRO_NAME: "Ubuntu" }, "darwin", () => true)).toBe(false);
  });
});

describe("opEnvironment", () => {
  test("enables desktop integration for macOS headless subprocesses", () => {
    expect(opEnvironment({ PATH: "/bin" }, "darwin")).toEqual({
      PATH: "/bin",
      OP_BIOMETRIC_UNLOCK_ENABLED: "true",
    });
  });

  test("does not override an explicit biometric setting", () => {
    expect(opEnvironment({ OP_BIOMETRIC_UNLOCK_ENABLED: "false" }, "darwin")).toEqual({
      OP_BIOMETRIC_UNLOCK_ENABLED: "false",
    });
  });

  test("leaves service, Connect, and session authentication alone", () => {
    for (const env of [
      { OP_SERVICE_ACCOUNT_TOKEN: "service" },
      { OP_CONNECT_HOST: "https://connect", OP_CONNECT_TOKEN: "token" },
      { OP_SESSION_personal: "session" },
    ]) {
      expect(opEnvironment(env, "darwin")).toEqual(env);
    }
  });

  test("does not change non-macOS environments", () => {
    expect(opEnvironment({ PATH: "/bin" }, "linux")).toEqual({ PATH: "/bin" });
  });
});
