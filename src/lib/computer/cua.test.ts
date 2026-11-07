import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { buildTarGz } from "../../../tests/helpers/tar-fixture.ts";
import { buildZip } from "../zip/index.ts";
import {
  CUA_DRIVER_VERSION,
  CUA_PINS,
  type CuaDeps,
  createCuaDriver,
  INSTALL_MARKER,
  type SpawnResult,
} from "./cua.ts";
import type { HostInfo } from "./types.ts";

const { join } = posix;

const TOP = `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64`;
const FILES = [
  "cua-driver.exe",
  "cua-driver-uia.exe",
  "cua-cursor-theme.exe",
  "cua_driver_sdk.dll",
  "cua_driver_node_runtime.node",
  "cua_driver_abi.h",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
];

let root: string;
beforeEach(() => {
  // These tests simulate POSIX hosts, whose plans join paths with posix syntax.
  // Forward slashes keep a Windows temp dir valid for both that and the file system.
  root = mkdtempSync(join(tmpdir(), "cua-test-")).replace(/\\/g, "/");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function wslHost(): HostInfo {
  return { kind: "wsl", desktopStateDir: join(root, "state") };
}

function buildArchive(): { bytes: Uint8Array<ArrayBuffer>; sha256: string } {
  const src = join(root, "src");
  mkdirSync(join(src, TOP), { recursive: true });
  for (const name of FILES) writeFileSync(join(src, TOP, name), `content of ${name}`);
  const { bytes } = buildZip([TOP], { base: src });
  return {
    bytes: new Uint8Array(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function pinsWith(sha256: string): typeof CUA_PINS {
  return { ...CUA_PINS, "windows-x86_64": { ...CUA_PINS["windows-x86_64"], sha256 } };
}

interface Call {
  command: string;
  args: string[];
  timeout: number;
  env: NodeJS.ProcessEnv;
}

function recorder(respond: (c: Call) => Partial<SpawnResult> = () => ({})) {
  const calls: Call[] = [];
  const spawnSync: CuaDeps["spawnSync"] = (command, args, options) => {
    const call = { command, args, ...options };
    calls.push(call);
    return { status: 0, stdout: "", stderr: "", ...respond(call) };
  };
  return { calls, spawnSync };
}

function profileDir(): string {
  return join(root, "profile");
}

function baseDeps(extra: Partial<CuaDeps> = {}): CuaDeps {
  return {
    arch: "x64",
    env: { PATH: "/usr/bin" },
    // The WSL default converts a drive path; tests point at a temp dir instead.
    windowsUserProfile: () => "C:\\Users\\me",
    ...extra,
  };
}

/** A WSL driver whose preference file lands in the temp root. */
function tempDriver(extra: Partial<CuaDeps> = {}) {
  const driver = createCuaDriver(baseDeps(extra));
  const host = wslHost();
  const plan = { ...driver.planInstall(host), preferenceFile: join(profileDir(), "config.json") };
  return { driver, host, plan };
}

describe("planInstall", () => {
  test("WSL plan uses /mnt paths, the pinned artifact and telemetry off", () => {
    const driver = createCuaDriver(baseDeps());
    const plan = driver.planInstall({
      kind: "wsl",
      desktopStateDir: "/mnt/c/Users/me/AppData/Local/harnery",
    });
    expect(plan.installDir).toBe(
      `/mnt/c/Users/me/AppData/Local/harnery/tools/cua-driver/${CUA_DRIVER_VERSION}`,
    );
    expect(plan.executable).toBe(`${plan.installDir}/cua-driver.exe`);
    expect(plan.preferenceFile).toBe("/mnt/c/Users/me/.cua-driver/config.json");
    expect(plan.preferences).toEqual({ telemetry_enabled: false });
    expect(plan.artifact).toEqual(CUA_PINS["windows-x86_64"]);
    expect(plan.artifact.url).toBe(
      `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/${TOP}.zip`,
    );
    expect(plan.alreadyInstalled).toBe(false);
    expect(plan.driver).toBe("cua");
    expect(plan.host).toBe("wsl");
  });

  test("Windows plan uses Windows path syntax", () => {
    const driver = createCuaDriver(baseDeps({ arch: "arm64" }));
    const plan = driver.planInstall({
      kind: "windows",
      desktopStateDir: "C:\\Users\\me\\AppData\\Local\\harnery",
    });
    expect(plan.executable).toBe(
      `C:\\Users\\me\\AppData\\Local\\harnery\\tools\\cua-driver\\${CUA_DRIVER_VERSION}\\cua-driver.exe`,
    );
    expect(plan.preferenceFile).toBe("C:\\Users\\me\\.cua-driver\\config.json");
    expect(plan.artifact).toEqual(CUA_PINS["windows-arm64"]);
  });

  test("unsupported hosts and architectures refuse", () => {
    const driver = createCuaDriver(baseDeps());
    expect(() => driver.planInstall({ kind: "unsupported", reason: "macOS later" })).toThrow(
      /macOS later/,
    );
    const odd = createCuaDriver(baseDeps({ arch: "ia32" }));
    expect(() => odd.planInstall(wslHost())).toThrow(/architecture ia32/);
  });
});

describe("install", () => {
  test("refuses an archive whose SHA-256 does not match", async () => {
    const { bytes } = buildArchive();
    const { driver, host, plan } = tempDriver({
      fetch: async () => new Response(bytes),
    });
    await expect(driver.install(plan)).rejects.toThrow(/does not match the pinned/);
    expect(existsSync(plan.installDir)).toBe(false);
    expect(driver.installedExecutable(host)).toBeUndefined();
  });

  test("extracts a matching archive flat, writes the marker and is idempotent", async () => {
    const { bytes, sha256 } = buildArchive();
    let downloads = 0;
    const { driver, host, plan } = tempDriver({
      pins: pinsWith(sha256),
      fetch: async (_url, init) => {
        downloads++;
        expect(init?.redirect).toBe("follow");
        return new Response(bytes);
      },
    });
    const result = await driver.install(plan);
    expect(result.installed).toBe(true);
    for (const name of FILES) expect(existsSync(join(plan.installDir, name))).toBe(true);
    expect(existsSync(join(plan.installDir, TOP))).toBe(false);
    const marker = JSON.parse(readFileSync(join(plan.installDir, INSTALL_MARKER), "utf8"));
    expect(marker.version).toBe(CUA_DRIVER_VERSION);
    expect(marker.sha256).toBe(sha256);
    expect(typeof marker.installed_at).toBe("string");
    expect(driver.installedExecutable(host)).toBe(plan.executable);

    const again = await driver.install(plan);
    expect(again.installed).toBe(false);
    expect(again.alreadyInstalled).toBe(true);
    expect(downloads).toBe(1);
  });

  test("a marker for another hash is not an install", async () => {
    const { bytes, sha256 } = buildArchive();
    const { driver, host, plan } = tempDriver({
      pins: pinsWith(sha256),
      fetch: async () => new Response(bytes),
    });
    await driver.install(plan);
    const other = createCuaDriver(baseDeps());
    expect(other.installedExecutable(host)).toBeUndefined();
  });

  test("merges preferences without dropping existing keys", async () => {
    const { bytes, sha256 } = buildArchive();
    const { driver, plan } = tempDriver({
      pins: pinsWith(sha256),
      fetch: async () => new Response(bytes),
    });
    mkdirSync(profileDir(), { recursive: true });
    writeFileSync(plan.preferenceFile, JSON.stringify({ telemetry_enabled: true, theme: "dark" }));
    await driver.install(plan);
    expect(JSON.parse(readFileSync(plan.preferenceFile, "utf8"))).toEqual({
      telemetry_enabled: false,
      theme: "dark",
    });
  });

  test("refuses to clobber an unreadable preference file", async () => {
    const { driver, plan } = tempDriver({ fetch: async () => new Response("x") });
    mkdirSync(profileDir(), { recursive: true });
    writeFileSync(plan.preferenceFile, "{ not json");
    await expect(driver.install(plan)).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(plan.preferenceFile, "utf8")).toBe("{ not json");
  });
});

/** Install a fake driver into the temp root and return a driver using `spawnSync`. */
async function installed(extra: Partial<CuaDeps> = {}) {
  const { bytes, sha256 } = buildArchive();
  const setup = tempDriver({ pins: pinsWith(sha256), fetch: async () => new Response(bytes) });
  await setup.driver.install(setup.plan);
  const driver = createCuaDriver(baseDeps({ pins: pinsWith(sha256), ...extra }));
  return { driver, host: setup.host, exe: setup.plan.executable };
}

describe("running the driver", () => {
  test("call passes tool + JSON args, normalizes CRLF, parses JSON, sets telemetry env", async () => {
    const rec = recorder(() => ({ stdout: '{\r\n  "ok": true\r\n}\r\n', stderr: "warn\r\n" }));
    const { driver, host, exe } = await installed({
      spawnSync: rec.spawnSync,
      env: { PATH: "/usr/bin", WSLENV: "FOO/u" },
    });
    const result = driver.call(host, "list_windows", { pid: 7 });
    expect(rec.calls[0]?.command).toBe(exe);
    expect(rec.calls[0]?.args).toEqual(["call", "list_windows", '{"pid":7}']);
    expect(rec.calls[0]?.timeout).toBe(120_000);
    expect(rec.calls[0]?.env.CUA_DRIVER_RS_TELEMETRY_ENABLED).toBe("0");
    expect(rec.calls[0]?.env.WSLENV).toBe("FOO/u:CUA_DRIVER_RS_TELEMETRY_ENABLED");
    expect(result.stdout).toBe('{\n  "ok": true\n}\n');
    expect(result.stderr).toBe("warn\n");
    expect(result.json).toEqual({ ok: true });
    expect(result.exitCode).toBe(0);
  });

  test("non-JSON output leaves json undefined; other subcommands use their vectors", async () => {
    const rec = recorder(() => ({ stdout: "click: Click an element\r\n" }));
    const { driver, host } = await installed({ spawnSync: rec.spawnSync });
    expect(driver.listTools(host).json).toBeUndefined();
    driver.describe(host, "click");
    driver.health(host);
    expect(rec.calls.map((c) => c.args)).toEqual([
      ["list-tools"],
      ["describe", "click"],
      ["call", "health_report", "{}"],
    ]);
    expect(rec.calls[0]?.env.WSLENV).toBe("CUA_DRIVER_RS_TELEMETRY_ENABLED");
  });

  test("a missing install fails with a plain message", () => {
    const driver = createCuaDriver(baseDeps());
    expect(() => driver.call(wslHost(), "x", {})).toThrow(/not installed/);
  });

  test("daemonStatus parses running, pid and not running", async () => {
    let out = "running\npid: 4242\nsocket: x\nextra\n";
    const rec = recorder(() => ({ stdout: out }));
    const { driver, host } = await installed({ spawnSync: rec.spawnSync });
    expect(driver.daemonStatus(host)).toEqual({
      running: true,
      pid: 4242,
      detail: "running\npid: 4242\nsocket: x",
    });
    expect(rec.calls[0]?.args).toEqual(["status"]);
    expect(rec.calls[0]?.timeout).toBe(15_000);
    out = "cua-driver daemon is not running\n";
    expect(driver.daemonStatus(host).running).toBe(false);
  });

  test("startDaemon under WSL starts via powershell and polls until running", async () => {
    let started = false;
    let clock = 0;
    const rec = recorder((c) => {
      if (c.command.endsWith("powershell.exe")) {
        started = true;
        return {};
      }
      return { stdout: started && clock >= 500 ? "running\npid: 9\n" : "not running\n" };
    });
    const { driver, host } = await installed({
      spawnSync: rec.spawnSync,
      wslpath: () => "C:\\Users\\o'neil\\cua-driver.exe",
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const status = await driver.startDaemon(host);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(9);
    const ps = rec.calls.find((c) => c.command.endsWith("powershell.exe"));
    expect(ps?.args.slice(0, 2)).toEqual(["-NoProfile", "-Command"]);
    expect(ps?.args[2]).toContain("Start-Process -FilePath 'C:\\Users\\o''neil\\cua-driver.exe'");
    expect(ps?.args[2]).toContain("-ArgumentList 'serve' -WindowStyle Hidden");
    expect(ps?.args[2]).not.toContain("RunAs");
  });

  test("startDaemon gives up after its deadline", async () => {
    let clock = 0;
    let polls = 0;
    const rec = recorder((c) => {
      if (c.args[0] === "status") polls++;
      return { stdout: "not running\n" };
    });
    const { driver, host } = await installed({
      spawnSync: rec.spawnSync,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const status = await driver.startDaemon(host);
    expect(status.running).toBe(false);
    expect(clock).toBe(10_000);
    expect(polls).toBe(41);
  });

  test("startDaemon is a no-op when already running", async () => {
    const rec = recorder(() => ({ stdout: "running\npid: 3\n" }));
    const { driver, host } = await installed({ spawnSync: rec.spawnSync });
    expect((await driver.startDaemon(host)).pid).toBe(3);
    expect(rec.calls.every((c) => c.command !== "powershell.exe")).toBe(true);
  });

  test("stopDaemon runs stop then reports status", async () => {
    const rec = recorder(() => ({ stdout: "not running\n" }));
    const { driver, host } = await installed({ spawnSync: rec.spawnSync });
    expect(driver.stopDaemon(host).running).toBe(false);
    expect(rec.calls.map((c) => c.args[0])).toEqual(["stop", "status"]);
  });
});

describe("path translation", () => {
  const fakeWslpath = (flag: "-w" | "-u", path: string): string | undefined => {
    if (flag === "-w") {
      if (path.startsWith("/mnt/c/")) return `C:\\${path.slice(7).replace(/\//g, "\\")}`;
      if (path === "/home/me/new.png") return undefined;
      return `\\\\wsl.localhost\\Distro${path.replace(/\//g, "\\")}`;
    }
    if (/^C:\\/.test(path)) return `/mnt/c/${path.slice(3).replace(/\\/g, "/")}`;
    if (path.startsWith("\\\\wsl.localhost\\Distro"))
      return path.slice("\\\\wsl.localhost\\Distro".length).replace(/\\/g, "/");
    return undefined;
  };
  const driver = createCuaDriver(baseDeps({ wslpath: fakeWslpath }));
  const wsl: HostInfo = { kind: "wsl", desktopStateDir: "/mnt/c/x/harnery" };
  const win: HostInfo = { kind: "windows", desktopStateDir: "C:\\x\\harnery" };

  test("translateArgsPaths converts known path keys under WSL only", () => {
    const args = {
      screenshot_out_file: "/home/me/new.png",
      output_dir: "/mnt/c/out",
      paths: ["/home/me/a.txt", "relative.txt"],
      image_path: "C:\\already\\windows.png",
      text: "/not/a/path/key",
      pid: 5,
    };
    expect(driver.translateArgsPaths(wsl, "screenshot", args)).toEqual({
      screenshot_out_file: "\\\\wsl.localhost\\Distro\\home\\me\\new.png",
      output_dir: "C:\\out",
      paths: ["\\\\wsl.localhost\\Distro\\home\\me\\a.txt", "relative.txt"],
      image_path: "C:\\already\\windows.png",
      text: "/not/a/path/key",
      pid: 5,
    });
    expect(driver.translateArgsPaths(win, "screenshot", args)).toBe(args);
  });

  test("translateResultPaths converts Windows paths back in path-like keys", () => {
    const stdout = `${JSON.stringify({
      screenshot_file_path: "C:\\Users\\me\\shot.png",
      nested: { path: "\\\\wsl.localhost\\Distro\\home\\me\\a.png", title: "C:\\keep" },
      list: [{ output_file: "C:\\o.txt" }],
    })}\n`;
    expect(JSON.parse(driver.translateResultPaths(wsl, stdout))).toEqual({
      screenshot_file_path: "/mnt/c/Users/me/shot.png",
      nested: { path: "/home/me/a.png", title: "C:\\keep" },
      list: [{ output_file: "/mnt/c/o.txt" }],
    });
    expect(driver.translateResultPaths(wsl, "plain text C:\\x")).toBe("plain text C:\\x");
    expect(driver.translateResultPaths(win, stdout)).toBe(stdout);
    const extended = JSON.stringify({
      screenshot_file_path: "\\\\?\\UNC\\wsl.localhost\\Distro\\home\\me\\b.png",
      out_file: "\\\\?\\C:\\Users\\me\\c.png",
    });
    expect(JSON.parse(driver.translateResultPaths(wsl, extended))).toEqual({
      screenshot_file_path: "/home/me/b.png",
      out_file: "/mnt/c/Users/me/c.png",
    });
    const untouched = '{"ok": true}';
    expect(driver.translateResultPaths(wsl, untouched)).toBe(untouched);
  });
});

describe("Cua Driver on macOS and Linux", () => {
  const plist = (id: string, version: string) =>
    `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`;

  function darwinArchive(id = "com.trycua.driver") {
    const top = `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal`;
    const bytes = buildTarGz([
      { name: `${top}/`, type: "5" },
      { name: `${top}/cua-driver`, body: "bare", mode: 0o755 },
      { name: `${top}/CuaDriver.app/Contents/Info.plist`, body: plist(id, CUA_DRIVER_VERSION) },
      { name: `${top}/CuaDriver.app/Contents/MacOS/cua-driver`, body: "app-bin", mode: 0o755 },
    ]);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  function macDriver(bytes: Uint8Array<ArrayBuffer>, sha256: string, extra: Partial<CuaDeps> = {}) {
    const rec = recorder((c) => {
      if (c.command === "ditto")
        cpSync(c.args[0] as string, c.args[1] as string, { recursive: true });
      return {};
    });
    const driver = createCuaDriver({
      arch: "arm64",
      env: {},
      home: () => join(root, "home"),
      macApplicationsDir: join(root, "Applications"),
      pins: { ...CUA_PINS, "darwin-universal": { ...CUA_PINS["darwin-universal"], sha256 } },
      fetch: async () => new Response(bytes),
      spawnSync: rec.spawnSync,
      ...extra,
    });
    return { driver, rec };
  }

  const mac = (): HostInfo => ({ kind: "macos", desktopStateDir: join(root, "state") });

  test("the macOS plan runs the driver from /Applications and lists the bundle steps", () => {
    const { bytes, sha256 } = darwinArchive();
    const { driver } = macDriver(bytes, sha256);
    const plan = driver.planInstall(mac());
    expect(plan.artifact.fileName).toBe(
      `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal.tar.gz`,
    );
    expect(plan.executable).toBe(
      join(root, "Applications", "CuaDriver.app", "Contents", "MacOS", "cua-driver"),
    );
    expect(plan.preferenceFile).toBe(join(root, "home", ".cua-driver", "config.json"));
    expect(plan.steps?.join("\n")).toContain("codesign --verify --deep --strict");
    expect(plan.setup?.[0]).toContain("Screen Recording");
  });

  test("install verifies the signature, places the app, and is then installed", async () => {
    const { bytes, sha256 } = darwinArchive();
    const { driver, rec } = macDriver(bytes, sha256);
    const result = await driver.install(driver.planInstall(mac()));
    expect(result.installed).toBe(true);
    expect(rec.calls.map((c) => c.command)).toEqual(["codesign", "ditto"]);
    expect(readFileSync(result.executable, "utf8")).toBe("app-bin");
    expect(driver.installedExecutable(mac())).toBe(result.executable);
    expect(
      JSON.parse(readFileSync(join(root, "home", ".cua-driver", "config.json"), "utf8")),
    ).toEqual({
      telemetry_enabled: false,
    });
    const again = await driver.install(driver.planInstall(mac()));
    expect(again.installed).toBe(false);
  });

  test("install refuses a failed signature check or a foreign app at the target", async () => {
    const { bytes, sha256 } = darwinArchive();
    const bad = macDriver(bytes, sha256, {
      spawnSync: (command) => ({
        status: command === "codesign" ? 1 : 0,
        stdout: "",
        stderr: "invalid signature",
      }),
    });
    await expect(bad.driver.install(bad.driver.planInstall(mac()))).rejects.toThrow(
      "signature verification",
    );
    expect(existsSync(join(root, "Applications", "CuaDriver.app"))).toBe(false);

    mkdirSync(join(root, "Applications", "CuaDriver.app", "Contents"), { recursive: true });
    writeFileSync(
      join(root, "Applications", "CuaDriver.app", "Contents", "Info.plist"),
      plist("com.example.other", "1"),
    );
    const { driver } = macDriver(bytes, sha256);
    await expect(driver.install(driver.planInstall(mac()))).rejects.toThrow("is not Cua Driver");
  });

  test("doctor and call explain a pending permission grant and a stopped daemon", async () => {
    const { bytes, sha256 } = darwinArchive();
    let reply =
      "permissions_pending: macOS Accessibility or Screen Recording permission is still pending\n";
    const { driver } = macDriver(bytes, sha256, {
      spawnSync: (command, args) => {
        if (command === "ditto") cpSync(args[0] as string, args[1] as string, { recursive: true });
        return {
          status: command === "codesign" || command === "ditto" ? 0 : 1,
          stdout: reply,
          stderr: "",
        };
      },
    });
    await driver.install(driver.planInstall(mac()));

    const pending = driver.health(mac());
    expect(pending.exitCode).toBe(1);
    const check = (pending.json as { checks: Record<string, string>[] }).checks[0];
    expect(check?.name).toBe("tcc_permissions");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("CuaDriver");
    expect(check?.message).toContain("computer down, then computer up");
    expect(driver.call(mac(), "list_apps", {}).stderr).toContain("Turn on CuaDriver");

    reply = "Cua Driver daemon is not running on /tmp/cua.sock.\n";
    const stopped = (driver.health(mac()).json as { checks: Record<string, string>[] }).checks[0];
    expect(stopped).toMatchObject({ name: "daemon", status: "fail" });
  });

  test("Linux uses the linux build, a home preference file, and no app bundle", () => {
    const driver = createCuaDriver({ arch: "arm64", home: () => "/home/me" });
    const plan = driver.planInstall({ kind: "linux", desktopStateDir: join(root, "state") });
    expect(plan.artifact.fileName).toBe(`cua-driver-rs-${CUA_DRIVER_VERSION}-linux-arm64.tar.gz`);
    expect(plan.executable).toBe(
      join(root, "state", "tools", "cua-driver", CUA_DRIVER_VERSION, "cua-driver"),
    );
    expect(plan.preferenceFile).toBe("/home/me/.cua-driver/config.json");
    expect(plan.steps).toBeUndefined();
  });

  test("every pin carries a 64-hex hash and the right format", () => {
    for (const [key, pin] of Object.entries(CUA_PINS)) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.format).toBe(key.startsWith("windows-") ? "zip" : "tar.gz");
    }
  });
});
