import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { buildTarGz } from "../../../tests/helpers/tar-fixture.ts";
import {
  AGENT_DESKTOP_CALL_TIMEOUT_MS,
  AGENT_DESKTOP_MAX_CALL_TIMEOUT_MS,
  AGENT_DESKTOP_PINS,
  AGENT_DESKTOP_VERSION,
  type AgentDesktopDeps,
  agentDesktopCallTimeoutMs,
  agentDesktopLaunchedProcess,
  agentDesktopPlatform,
  agentDesktopSession,
  agentDesktopTakesForeground,
  createAgentDesktopDriver,
  parseDisplayList,
  unwrapSingleBatch,
} from "./agent-desktop.ts";
import { responsibleAppName, type SpawnResult } from "./driver-support.ts";
import type { HostInfo } from "./types.ts";

const { join } = posix;

let root: string;
beforeEach(() => {
  // These tests simulate POSIX hosts, whose plans join paths with posix syntax.
  // Forward slashes keep a Windows temp dir valid for both that and the file system.
  root = mkdtempSync(join(tmpdir(), "agent-desktop-test-")).replace(/\\/g, "/");
});
afterEach(() => {
  removeDir(root);
});

const host = (kind: HostInfo["kind"]): HostInfo => ({ kind, desktopStateDir: join(root, "state") });

interface Call {
  command: string;
  args: string[];
}

function recorder(respond: (c: Call) => Partial<SpawnResult> = () => ({})) {
  const calls: Call[] = [];
  const spawnSync: AgentDesktopDeps["spawnSync"] = (command, args) => {
    const call = { command, args };
    calls.push(call);
    return { status: 0, stdout: "", stderr: "", ...respond(call) };
  };
  return { calls, spawnSync };
}

async function installed(kind: HostInfo["kind"], extra: Partial<AgentDesktopDeps> = {}) {
  const platform = agentDesktopPlatform(host(kind), "x64");
  if (!platform) throw new Error("no platform");
  const exeName = kind === "wsl" || kind === "windows" ? "agent-desktop.exe" : "agent-desktop";
  const files = [{ name: exeName, body: "bin", mode: 0o755 }];
  if (kind === "linux")
    files.push({ name: "agent-desktop-linux-clipboard-owner", body: "h", mode: 0o755 });
  if (kind === "macos") files.push({ name: "agent-desktop-macos-helper", body: "h", mode: 0o755 });
  const bytes = buildTarGz(files);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const pins = { ...AGENT_DESKTOP_PINS, [platform]: { ...AGENT_DESKTOP_PINS[platform], sha256 } };
  const driver = createAgentDesktopDriver({
    arch: "x64",
    pins,
    env: {},
    fetch: async () => new Response(bytes),
    wslpath: (flag, path) =>
      flag === "-w" ? `\\\\wsl.localhost\\Ubuntu${path.replace(/\//g, "\\")}` : undefined,
    ...extra,
  });
  const plan = driver.planInstall(host(kind));
  const result = await driver.install(plan);
  return { driver, plan, result };
}

describe("agent-desktop plans", () => {
  test("each host picks its build; Windows and WSL share the Windows build", () => {
    expect(agentDesktopPlatform(host("wsl"), "x64")).toBe("windows-x86_64");
    expect(agentDesktopPlatform(host("windows"), "arm64")).toBe("windows-arm64");
    expect(agentDesktopPlatform(host("macos"), "arm64")).toBe("darwin-arm64");
    expect(agentDesktopPlatform(host("linux"), "x64")).toBe("linux-x86_64");
    expect(agentDesktopPlatform(host("linux"), "ia32")).toBeUndefined();
    expect(agentDesktopPlatform({ kind: "unsupported" }, "x64")).toBeUndefined();
  });

  test("the macOS plan names the permission step and has no preference file", () => {
    const driver = createAgentDesktopDriver({ arch: "arm64" });
    const plan = driver.planInstall(host("macos"));
    expect(plan.artifact.url).toContain(`v${AGENT_DESKTOP_VERSION}/`);
    expect(plan.artifact.fileName).toContain("aarch64-apple-darwin");
    expect(plan.executable).toBe(
      join(root, "state", "tools", "agent-desktop", AGENT_DESKTOP_VERSION, "agent-desktop"),
    );
    expect(plan.preferenceFile).toBeUndefined();
    expect(plan.setup?.[0]).toContain("permissions --guide");
    expect(plan.alreadyInstalled).toBe(false);
  });

  test("every pin is a tar.gz with a 64-hex hash", () => {
    for (const pin of Object.values(AGENT_DESKTOP_PINS)) {
      expect(pin.format).toBe("tar.gz");
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("agent-desktop install and calls", () => {
  test("installs the archive flat and reports the executable as installed", async () => {
    const { driver, result } = await installed("linux");
    expect(result.installed).toBe(true);
    expect(readFileSync(result.executable, "utf8")).toBe("bin");
    expect(driver.installedExecutable(host("linux"))).toBe(result.executable);
    expect(driver.hasDaemon).toBe(false);
    expect(driver.daemonStatus(host("linux")).running).toBe(true);
  });

  test("call runs one batch entry with session and headed flags, and unwraps it", async () => {
    const rec = recorder(() => ({
      stdout: JSON.stringify({
        version: "2.5",
        ok: true,
        command: "batch",
        data: { results: [{ command: "get", ok: true, version: "2.5", data: { value: "hi" } }] },
      }),
    }));
    const { driver } = await installed("linux", { spawnSync: rec.spawnSync });
    const result = driver.call(host("linux"), "get", {
      ref_id: "@s1:e1",
      session: "agent Olga!",
      headed: true,
    });
    const args = rec.calls.at(-1)?.args ?? [];
    expect(args[0]).toBe("batch");
    expect(JSON.parse(args[1] ?? "")).toEqual([{ command: "get", args: { ref_id: "@s1:e1" } }]);
    expect(args.slice(2)).toEqual(["--session", "agent-Olga", "--headed"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({
      version: "2.5",
      ok: true,
      command: "get",
      data: { value: "hi" },
    });
  });

  test("a failed entry exits 1 with its error; the batch tool passes through", async () => {
    const failing = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      json: {
        ok: true,
        command: "batch",
        data: { results: [{ command: "click", ok: false, error: { code: "STALE_REF" } }] },
      },
    };
    const unwrapped = unwrapSingleBatch(failing);
    expect(unwrapped.exitCode).toBe(1);
    expect(unwrapped.json).toMatchObject({
      ok: false,
      command: "click",
      error: { code: "STALE_REF" },
    });

    const rec = recorder(() => ({ stdout: '{"ok":true,"command":"batch","data":{"results":[]}}' }));
    const { driver } = await installed("linux", { spawnSync: rec.spawnSync });
    const commands = [
      { command: "version", args: {} },
      { command: "status", args: {} },
    ];
    driver.call(host("linux"), "batch", { commands });
    expect(JSON.parse(rec.calls.at(-1)?.args[1] ?? "")).toEqual(commands);
    expect(driver.call(host("linux"), "batch", {}).exitCode).toBe(2);
  });

  test("describe adds the accepted JSON keys; skill:<name> prints the bundled guide", async () => {
    const rec = recorder((c) => {
      if (c.args[1] === "--help") return { stdout: "Usage: agent-desktop get <REF>\n" };
      if (c.args[0] === "skills")
        return { stdout: JSON.stringify({ ok: true, data: { content: "# loop\r\nrules" } }) };
      return {
        stdout: JSON.stringify({
          ok: true,
          command: "batch",
          data: {
            results: [
              {
                ok: false,
                error: {
                  message: "unknown field `__harnery_probe`, expected `ref_id` or `property`",
                },
              },
            ],
          },
        }),
      };
    });
    const { driver } = await installed("linux", { spawnSync: rec.spawnSync });
    const described = driver.describe(host("linux"), "get");
    expect(described.stdout).toContain("Usage: agent-desktop get");
    expect(described.stdout).toContain("JSON keys for computer call: `ref_id`, `property`");
    expect(driver.describe(host("linux"), "skill:desktop").stdout).toBe("# loop\nrules\n");
  });

  test("health turns permission states into checks", async () => {
    const rec = recorder(() => ({
      stdout: JSON.stringify({
        ok: true,
        data: {
          permissions: {
            accessibility: { state: "denied" },
            automation: { state: "not_required" },
          },
        },
      }),
    }));
    const { driver } = await installed("linux", { spawnSync: rec.spawnSync });
    const health = driver.health(host("linux"));
    expect((health.json as { checks: unknown[] }).checks).toEqual([
      { name: "accessibility", status: "fail", message: "denied" },
      { name: "automation", status: "pass", message: "not_required" },
    ]);
  });

  test("under WSL, path arguments become Windows paths, also inside batch entries", async () => {
    const { driver } = await installed("wsl");
    const out = driver.translateArgsPaths(host("wsl"), "screenshot", {
      output_path: "/home/me/shot.png",
      app: "notepad.exe",
      commands: [{ command: "screenshot", args: { output_path: "/tmp/a.png" } }],
    });
    expect(out.output_path).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\shot.png");
    expect(out.app).toBe("notepad.exe");
    expect((out.commands as { args: { output_path: string } }[])[0]?.args.output_path).toBe(
      "\\\\wsl.localhost\\Ubuntu\\tmp\\a.png",
    );
    expect(driver.translateArgsPaths(host("linux"), "screenshot", { output_path: "/x" })).toEqual({
      output_path: "/x",
    });
  });

  test("a missing install fails plainly", () => {
    const driver = createAgentDesktopDriver({ arch: "x64" });
    expect(() => driver.call(host("linux"), "status", {})).toThrow("not installed");
  });

  test("session names keep only letters, digits, dash and underscore", () => {
    expect(agentDesktopSession("agent-Olga")).toBe("agent-Olga");
    expect(agentDesktopSession("shell:me@box")).toBe("shell-me-box");
    expect(agentDesktopSession("!!!")).toBe("harnery");
    expect(agentDesktopSession("x".repeat(80))).toHaveLength(64);
  });
});

describe("agent-desktop call timeouts", () => {
  test("a call gets the short default plus whatever it asks to wait", () => {
    expect(agentDesktopCallTimeoutMs("snapshot", {})).toBe(AGENT_DESKTOP_CALL_TIMEOUT_MS);
    expect(agentDesktopCallTimeoutMs("snapshot", { wait_for: "button:OK" })).toBe(
      AGENT_DESKTOP_CALL_TIMEOUT_MS + 30_000,
    );
    expect(agentDesktopCallTimeoutMs("click", { wait_for: "x", wait_timeout: 5_000 })).toBe(
      AGENT_DESKTOP_CALL_TIMEOUT_MS + 5_000,
    );
    expect(agentDesktopCallTimeoutMs("wait", { ms: 2_000 })).toBe(
      AGENT_DESKTOP_CALL_TIMEOUT_MS + 2_000,
    );
    expect(agentDesktopCallTimeoutMs("type", { timeout_ms: 9_000 })).toBe(
      AGENT_DESKTOP_CALL_TIMEOUT_MS + 9_000,
    );
    expect(
      agentDesktopCallTimeoutMs("batch", {
        commands: [
          { command: "wait", args: { ms: 1_000 } },
          { command: "snapshot", args: { wait_timeout: 4_000 } },
        ],
      }),
    ).toBe(AGENT_DESKTOP_CALL_TIMEOUT_MS + 5_000);
    expect(agentDesktopCallTimeoutMs("wait", { ms: 10_000_000 })).toBe(
      AGENT_DESKTOP_MAX_CALL_TIMEOUT_MS,
    );
  });

  test("call passes the per-call timeout to the process", async () => {
    const timeouts: number[] = [];
    const { driver } = await installed("linux", {
      spawnSync: (_c, _a, options) => {
        timeouts.push(options.timeout);
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    driver.call(host("linux"), "wait", { ms: 3_000 });
    expect(timeouts).toEqual([AGENT_DESKTOP_CALL_TIMEOUT_MS + 3_000]);
    expect(driver.callTimeoutFor?.("wait", { ms: 3_000 })).toBe(
      AGENT_DESKTOP_CALL_TIMEOUT_MS + 3_000,
    );
  });
});

describe("agent-desktop command hosts on macOS", () => {
  /** A process table holding the given command hosts and a running call. */
  function table(exe: string, hosts: number[]) {
    const state = { hosts: [...hosts] };
    const read = (field: "command" | "comm") => [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      ...state.hosts.map((pid) => ({ pid, ppid: 1, command: exe })),
      { pid: 900, ppid: 800, command: field === "command" ? `${exe} batch []` : exe },
    ];
    return { state, read };
  }

  test("status lists only the argument-less host processes; other hosts list none", async () => {
    let exe = "";
    const { driver, result } = await installed("macos", {
      processTable: (field) => table(exe, [501, 502]).read(field),
    });
    exe = result.executable;
    expect(driver.backgroundProcesses?.(host("macos"))).toEqual([
      { pid: 501, kind: "command host" },
      { pid: 502, kind: "command host" },
    ]);
    expect(driver.backgroundProcesses?.(host("linux"))).toEqual([]);
  });

  test("stop sends SIGTERM, escalates to SIGKILL for a host that stays, and reports none left", async () => {
    let exe = "";
    const procs = table("", [501, 502]);
    const signals: string[] = [];
    const { driver, result } = await installed("macos", {
      processTable: (field) => table(exe, procs.state.hosts).read(field),
      kill: (pid, signal) => {
        signals.push(`${pid}:${signal}`);
        if (signal === "SIGKILL" || pid === 501)
          procs.state.hosts = procs.state.hosts.filter((p) => p !== pid);
      },
      sleepSync: () => {},
    });
    exe = result.executable;
    expect(driver.stopBackgroundProcesses?.(host("macos"))).toEqual([]);
    expect(signals).toEqual(["501:SIGTERM", "502:SIGTERM", "502:SIGKILL"]);
  });

  test("a timed-out call restarts the command host and says what to do", async () => {
    let exe = "";
    const procs = table("", [501]);
    const { driver, result } = await installed("macos", {
      processTable: (field) => table(exe, procs.state.hosts).read(field),
      kill: (pid) => {
        procs.state.hosts = procs.state.hosts.filter((p) => p !== pid);
      },
      sleepSync: () => {},
      spawnSync: () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
      }),
    });
    exe = result.executable;
    const out = driver.call(host("macos"), "list-windows", {});
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("timed out after 30s");
    expect(out.stderr).toContain("restarted agent-desktop's command host");
    expect(procs.state.hosts).toEqual([]);
  });
});

describe("agent-desktop permissions on macOS", () => {
  const appRows = (field: "command" | "comm") => [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    {
      pid: 10,
      ppid: 1,
      command: "/Applications/Editor.app/Contents/MacOS/Editor",
    },
    {
      pid: 20,
      ppid: 10,
      command:
        "/Applications/Editor.app/Contents/Frameworks/Editor Helper.app/Contents/MacOS/Editor Helper",
    },
    { pid: 30, ppid: 20, command: field === "comm" ? "/bin/zsh" : "/bin/zsh -l" },
  ];

  test("names the outermost app the agent runs inside", () => {
    expect(responsibleAppName(appRows("comm"), 30)).toBe("Editor");
    expect(responsibleAppName([{ pid: 5, ppid: 1, command: "/usr/bin/ssh" }], 5)).toBeUndefined();
  });

  test("doctor names that app for a denied grant and treats unknown automation as information", async () => {
    const { driver } = await installed("macos", {
      processTable: appRows,
      selfPid: 30,
      spawnSync: () => ({
        status: 0,
        stderr: "",
        stdout: JSON.stringify({
          ok: true,
          command: "status",
          data: {
            permissions: {
              accessibility: { state: "denied" },
              automation: { state: "unknown" },
              screen_recording: { state: "granted" },
            },
          },
        }),
      }),
    });
    const checks = (driver.health(host("macos")).json as { checks: Record<string, string>[] })
      .checks;
    expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      "accessibility:fail",
      "automation:info",
      "screen_recording:pass",
    ]);
    expect(checks[0]?.message).toContain('"Editor" (the app this agent runs in)');
  });

  test("a refused call and the install plan name where to grant", async () => {
    const { driver } = await installed("macos", {
      processTable: appRows,
      selfPid: 30,
      spawnSync: () => ({
        status: 1,
        stderr: "",
        stdout: JSON.stringify({ ok: false, command: "batch", error: { code: "PERM_DENIED" } }),
      }),
    });
    expect(driver.call(host("macos"), "snapshot", {}).stderr).toContain('"Editor"');
    expect(driver.planInstall(host("macos")).setup?.[0]).toContain('"Editor"');
  });
});

describe("agentDesktopTakesForeground", () => {
  test("headless delivery, the default, never takes the foreground", () => {
    expect(agentDesktopTakesForeground("click", { ref_id: "@s1:e2" })).toBe(false);
    expect(agentDesktopTakesForeground("launch", { app: "Notes" })).toBe(false);
    expect(
      agentDesktopTakesForeground("batch", { commands: [{ command: "click", args: {} }] }),
    ).toBe(false);
  });

  test("headed delivery, an activating launch and focus-window do", () => {
    expect(agentDesktopTakesForeground("type", { text: "hi", headed: true })).toBe(true);
    expect(agentDesktopTakesForeground("launch", { app: "Notes", activate: true })).toBe(true);
    expect(agentDesktopTakesForeground("focus-window", { window_id: "w1" })).toBe(true);
  });

  test("a batch counts its own headed flag and each command", () => {
    const click = { command: "click", args: { ref_id: "@s1:e2" } };
    expect(agentDesktopTakesForeground("batch", { commands: [click], headed: true })).toBe(true);
    expect(
      agentDesktopTakesForeground("batch", {
        commands: [click, { command: "launch", args: { app: "Notes", activate: true } }],
      }),
    ).toBe(true);
    expect(
      agentDesktopTakesForeground("batch", { commands: [click, { command: "focus-window" }] }),
    ).toBe(true);
  });
});

describe("agent-desktop displays and launches", () => {
  const DISPLAYS = {
    version: "2.6",
    ok: true,
    command: "list-displays",
    data: [
      {
        bounds: { height: 2160, width: 5120, x: 0, y: 0 },
        id: "monitor-580651801",
        is_primary: true,
        scale: 1.5,
      },
      {
        bounds: { height: 1440, width: 5120, x: 5120, y: 700 },
        id: "monitor-554109125",
        is_primary: false,
        scale: 1.25,
      },
    ],
  };
  const MAPPED = [
    {
      id: "monitor-580651801",
      primary: true,
      bounds: { x: 0, y: 0, width: 5120, height: 2160 },
      scale: 1.5,
    },
    {
      id: "monitor-554109125",
      primary: false,
      bounds: { x: 5120, y: 700, width: 5120, height: 1440 },
      scale: 1.25,
    },
  ];
  const batchOf = (entry: Record<string, unknown>) =>
    JSON.stringify({ version: "2.6", ok: true, command: "batch", data: { results: [entry] } });

  test("listDisplays runs list-displays through one batch entry and maps the envelope", async () => {
    const { version: _v, ...entry } = DISPLAYS;
    const rec = recorder(() => ({ stdout: batchOf({ ...entry, version: "2.6" }) }));
    const { driver } = await installed("wsl", { spawnSync: rec.spawnSync });
    expect(driver.listDisplays?.(host("wsl"))).toEqual(MAPPED);
    const args = rec.calls.at(-1)?.args ?? [];
    expect(JSON.parse(args[1] ?? "")).toEqual([{ command: "list-displays", args: {} }]);
  });

  test("listDisplays gives an empty list for a failure, a non-zero exit or junk", async () => {
    const failed = recorder(() => ({
      stdout: batchOf({ ok: false, command: "list-displays", error: { message: "no" } }),
    }));
    const a = await installed("linux", { spawnSync: failed.spawnSync });
    expect(a.driver.listDisplays?.(host("linux"))).toEqual([]);
    const exit = recorder(() => ({ status: 3, stdout: JSON.stringify(DISPLAYS) }));
    const b = await installed("linux", { spawnSync: exit.spawnSync });
    expect(b.driver.listDisplays?.(host("linux"))).toEqual([]);
    // Not installed: the call throws, and the fallback stays empty.
    expect(createAgentDesktopDriver().listDisplays?.({ kind: "unsupported" })).toEqual([]);
    const junk = recorder(() => ({ stdout: "not json" }));
    const c = await installed("linux", { spawnSync: junk.spawnSync });
    expect(c.driver.listDisplays?.(host("linux"))).toEqual([]);
    expect(parseDisplayList(DISPLAYS)).toEqual(MAPPED);
    expect(parseDisplayList({ ...DISPLAYS, ok: false })).toEqual([]);
    expect(
      parseDisplayList({ ok: true, data: [{ id: "x", bounds: { x: 0, y: 0, width: 1 } }, 7] }),
    ).toEqual([]);
  });

  test("launchedProcess reads data.pid from a launch envelope only", () => {
    const ok = JSON.stringify({ ok: true, command: "launch", data: { app: "notepad", pid: 611 } });
    expect(agentDesktopLaunchedProcess("launch", ok)).toEqual({ pid: 611 });
    const cases: [string, string][] = [
      ["click", ok],
      ["launch", "not json"],
      ["launch", JSON.stringify({ ok: false, error: { code: "APP_UNRESPONSIVE" } })],
      ["launch", JSON.stringify({ ok: true, data: { app: "x" } })],
      ["launch", JSON.stringify({ ok: true, data: { pid: -1 } })],
    ];
    for (const [tool, stdout] of cases)
      expect(agentDesktopLaunchedProcess(tool, stdout)).toBeUndefined();
    expect(createAgentDesktopDriver().launchedProcess?.("launch", ok)).toEqual({ pid: 611 });
  });
});
