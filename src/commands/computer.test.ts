import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { initializeV3Fixture, seedV3Session } from "../../tests/helpers/event-v3-runtime.ts";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import type { EmitContext } from "../commander.ts";
import type {
  AgentWindowPatch,
  ComputerMode,
  ComputerPreferences,
  ComputerProjectConfig,
} from "../core/config.ts";
import type {
  BrowserGuard,
  GuardDecision,
  GuardOwner,
  GuardWindow,
} from "../lib/computer/browser-guard.ts";
import type { ConfirmRequest, ConfirmResult } from "../lib/computer/confirm.ts";
import type { Corner, DisplaySnapshot } from "../lib/computer/displays.ts";
import type { DesktopGrant, GrantLogEntry } from "../lib/computer/grants.ts";
import type {
  BrowserCall,
  BrowserObservation,
  DaemonStatus,
  DesktopDriver,
  DesktopLease,
  DisplayInfo,
  DriverCallResult,
  HostInfo,
  InstallPlan,
  LeaseAcquireResult,
  LeaseApi,
  LeaseOptions,
  LeaseOwner,
  Rect,
  WindowRef,
} from "../lib/computer/types.ts";
import {
  type ComputerDeps,
  type ComputerDepsInput,
  createComputerCommand,
  type DisplaysApi,
  EXIT_APPROVAL_REQUIRED,
  EXIT_LEASE_HELD,
  EXIT_PERSON_ACTIVE,
  type GrantsApi,
  placeWindow,
  redactInlineScreenshots,
  refreshDisplays,
  resolveLeaseOwner,
} from "./computer.ts";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const WSL_HOST: HostInfo = { kind: "wsl", desktopStateDir: "/mnt/c/Users/u/AppData/Local/harnery" };

/** Effective settings for one mode, as readComputerConfig would return them for a project default. */
function cfg(
  mode: ComputerMode,
  extra: Partial<ComputerProjectConfig> = {},
): ComputerProjectConfig {
  return {
    enabled: mode !== "off",
    mode,
    project_mode: mode,
    project_enabled: mode !== "off",
    mode_source: "project",
    sign_in: false,
    project_sign_in: false,
    sign_in_source: "default",
    person_sign_in: false,
    browser_attach: false,
    project_browser_attach: false,
    browser_attach_source: "default",
    person_browser_attach: false,
    agent_window: { display: "secondary", corner: "bottom-right", margin: 0, move_apps: true },
    agent_window_source: "default",
    ...extra,
  };
}

/** In-memory approvals with the real lifetime rules. */
function fakeGrants(): GrantsApi & { grants: DesktopGrant[]; logged: Omit<GrantLogEntry, "at">[] } {
  const api = {
    grants: [] as DesktopGrant[],
    logged: [] as Omit<GrantLogEntry, "at">[],
    sessionMaxMs: 12 * 3_600_000,
    defaultTaskMinutes: 20,
    live(_dir: string, ownerId: string, project: string | undefined, nowMs: number) {
      return api.grants.find(
        (g) => g.owner_id === ownerId && g.project === project && Date.parse(g.expires_at) > nowMs,
      );
    },
    add(
      _dir: string,
      grant: Omit<DesktopGrant, "id" | "granted_at" | "expires_at">,
      o: { nowMs: number; durationMs: number },
    ) {
      const record: DesktopGrant = {
        id: `g${api.grants.length + 1}`,
        ...grant,
        granted_at: new Date(o.nowMs).toISOString(),
        expires_at: new Date(o.nowMs + o.durationMs).toISOString(),
      };
      api.grants = api.grants.filter((g) => g.owner_id !== grant.owner_id).concat(record);
      return record;
    },
    end(_dir: string, o: { nowMs: number; ownerId?: string; kind?: "task" | "session" }) {
      const ended = api.grants.filter(
        (g) =>
          (o.ownerId === undefined || g.owner_id === o.ownerId) &&
          (o.kind === undefined || g.kind === o.kind),
      );
      api.grants = api.grants.filter((g) => !ended.includes(g));
      return ended;
    },
    log(_dir: string, entry: Omit<GrantLogEntry, "at">) {
      api.logged.push(entry);
    },
  };
  return api;
}

/** A scripted person: answers every prompt with `answer` and records what was asked. */
function fakeConfirm(answer: ConfirmResult = { answer: "approved", via: "dialog" }) {
  const asked: ConfirmRequest[] = [];
  const confirm = async (request: ConfirmRequest) => {
    asked.push(request);
    return answer;
  };
  return Object.assign(confirm, { asked });
}

function fakePrefs(initial: ComputerPreferences = {}) {
  const state = {
    prefs: initial,
    writes: [] as { root: string | null; mode: ComputerMode | null }[],
    signInWrites: [] as { root: string | null; on: boolean | null }[],
    attachWrites: [] as { root: string | null; on: boolean | null }[],
    windowWrites: [] as (AgentWindowPatch | null)[],
  };
  return {
    state,
    read: () => state.prefs,
    write: (root: string | null, mode: ComputerMode | null) => {
      state.writes.push({ root, mode });
      return state.prefs;
    },
    writeSignIn: (root: string | null, on: boolean | null) => {
      state.signInWrites.push({ root, on });
      return state.prefs;
    },
    writeBrowserAttach: (root: string | null, on: boolean | null) => {
      state.attachWrites.push({ root, on });
      return state.prefs;
    },
    writeAgentWindow: (patch: AgentWindowPatch | null) => {
      state.windowWrites.push(patch);
      if (patch === null) {
        const { agent_window: _gone, ...rest } = state.prefs;
        state.prefs = rest;
      } else {
        const merged: Record<string, unknown> = { ...(state.prefs.agent_window ?? {}) };
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        state.prefs = { ...state.prefs, agent_window: merged };
      }
      return state.prefs;
    },
  };
}

const PRIMARY: DisplayInfo = {
  id: "DISPLAY1",
  primary: true,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  work_area: { x: 0, y: 0, width: 1920, height: 1040 },
};
const SECONDARY: DisplayInfo = {
  id: "DISPLAY2",
  primary: false,
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  work_area: { x: 1920, y: 0, width: 2560, height: 1400 },
  scale: 1.5,
};
const TWO_DISPLAYS: DisplaySnapshot = {
  probed_at: new Date(NOW).toISOString(),
  source: "windows",
  displays: [SECONDARY, PRIMARY],
};

/** Display detection with scripted readings; placement math mirrors the real corner rule. */
function fakeDisplays(
  opts: { probe?: DisplaySnapshot; cache?: DisplaySnapshot | null; probeThrows?: boolean } = {},
) {
  const log = {
    probes: 0,
    reads: 0,
    writes: [] as { dir: string; snapshot: DisplaySnapshot }[],
    corners: [] as {
      display: string;
      corner: Corner;
      size: { width: number; height: number };
      margin: number;
    }[],
  };
  let cache = opts.cache ?? null;
  const ordered = (list: DisplayInfo[]) => [...list].sort((a, b) => a.bounds.x - b.bounds.x);
  const api: DisplaysApi & { log: typeof log } = {
    log,
    probe: () => {
      log.probes++;
      if (opts.probeThrows) throw new Error("probe exploded");
      return opts.probe ?? TWO_DISPLAYS;
    },
    readCache: () => {
      log.reads++;
      return cache;
    },
    writeCache: (dir, snapshot) => {
      log.writes.push({ dir, snapshot });
      cache = snapshot;
    },
    pick: (displays, selector) => {
      const list = ordered(displays);
      if (selector === "primary") return list.find((d) => d.primary) ?? list[0];
      if (selector === "secondary") return list.find((d) => !d.primary) ?? list[0];
      if (/^\d+$/.test(selector)) return list[Number(selector) - 1];
      return list.find((d) => d.id === selector);
    },
    corner: (display, corner, size, margin) => {
      log.corners.push({
        display: display.id,
        corner,
        size: { width: size.width, height: size.height },
        margin,
      });
      const area = display.work_area ?? display.bounds;
      const right = corner.endsWith("right");
      const bottom = corner.startsWith("bottom");
      return {
        x: right ? area.x + area.width - size.width - margin : area.x + margin,
        y: bottom ? area.y + area.height - size.height - margin : area.y + margin,
      };
    },
    describe: (d) =>
      `${d.id}: ${d.bounds.width} by ${d.bounds.height}${d.primary ? ", primary" : ""}`,
  };
  return api;
}

/** A driver that moves windows; the program clamps sizes to at least 400 by 300. */
function moverDriver(
  opts: {
    windows?: (WindowRef & { frame?: Rect })[][];
    launched?: number;
    frameFails?: boolean;
  } = {},
) {
  const base = fakeDriver();
  const frames: { window: WindowRef; frame: Partial<Rect> }[] = [];
  const windowsCalls: number[] = [];
  let current: Rect = { x: 50, y: 50, width: 1200, height: 900 };
  const lists = opts.windows ?? [];
  const driver: FakeDriver = {
    ...base,
    setWindowFrame: (_host, window, frame) => {
      frames.push({ window: { pid: window.pid, window_id: window.window_id }, frame });
      if (opts.frameFails) return undefined;
      current = {
        x: frame.x ?? current.x,
        y: frame.y ?? current.y,
        width: frame.width !== undefined ? Math.max(400, frame.width) : current.width,
        height: frame.height !== undefined ? Math.max(300, frame.height) : current.height,
      };
      return { ...current };
    },
    windowsOf: (_host, pid) => {
      windowsCalls.push(pid);
      return lists.length > 1 ? (lists.shift() ?? []) : (lists[0] ?? []);
    },
    ...(opts.launched !== undefined
      ? {
          launchedProcess: (tool: string) =>
            tool === "launch_app" ? { pid: opts.launched as number } : undefined,
        }
      : {}),
  };
  return { driver, frames, windowsCalls, calls: base.calls };
}

interface Captured {
  emit: EmitContext;
  text: string[];
  data: unknown[];
  errors: { code: string; message: string }[];
  stderr: string[];
  exitCode: () => number;
}

function capture(): Captured {
  const text: string[] = [];
  const data: unknown[] = [];
  const errors: { code: string; message: string }[] = [];
  const stderr: string[] = [];
  let code = 0;
  const emit: EmitContext = {
    config() {},
    data: (payload) => data.push(payload),
    rows() {},
    text: (s) => text.push(s),
    file() {},
    error: (err) => {
      errors.push(err as { code: string; message: string });
      code = code || 1;
    },
    log: (msg) => text.push(msg),
    setExitCode: (n) => {
      code = n;
    },
  };
  return { emit, text, data, errors, stderr, exitCode: () => code };
}

function lease(overrides: Partial<DesktopLease> = {}): DesktopLease {
  return {
    schema: 1,
    owner_id: "other-id",
    owner_label: "agent-Other",
    generation: 4,
    acquired_at: new Date(NOW - 10_000).toISOString(),
    refreshed_at: new Date(NOW - 5_000).toISOString(),
    expires_at: new Date(NOW + 90_000).toISOString(),
    ...overrides,
  };
}

interface FakeDriver extends DesktopDriver {
  calls: { tool: string; args: Record<string, unknown> }[];
  installs: number;
  started: number;
}

function fakeDriver(
  opts: {
    installed?: boolean;
    running?: boolean;
    stdout?: string;
    id?: string;
    hasDaemon?: boolean;
  } = {},
): FakeDriver {
  let running = opts.running ?? true;
  const plan: InstallPlan = {
    driver: "fake",
    version: "1.2.3",
    host: "wsl",
    artifact: {
      version: "1.2.3",
      fileName: "fake.zip",
      url: "https://example.invalid/fake.zip",
      sha256: "ab".repeat(32),
      format: "zip",
      executableEntry: "fake.exe",
    },
    installDir: "/mnt/c/state/tools/fake/1.2.3",
    executable: "/mnt/c/state/tools/fake/1.2.3/fake.exe",
    alreadyInstalled: false,
    preferenceFile: "/mnt/c/state/fake.json",
    preferences: { telemetry_enabled: false },
  };
  const ok = (stdout: string): DriverCallResult => ({ exitCode: 0, stdout, stderr: "" });
  const driver: FakeDriver = {
    id: opts.id ?? "fake",
    version: "1.2.3",
    summary: "fake driver",
    hasDaemon: opts.hasDaemon ?? true,
    calls: [],
    installs: 0,
    started: 0,
    planInstall: () => plan,
    install: async (p) => {
      driver.installs++;
      return { ...p, installed: true };
    },
    installedExecutable: () => (opts.installed === false ? undefined : plan.executable),
    daemonStatus: (): DaemonStatus => ({
      running,
      detail: running ? "running" : "stopped",
      pid: running ? 42 : undefined,
    }),
    startDaemon: async () => {
      driver.started++;
      running = true;
      return { running, detail: "running", pid: 43 };
    },
    stopDaemon: () => {
      running = false;
      return { running, detail: "stopped" };
    },
    call: (_host, tool, args) => {
      driver.calls.push({ tool, args });
      return ok(opts.stdout ?? '{"ok":true}\n');
    },
    listTools: () => ok("click: click a thing\n"),
    describe: (_host, tool) => ok(`${tool}: schema\n`),
    health: () => ok(JSON.stringify({ checks: [{ name: "uia", status: "pass" }] })),
    translateArgsPaths: (_h, _t, args) => args,
    translateResultPaths: (_h, stdout) => stdout,
  };
  return driver;
}

/** A browser guard that records every call and answers from scripted state. */
function fakeGuard(
  opts: {
    refuse?: (call: BrowserCall) => GuardDecision | undefined;
    observeThrows?: boolean;
    work?: { sessions: string[]; windows: WindowRef[] };
    list?: GuardWindow[];
  } = {},
) {
  const log = {
    checks: [] as { owner: GuardOwner; call: BrowserCall; personWindow?: boolean }[],
    observed: [] as {
      call: BrowserCall;
      observation: BrowserObservation;
      personWindow?: boolean;
    }[],
    recorded: [] as (WindowRef & { session: string })[],
    cleared: 0,
    ops: [] as string[],
  };
  let work = opts.work ?? { sessions: [], windows: [] };
  const guard: BrowserGuard & { log: typeof log } = {
    log,
    recordWindow(_owner, window) {
      log.ops.push("record");
      log.recorded.push(window);
    },
    check(owner, call, o) {
      log.checks.push({ owner, call, personWindow: o?.personWindow });
      return opts.refuse?.(call) ?? { ok: true };
    },
    observe(_owner, call, observation, o) {
      log.ops.push(`observe:${call.tool}`);
      if (opts.observeThrows) throw new Error("disk full");
      log.observed.push({ call, observation, personWindow: o?.personWindow });
    },
    work: () => {
      const recorded = log.recorded.map((w) => ({ pid: w.pid, window_id: w.window_id }));
      return {
        sessions: [...new Set([...work.sessions, ...log.recorded.map((w) => w.session)])],
        windows: [...work.windows, ...recorded],
      };
    },
    clear() {
      log.cleared++;
      work = { sessions: [], windows: [] };
      log.recorded.length = 0;
    },
    list: () => opts.list ?? [],
  };
  return guard;
}

/** A driver with the browser-guard methods: `click`/`type_text` are browser calls, `run_steps` nests two. */
function browserDriver(
  opts: {
    bindStdout?: string;
    prepareExit?: number;
    prepareStdout?: string;
    closeable?: (w: WindowRef) => boolean;
    openBrowserWindow?: boolean;
  } = {},
) {
  const base = fakeDriver();
  const order: string[] = [];
  const closed: WindowRef[] = [];
  const opened: { url?: string; pid?: number }[] = [];
  const driver: FakeDriver = {
    ...base,
    supportsBrowserAttach: true,
    attachesPersonBrowser: (tool) => tool === "browser_prepare",
    browserCalls: (tool, args) => {
      const one = (kind: BrowserCall["kind"], t: string): BrowserCall => ({
        kind,
        tool: t,
        ...(typeof args.session === "string" ? { session: args.session } : {}),
        ...(typeof args.pid === "number" ? { pid: args.pid } : {}),
        ...(typeof args.window_id === "number" ? { window_id: args.window_id } : {}),
        ...(typeof args.target_id === "string" ? { target_id: args.target_id } : {}),
      });
      if (tool === "browser_prepare") return [one("attach", tool)];
      if (tool === "get_browser_state") return [one("bind", tool)];
      if (tool === "type_text") return [one("type", tool)];
      if (tool === "run_steps") return [one("point", "click"), one("type", "type_text")];
      return [];
    },
    browserObservation: (call, stdout) =>
      call.tool === "type_text" ? { delivered: stdout.includes("ok") } : {},
    closeWindow: (_host, w) => {
      order.push(`close:${w.window_id}`);
      const ok = opts.closeable?.(w) ?? true;
      if (ok) closed.push(w);
      return ok;
    },
    call: (_host, tool, args) => {
      order.push(`call:${tool}`);
      base.calls.push({ tool, args });
      if (tool === "browser_prepare" && opts.prepareExit)
        return { exitCode: opts.prepareExit, stdout: "attach failed\n", stderr: "" };
      if (tool === "browser_prepare" && opts.prepareStdout)
        return { exitCode: 0, stdout: opts.prepareStdout, stderr: "" };
      if (tool === "get_browser_state")
        return {
          exitCode: 0,
          stdout:
            opts.bindStdout ??
            JSON.stringify({
              target_id: "t-9",
              tabs: [
                { tab_id: "tab-1", url: "about:blank" },
                { tab_id: "tab-2", url: "https://example.com/", active: true },
              ],
            }),
          stderr: "",
        };
      return { exitCode: 0, stdout: '{"ok":true}\n', stderr: "" };
    },
  };
  if (opts.openBrowserWindow !== false)
    driver.openBrowserWindow = async (_host, o) => {
      order.push("open");
      opened.push(o);
      return { pid: 700, window_id: 55 };
    };
  return { driver, order, closed, opened, calls: base.calls };
}

function fakeLease(holder: DesktopLease | null = null): LeaseApi & { acquired: LeaseOptions[] } {
  const api = {
    acquired: [] as LeaseOptions[],
    async acquire(owner: LeaseOwner, opts: LeaseOptions): Promise<LeaseAcquireResult> {
      api.acquired.push(opts);
      if (holder && holder.owner_id !== owner.id)
        return { ok: false, holder, waitedMs: opts.waitMs ?? 0 };
      return {
        ok: true,
        fresh: true,
        lease: lease({ owner_id: owner.id, owner_label: owner.label, generation: 1 }),
      };
    },
    release: () => false,
    read: () => holder,
  };
  return api;
}

async function run(
  argv: string[],
  over: Partial<ComputerDepsInput> & { config?: () => ComputerProjectConfig } = {},
): Promise<Captured> {
  const cap = capture();
  const program = new Command().exitOverride();
  createComputerCommand(
    {
      emit: cap.emit,
      binName: "acme",
      host: () => WSL_HOST,
      driver: fakeDriver(),
      lease: fakeLease(),
      leaseDir: (dir) => `${dir}/computer`,
      defaultIdleMs: 120_000,
      owner: () => ({ id: "me-id", label: "agent-Me" }),
      config: () => cfg("on"),
      grants: fakeGrants(),
      confirm: fakeConfirm(),
      prefs: fakePrefs(),
      projectRoot: () => "/proj",
      writeStderr: (s) => cap.stderr.push(s),
      now: () => NOW,
      browserGuard: () => fakeGuard(),
      displays: fakeDisplays(),
      ...over,
    },
    program,
  );
  await program.parseAsync(["node", "acme", "computer", ...argv]);
  return cap;
}

describe("computer status", () => {
  test("reports host, pinned version, install, daemon, lease holder, and enabled flag", async () => {
    const cap = await run(["status"], { lease: fakeLease(lease()) });
    const out = cap.text.join("\n");
    expect(out).toContain("mode:      on: on, no asking");
    expect(out).toContain("host:      wsl");
    expect(out).toContain("fake 1.2.3 (pinned, default): fake driver");
    expect(out).toContain("/mnt/c/state/tools/fake/1.2.3/fake.exe");
    expect(out).toContain("running (pid 42)");
    expect(out).toContain("held by agent-Other (generation 4, idle-expires in 90s)");
    expect(cap.exitCode()).toBe(0);
  });

  test("--json carries not-installed and a free desktop", async () => {
    const cap = await run(["status", "--json"], {
      driver: fakeDriver({ installed: false }),
      config: () => cfg("off"),
    });
    expect(cap.data[0]).toMatchObject({
      enabled: false,
      host: { kind: "wsl" },
      default_driver: "fake",
      drivers: [{ id: "fake", version: "1.2.3", installed: null, daemon: null }],
      lease: null,
    });
  });

  test("an unsupported host is reported with its reason", async () => {
    const cap = await run(["status"], {
      host: () => ({ kind: "unsupported", reason: "macOS is not yet supported" }),
    });
    expect(cap.text.join("\n")).toContain("unsupported (macOS is not yet supported)");
  });
});

describe("computer install", () => {
  test("refuses when computer.enabled is not true, naming how to enable it", async () => {
    const driver = fakeDriver({ installed: false });
    const cap = await run(["install", "--yes"], { driver, config: () => cfg("off") });
    expect(cap.exitCode()).toBe(1);
    expect(cap.errors[0]?.message).toContain('"computer": { "mode": "ask-each-task" }');
    expect(driver.installs).toBe(0);
  });

  test("previews without --yes and installs with it", async () => {
    const driver = fakeDriver({ installed: false });
    const preview = await run(["install"], { driver });
    const out = preview.text.join("\n");
    expect(out).toContain("https://example.invalid/fake.zip");
    expect(out).toContain("ab".repeat(32));
    expect(out).toContain("acme computer install --yes");
    expect(driver.installs).toBe(0);

    const applied = await run(["install", "--yes"], { driver });
    expect(driver.installs).toBe(1);
    expect(applied.text.join("\n")).toContain("acme computer up");
  });

  test("unsupported host exits 1 with the host's reason", async () => {
    const cap = await run(["install"], {
      host: () => ({ kind: "unsupported", reason: "Linux desktops are not yet supported" }),
    });
    expect(cap.exitCode()).toBe(1);
    expect(cap.errors[0]?.message).toContain("Linux desktops are not yet supported");
  });
});

describe("computer up", () => {
  test("names the install command when the driver is missing", async () => {
    const cap = await run(["up"], { driver: fakeDriver({ installed: false }) });
    expect(cap.exitCode()).toBe(1);
    expect(cap.errors[0]?.message).toContain("acme computer install --driver fake --yes");
  });
});

describe("computer call", () => {
  test("injects the owner label as session, takes the lease, and starts the daemon", async () => {
    const driver = fakeDriver({ running: false });
    const leaseApi = fakeLease();
    const cap = await run(["call", "launch_app", '{"name":"notepad"}'], {
      driver,
      lease: leaseApi,
      config: () => cfg("on", { idle_seconds: 60, wait_seconds: 5 }),
    });
    expect(cap.exitCode()).toBe(0);
    expect(driver.calls[0]).toEqual({
      tool: "launch_app",
      args: { name: "notepad", session: "agent-Me" },
    });
    expect(driver.started).toBe(1);
    expect(leaseApi.acquired[0]).toMatchObject({ idleMs: 60_000, waitMs: 5_000 });
    expect(cap.text.join("")).toContain('{"ok":true}');
  });

  test("keeps an explicit session and honors --wait over config", async () => {
    const driver = fakeDriver();
    const leaseApi = fakeLease();
    await run(["call", "click", '{"session":"mine"}', "--wait", "2"], { driver, lease: leaseApi });
    expect(driver.calls[0]?.args.session).toBe("mine");
    expect(leaseApi.acquired[0]?.waitMs).toBe(2_000);
    expect(leaseApi.acquired[0]?.idleMs).toBe(120_000);
  });

  test("redacts inline base64 screenshots unless --keep-screenshot", async () => {
    const b64 = "iVBORw0KGgo".repeat(100);
    const stdout = `{"snapshot_id":"s1","screenshot_png_b64":"${b64}"}\n`;
    const redacted = await run(["call", "get_window_state", "{}"], {
      driver: fakeDriver({ stdout }),
    });
    const out = redacted.text.join("");
    expect(out).not.toContain(b64);
    expect(out).toContain(
      `<omitted ${b64.length} chars; save to a file (screenshot_out_file or output_path) or pass --keep-screenshot>`,
    );
    expect(out).toContain('"snapshot_id":"s1"');

    const kept = await run(["call", "get_window_state", "{}", "--keep-screenshot"], {
      driver: fakeDriver({ stdout }),
    });
    expect(kept.text.join("")).toContain(b64);
  });

  test("a lease held by another agent exits 3 naming the holder and the release command", async () => {
    const driver = fakeDriver();
    const cap = await run(["call", "click", "{}"], { driver, lease: fakeLease(lease()) });
    expect(cap.exitCode()).toBe(EXIT_LEASE_HELD);
    const message = cap.errors[0]?.message ?? "";
    expect(message).toContain("Desktop is held by agent-Other (generation 4, idle-expires in 90s)");
    expect(message).toContain("`acme computer lease release`");
    expect(driver.calls).toHaveLength(0);
  });

  test("rejects non-object JSON and refuses when disabled", async () => {
    const bad = await run(["call", "click", "[1]"]);
    expect(bad.exitCode()).toBe(1);
    expect(bad.errors[0]?.message).toContain("JSON object");

    const off = await run(["call", "click"], { config: () => cfg("off") });
    expect(off.exitCode()).toBe(1);
    expect(off.errors[0]?.code).toBe("computer_disabled");
  });

  test("propagates the driver's exit code and stderr", async () => {
    const driver = fakeDriver();
    driver.call = () => ({ exitCode: 7, stdout: '{"error":"x"}', stderr: "boom" });
    const cap = await run(["call", "click", "{}"], { driver });
    expect(cap.exitCode()).toBe(7);
    expect(cap.stderr.join("")).toContain("boom");
  });
});

describe("computer call before a foreground action", () => {
  /** A driver that treats `delivery_mode: "foreground"` as a foreground action. */
  function foregroundDriver(): FakeDriver {
    const driver = fakeDriver();
    driver.takesForeground = (_tool, args) => args.delivery_mode === "foreground";
    return driver;
  }

  /** Idle readings in order (the last repeats) and a clock that moves only when the wait sleeps. */
  function quietDeps(readings: (number | null)[]) {
    let clock = NOW;
    let index = 0;
    const probes: number[] = [];
    return {
      probes,
      deps: {
        personIdleMs: () => {
          probes.push(clock - NOW);
          return readings[Math.min(index++, readings.length - 1)] ?? null;
        },
        sleep: async (ms: number) => {
          clock += ms;
        },
        now: () => clock,
      },
    };
  }

  const FOREGROUND = '{"pid":1,"delivery_mode":"foreground"}';

  test("a background action never reads the person's activity", async () => {
    const driver = foregroundDriver();
    const quiet = quietDeps([0]);
    const cap = await run(["call", "click", '{"pid":1}'], { driver, ...quiet.deps });
    expect(cap.exitCode()).toBe(0);
    expect(quiet.probes).toEqual([]);
    expect(driver.calls).toHaveLength(1);
  });

  test("it is sent at once when the person is away", async () => {
    const driver = foregroundDriver();
    const quiet = quietDeps([9000]);
    const cap = await run(["call", "click", FOREGROUND], { driver, ...quiet.deps });
    expect(cap.exitCode()).toBe(0);
    expect(driver.calls).toHaveLength(1);
    expect(cap.stderr).toEqual([]);
  });

  test("it waits for the person to stop typing, then says how long it waited", async () => {
    const driver = foregroundDriver();
    const quiet = quietDeps([0, 1000, 3000]);
    const cap = await run(["call", "click", FOREGROUND], { driver, ...quiet.deps });
    expect(cap.exitCode()).toBe(0);
    expect(quiet.probes).toEqual([0, 3000, 5000]);
    expect(driver.calls).toHaveLength(1);
    expect(cap.stderr.join("")).toContain("Waited 5s");
  });

  test("it is refused, with nothing sent, when the person stays busy", async () => {
    const driver = foregroundDriver();
    const quiet = quietDeps([0]);
    const cap = await run(["call", "click", FOREGROUND], { driver, ...quiet.deps });
    expect(cap.exitCode()).toBe(EXIT_PERSON_ACTIVE);
    expect(cap.errors[0]?.code).toBe("person_active");
    expect(cap.errors[0]?.message).toContain("waited 60s for 3s of quiet");
    expect(driver.calls).toEqual([]);
  });

  test("the lease covers the wait, and returns to its normal length after a refusal", async () => {
    const lease = fakeLease();
    const quiet = quietDeps([0]);
    await run(["call", "click", FOREGROUND], { driver: foregroundDriver(), lease, ...quiet.deps });
    expect(lease.acquired.map((o) => o.idleMs)).toEqual([180_000, 120_000]);
  });

  test("a host with no reading does not hold the action back", async () => {
    const driver = foregroundDriver();
    const quiet = quietDeps([null]);
    const cap = await run(["call", "click", FOREGROUND], { driver, ...quiet.deps });
    expect(cap.exitCode()).toBe(0);
    expect(driver.calls).toHaveLength(1);
  });

  test("the project sets both periods, and 0 turns the wait off", async () => {
    const tuned = quietDeps([0]);
    const cap = await run(["call", "click", FOREGROUND], {
      driver: foregroundDriver(),
      config: () => cfg("on", { foreground_quiet_seconds: 1, foreground_wait_seconds: 2 }),
      ...tuned.deps,
    });
    expect(cap.exitCode()).toBe(EXIT_PERSON_ACTIVE);
    expect(cap.errors[0]?.message).toContain("waited 2s for 1s of quiet");

    const driver = foregroundDriver();
    const off = quietDeps([0]);
    const sent = await run(["call", "click", FOREGROUND], {
      driver,
      config: () => cfg("on", { foreground_quiet_seconds: 0 }),
      ...off.deps,
    });
    expect(sent.exitCode()).toBe(0);
    expect(off.probes).toEqual([]);
    expect(driver.calls).toHaveLength(1);
  });

  test("status reports the wait", async () => {
    const cap = await run(["status"]);
    expect(cap.text.join("\n")).toContain(
      "quiet:     a foreground action waits until the keyboard and mouse have been quiet for 3s, for up to 60s",
    );
    const off = await run(["status"], {
      config: () => cfg("on", { foreground_quiet_seconds: 0 }),
    });
    expect(off.text.join("\n")).toContain("sent at once (the quiet wait is off)");
  });
});

describe("computer lease", () => {
  test("status shows the holder; release by a non-holder exits 3", async () => {
    const held = fakeLease(lease());
    const status = await run(["lease", "status"], { lease: held });
    expect(status.text.join("")).toContain("held by agent-Other");
    const release = await run(["lease", "release"], { lease: held });
    expect(release.exitCode()).toBe(EXIT_LEASE_HELD);
  });

  test("acquire takes a free desktop", async () => {
    const cap = await run(["lease", "acquire"]);
    expect(cap.exitCode()).toBe(0);
    expect(cap.text.join("")).toContain("Acquired the desktop lease: agent-Me");
  });
});

describe("computer doctor", () => {
  test("passes on all-pass checks and fails on any other status", async () => {
    const pass = await run(["doctor"]);
    expect(pass.exitCode()).toBe(0);
    expect(pass.text.join("")).toContain("uia");

    const driver = fakeDriver();
    driver.health = () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        checks: [{ name: "uia", status: "warn", message: "truncated tree" }],
      }),
      stderr: "",
    });
    const fail = await run(["doctor"], { driver });
    expect(fail.exitCode()).toBe(1);
    expect(fail.text.join("")).toContain("truncated tree");
  });
});

describe("redactInlineScreenshots", () => {
  test("handles nested and pretty-printed keys ending in png_b64", () => {
    const out = redactInlineScreenshots(
      '{\n  "a": {\n    "png_b64": "QUJD"\n  },\n  "zoom_png_b64" : "REVG"\n}',
    );
    expect(out).toContain('"png_b64": "<omitted 4 chars;');
    expect(out).toContain('"zoom_png_b64" : "<omitted 4 chars;');
  });
});

describe("computer approval modes", () => {
  test("ask-each-task refuses call and lease acquire without an approval, exit 4", async () => {
    const driver = fakeDriver();
    const leaseApi = fakeLease();
    const cap = await run(["call", "click", "{}"], {
      driver,
      lease: leaseApi,
      config: () => cfg("ask-each-task"),
    });
    expect(cap.exitCode()).toBe(EXIT_APPROVAL_REQUIRED);
    expect(cap.errors[0]?.code).toBe("computer_approval_required");
    expect(cap.errors[0]?.message).toContain('acme computer grant --purpose "');
    expect(driver.calls).toHaveLength(0);
    expect(leaseApi.acquired).toHaveLength(0);

    const acquire = await run(["lease", "acquire"], { config: () => cfg("ask-once-per-session") });
    expect(acquire.exitCode()).toBe(EXIT_APPROVAL_REQUIRED);
  });

  test("an approved task grant lets calls through until done ends it", async () => {
    const grants = fakeGrants();
    const confirm = fakeConfirm();
    const driver = fakeDriver();
    const over = {
      grants,
      confirm,
      driver,
      config: () => cfg("ask-each-task", { grant_minutes: 15 }),
    };

    const granted = await run(["grant", "--purpose", "export October invoices"], over);
    expect(granted.exitCode()).toBe(0);
    expect(confirm.asked[0]?.message).toContain("What for: export October invoices");
    expect(confirm.asked[0]?.message).toContain("up to 15 minutes");
    expect(confirm.asked[0]?.message).toContain("every screen");
    expect(grants.grants[0]).toMatchObject({
      kind: "task",
      owner_id: "me-id",
      approved_via: "dialog",
    });
    expect(Date.parse(grants.grants[0]!.expires_at) - NOW).toBe(15 * 60_000);
    expect(grants.logged.map((e) => e.event)).toEqual(["requested", "approved"]);

    const call = await run(["call", "click", "{}"], over);
    expect(call.exitCode()).toBe(0);
    expect(driver.calls).toHaveLength(1);

    const done = await run(["done"], over);
    expect(done.text.join("")).toContain("ended your task approval");
    expect(grants.grants).toHaveLength(0);
    const after = await run(["call", "click", "{}"], over);
    expect(after.exitCode()).toBe(EXIT_APPROVAL_REQUIRED);
  });

  test("ask-once-per-session grants a session approval capped at the session maximum", async () => {
    const grants = fakeGrants();
    const confirm = fakeConfirm();
    await run(["grant", "--purpose", "check the CRM"], {
      grants,
      confirm,
      config: () => cfg("ask-once-per-session"),
    });
    expect(grants.grants[0]?.kind).toBe("session");
    expect(Date.parse(grants.grants[0]!.expires_at) - NOW).toBe(grants.sessionMaxMs);
    expect(confirm.asked[0]?.message).toContain("rest of this agent's session");
  });

  test("a refusal, silence, or no way to ask all leave the desktop off, exit 4", async () => {
    for (const [answer, expected] of [
      [{ answer: "denied", via: "dialog" }, "said no"],
      [{ answer: "timed-out", via: "dialog" }, "counts as no"],
      [{ answer: "unavailable", detail: "no desktop dialog" }, "their own terminal"],
    ] as const) {
      const grants = fakeGrants();
      const cap = await run(["grant", "--purpose", "x"], {
        grants,
        confirm: fakeConfirm(answer as ConfirmResult),
        config: () => cfg("ask-each-task"),
      });
      expect(cap.exitCode()).toBe(EXIT_APPROVAL_REQUIRED);
      expect(cap.errors[0]?.message).toContain(expected);
      expect(grants.grants).toHaveLength(0);
    }
  });

  test("on mode needs no approval and never asks", async () => {
    const confirm = fakeConfirm();
    const cap = await run(["grant", "--purpose", "x"], { confirm });
    expect(cap.text.join("")).toContain("No approval needed");
    expect(confirm.asked).toHaveLength(0);
  });

  test("revoke ends your approval, --all ends everyone's", async () => {
    const grants = fakeGrants();
    const over = { grants, config: () => cfg("ask-each-task") };
    await run(["grant", "--purpose", "x"], over);
    await run(["grant", "--purpose", "y"], {
      ...over,
      owner: () => ({ id: "other", label: "agent-Other" }),
    });
    await run(["revoke"], over);
    expect(grants.grants.map((g) => g.owner_id)).toEqual(["other"]);
    const all = await run(["revoke", "--all"], over);
    expect(all.text.join("")).toContain("agent-Other");
    expect(grants.grants).toHaveLength(0);
  });

  test("lease release also ends the task approval", async () => {
    const grants = fakeGrants();
    const over = { grants, config: () => cfg("ask-each-task") };
    await run(["grant", "--purpose", "x"], over);
    await run(["lease", "release"], over);
    expect(grants.grants).toHaveLength(0);
    expect(grants.logged.at(-1)).toMatchObject({ event: "ended", detail: "released the desktop" });
  });

  test("a call holds the lease past the driver's timeout, then refreshes to the idle period", async () => {
    const driver = { ...fakeDriver(), callTimeoutMs: 120_000 } as FakeDriver;
    driver.calls = [];
    const leaseApi = fakeLease();
    await run(["call", "click", "{}"], {
      driver,
      lease: leaseApi,
      config: () => cfg("on", { idle_seconds: 60 }),
    });
    expect(leaseApi.acquired.map((o) => o.idleMs)).toEqual([135_000, 60_000]);
  });

  test("an invalid project section is reported, not treated as on", async () => {
    const cap = await run(["call", "click", "{}"], {
      config: () => cfg("off", { config_error: 'computer.mode must be one of ...; got "yes"' }),
    });
    expect(cap.errors[0]?.code).toBe("computer_config_invalid");
  });
});

describe("resolveLeaseOwner across projects", () => {
  // Everything owner resolution reads from the environment, cleared per test so
  // the session running this suite cannot leak into it.
  const KEYS = [
    "HARNERY_AGENT_COORD_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "CURSOR_SESSION_ID",
    "CURSOR_CONVERSATION_ID",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
    "OPENCODE_SESSION_ID",
    "HARNERY_AGENT_COORD_OWNER",
    "HARNERY_AGENT_COORD_BRIDGE",
    "HARNERY_AGENT_COORD_PLATFORM",
    "CLAUDE_PROJECT_DIR",
    "HARNERY_COORD_ROOT_OVERRIDE",
  ] as const;
  const saved = KEYS.map((key) => [key, process.env[key]] as const);
  let base: string;
  /** The workspace the agent's session is registered in. */
  let workspace: string;
  /** A project nested inside it that the agent acts on. */
  let project: string;
  /** A plain directory to resolve from, outside every coordination root. */
  let elsewhere: string;

  beforeEach(() => {
    base = resolve(mkdtempSync(join(tmpdir(), "harn-computer-owner-")));
    workspace = join(base, "workspace");
    project = join(workspace, "client-project");
    elsewhere = join(base, "elsewhere");
    mkdirSync(join(workspace, ".harnery"), { recursive: true });
    mkdirSync(join(project, ".harnery"), { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    initializeV3Fixture(workspace);
    initializeV3Fixture(project);
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeDir(base);
  });

  test("an agent registered in the project it acts on is named from it", () => {
    seedV3Session(project, "inst-ada", {
      sessionId: "sess-ada",
      adapter: "claude-code",
      name: "Ada",
    });
    process.env.CLAUDE_CODE_SESSION_ID = "sess-ada";
    process.env.HARNERY_COORD_ROOT_OVERRIDE = project;
    expect(resolveLeaseOwner(elsewhere)).toEqual({
      id: "inst-ada",
      label: "agent-Ada",
      project,
      sessionProject: project,
    });
  });

  test("an agent acting on another project is named from its own", () => {
    seedV3Session(workspace, "inst-bob", {
      sessionId: "sess-bob",
      adapter: "claude-code",
      name: "Bob",
    });
    process.env.CLAUDE_CODE_SESSION_ID = "sess-bob";
    process.env.HARNERY_COORD_ROOT_OVERRIDE = project;
    expect(resolveLeaseOwner(elsewhere)).toEqual({
      id: "inst-bob",
      label: "agent-Bob",
      project,
      sessionProject: workspace,
    });
  });

  test("a session in an unrelated project is found through the adapter's project dir", () => {
    const sibling = join(base, "sibling");
    mkdirSync(join(sibling, ".harnery"), { recursive: true });
    initializeV3Fixture(sibling);
    seedV3Session(sibling, "inst-cy", { sessionId: "sess-cy", adapter: "claude-code", name: "Cy" });
    process.env.CLAUDE_CODE_SESSION_ID = "sess-cy";
    process.env.CLAUDE_PROJECT_DIR = sibling;
    process.env.HARNERY_COORD_ROOT_OVERRIDE = project;
    expect(resolveLeaseOwner(elsewhere)).toMatchObject({
      id: "inst-cy",
      label: "agent-Cy",
      project,
      sessionProject: sibling,
    });
  });

  test("the acting project's sole live agent does not outrank the caller's own session", () => {
    seedV3Session(project, "inst-stranger", { sessionId: "sess-x", adapter: "claude-code" });
    seedV3Session(workspace, "inst-bob", {
      sessionId: "sess-bob",
      adapter: "claude-code",
      name: "Bob",
    });
    process.env.CLAUDE_CODE_SESSION_ID = "sess-bob";
    process.env.HARNERY_COORD_ROOT_OVERRIDE = project;
    expect(resolveLeaseOwner(elsewhere).id).toBe("inst-bob");
  });

  test("with no session anywhere the caller is the operating-system user", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sess-unknown";
    process.env.HARNERY_COORD_ROOT_OVERRIDE = project;
    const owner = resolveLeaseOwner(elsewhere);
    expect(owner.id.startsWith(`shell:${userInfo().username}@`)).toBe(true);
    expect(owner.label).toBe(`shell-${userInfo().username}`);
    expect(owner.project).toBe(project);
    expect(owner.sessionProject).toBeUndefined();
  });

  test("grant, call and done agree on a cross-project agent", async () => {
    seedV3Session(workspace, "inst-bob", {
      sessionId: "sess-bob",
      adapter: "claude-code",
      name: "Bob",
    });
    process.env.CLAUDE_CODE_SESSION_ID = "sess-bob";
    process.env.HARNERY_COORD_ROOT_OVERRIDE = project;
    const grants = fakeGrants();
    const confirm = fakeConfirm();
    const driver = fakeDriver();
    const over = {
      grants,
      confirm,
      driver,
      owner: () => resolveLeaseOwner(elsewhere),
      config: () => cfg("ask-each-task"),
    };

    expect((await run(["grant", "--purpose", "file the report"], over)).exitCode()).toBe(0);
    expect(confirm.asked[0]?.message).toContain(
      "agent-Bob (an AI agent working in workspace) wants to use this computer's screen",
    );
    expect(grants.grants[0]).toMatchObject({
      owner_id: "inst-bob",
      owner_label: "agent-Bob",
      project,
    });
    expect((await run(["call", "click", "{}"], over)).exitCode()).toBe(0);
    expect(driver.calls).toHaveLength(1);
    await run(["done"], over);
    expect(grants.grants).toHaveLength(0);
  });
});

describe("computer mode", () => {
  const evaluate = (projectMode: ComputerMode) => (prefs?: ComputerPreferences) => {
    const personal = prefs?.projects?.["/proj"] ?? prefs?.mode;
    if (projectMode === "off" || !personal) return cfg(projectMode);
    return { ...cfg(personal), project_mode: projectMode, mode_source: "user-project" as const };
  };

  test("shows the effective mode and where it came from", async () => {
    const cap = await run(["mode"], { config: evaluate("ask-each-task") });
    expect(cap.text.join("")).toContain(
      "ask-each-task: ask before each task (the project's setting",
    );
  });

  test("loosening asks the person first; tightening does not", async () => {
    const confirm = fakeConfirm();
    const prefs = fakePrefs();
    const looser = await run(["mode", "on"], { confirm, prefs, config: evaluate("ask-each-task") });
    expect(looser.exitCode()).toBe(0);
    expect(confirm.asked).toHaveLength(1);
    expect(prefs.state.writes).toEqual([{ root: "/proj", mode: "on" }]);

    const tighter = await run(["mode", "off"], {
      confirm,
      prefs,
      config: evaluate("ask-each-task"),
    });
    expect(tighter.exitCode()).toBe(0);
    expect(confirm.asked).toHaveLength(1);
  });

  test("a declined loosening changes nothing", async () => {
    const prefs = fakePrefs();
    const cap = await run(["mode", "on", "--all-projects"], {
      confirm: fakeConfirm({ answer: "denied", via: "dialog" }),
      prefs,
      config: evaluate("ask-each-task"),
    });
    expect(cap.exitCode()).toBe(EXIT_APPROVAL_REQUIRED);
    expect(prefs.state.writes).toHaveLength(0);
  });

  test("a personal mode cannot turn on a project that is off", async () => {
    const prefs = fakePrefs();
    const cap = await run(["mode", "on"], { prefs, config: evaluate("off") });
    expect(cap.errors[0]?.code).toBe("computer_disabled");
    expect(prefs.state.writes).toHaveLength(0);
  });
});

describe("computer sign-in", () => {
  /** A project that allows agent sign-in; the person's choice comes from `prefs`. */
  const allowing =
    (projectSignIn = true, mode: ComputerMode = "ask-each-task") =>
    (prefs?: ComputerPreferences) => {
      const personal = prefs?.sign_in_projects?.["/proj"] ?? prefs?.sign_in;
      return cfg(mode, {
        project_sign_in: projectSignIn && mode !== "off",
        sign_in: projectSignIn && mode !== "off" && personal === true,
        person_sign_in: personal === true,
        sign_in_source:
          prefs?.sign_in_projects?.["/proj"] !== undefined
            ? "user-project"
            : prefs?.sign_in !== undefined
              ? "user-default"
              : "default",
      });
    };

  test("is off by default and status says so", async () => {
    const status = await run(["status"], { config: allowing() });
    expect(status.text.join("\n")).toContain("sign-in:   off: you sign in yourself (the default;");
    const shown = await run(["sign-in", "--json"], { config: allowing() });
    expect(shown.data[0]).toMatchObject({ sign_in: false, project_sign_in: true });
    const notAllowed = await run(["status"], { config: allowing(false) });
    expect(notAllowed.text.join("\n")).toContain(
      "sign-in:   off (this project does not allow agents to sign in for you)",
    );
  });

  test("turning it on asks the person first; turning it off does not", async () => {
    const confirm = fakeConfirm();
    const prefs = fakePrefs();
    const on = await run(["sign-in", "on", "--json"], {
      confirm,
      prefs,
      config: allowing(),
    });
    expect(on.exitCode()).toBe(0);
    expect(confirm.asked).toHaveLength(1);
    expect(confirm.asked[0]?.title).toBe("Let agents sign in for you?");
    expect(prefs.state.signInWrites).toEqual([{ root: "/proj", on: true }]);
    expect(on.data[0]).toMatchObject({ sign_in: true, scope: "project" });

    prefs.state.prefs = { sign_in_projects: { "/proj": true } };
    const off = await run(["sign-in", "off"], { confirm, prefs, config: allowing() });
    expect(off.exitCode()).toBe(0);
    expect(confirm.asked).toHaveLength(1);
    expect(prefs.state.signInWrites.at(-1)).toEqual({ root: "/proj", on: false });
  });

  test("clearing a project's off under an all-projects on asks first", async () => {
    const confirm = fakeConfirm({ answer: "denied", via: "dialog" });
    const prefs = fakePrefs({ sign_in: true, sign_in_projects: { "/proj": false } });
    const cap = await run(["sign-in", "--clear"], { confirm, prefs, config: allowing() });
    expect(confirm.asked).toHaveLength(1);
    expect(cap.exitCode()).toBe(EXIT_APPROVAL_REQUIRED);
    expect(prefs.state.signInWrites).toHaveLength(0);
  });

  test("a declined pop-up changes nothing", async () => {
    const prefs = fakePrefs();
    const cap = await run(["sign-in", "on", "--all-projects"], {
      confirm: fakeConfirm({ answer: "denied", via: "dialog" }),
      prefs,
      config: allowing(),
    });
    expect(cap.exitCode()).toBe(EXIT_APPROVAL_REQUIRED);
    expect(prefs.state.signInWrites).toHaveLength(0);
  });

  test("a personal choice cannot turn it on where the project does not allow it", async () => {
    const prefs = fakePrefs();
    const cap = await run(["sign-in", "on"], { prefs, config: allowing(false) });
    expect(cap.errors[0]?.code).toBe("sign_in_not_allowed");
    expect(prefs.state.signInWrites).toHaveLength(0);
  });

  test("a saved on is reported, and can be turned off, while desktop control is off", async () => {
    const prefs = fakePrefs({ sign_in_projects: { "/proj": true } });
    const config = (p?: ComputerPreferences) => ({
      ...allowing()(p ?? prefs.state.prefs),
      enabled: false,
      mode: "off" as const,
      sign_in: false,
    });
    const status = await run(["status"], { prefs, config });
    expect(status.text.join("\n")).toContain("sign-in:   off while your desktop control is off");
    const off = await run(["sign-in", "off"], { prefs, config, confirm: fakeConfirm() });
    expect(off.exitCode()).toBe(0);
    expect(prefs.state.signInWrites).toEqual([{ root: "/proj", on: false }]);
  });

  test("rejects anything but on or off", async () => {
    const cap = await run(["sign-in", "yes"], { config: allowing() });
    expect(cap.errors[0]?.code).toBe("computer_usage");
  });
});

describe("computer browser-attach", () => {
  /** A project that allows browser attach; the person's choice comes from `prefs`. */
  const allowing =
    (projectAttach = true, mode: ComputerMode = "on") =>
    (prefs?: ComputerPreferences) => {
      const personal = prefs?.browser_attach_projects?.["/proj"] ?? prefs?.browser_attach;
      return cfg(mode, {
        project_browser_attach: projectAttach && mode !== "off",
        browser_attach: projectAttach && mode !== "off" && personal === true,
        person_browser_attach: personal === true,
        browser_attach_source:
          prefs?.browser_attach_projects?.["/proj"] !== undefined
            ? "user-project"
            : prefs?.browser_attach !== undefined
              ? "user-default"
              : "default",
      });
    };

  /** A fake driver that can attach to the person's browser and remembers its daemon's grant. */
  function attachDriver(granted = false) {
    const base = fakeDriver();
    const state = { granted, starts: [] as (boolean | undefined)[], stops: 0 };
    let running = true;
    const driver = {
      ...base,
      supportsBrowserAttach: true,
      attachesPersonBrowser: (tool: string) => tool === "browser_prepare",
      daemonStatus: (): DaemonStatus => ({
        running,
        detail: running ? "running" : "stopped",
        ...(running ? { pid: 42, browserAttach: state.granted } : {}),
      }),
      startDaemon: async (_host: HostInfo, options?: { browserAttach?: boolean }) => {
        state.starts.push(options?.browserAttach);
        state.granted = options?.browserAttach === true;
        running = true;
        return { running, detail: "running", pid: 43, browserAttach: state.granted };
      },
      stopDaemon: () => {
        state.stops++;
        running = false;
        return { running, detail: "stopped" };
      },
    };
    return { driver, state, calls: base.calls };
  }

  test("is off by default, and status says so", async () => {
    const status = await run(["status"], { config: allowing() });
    expect(status.text.join("\n")).toContain("browser:   off (the default;");
    const notAllowed = await run(["status"], { config: allowing(false) });
    expect(notAllowed.text.join("\n")).toContain(
      "browser:   off (this project does not allow agents to attach to your browser)",
    );
  });

  test("an attach call is refused while it is off, and nothing is sent", async () => {
    const { driver, calls } = attachDriver();
    const cap = await run(["call", "browser_prepare", '{"strategy":{"kind":"existing_profile"}}'], {
      driver,
      config: allowing(),
    });
    expect(cap.errors[0]?.code).toBe("browser_attach_off");
    expect(cap.exitCode()).toBe(EXIT_APPROVAL_REQUIRED);
    expect(calls).toHaveLength(0);
  });

  test("with it on, an attach call restarts a daemon that lacks the grant", async () => {
    const { driver, state, calls } = attachDriver(false);
    const prefs = fakePrefs({ browser_attach_projects: { "/proj": true } });
    const config = () => allowing()(prefs.state.prefs);
    const cap = await run(["call", "browser_prepare", '{"strategy":{"kind":"existing_profile"}}'], {
      driver,
      prefs,
      config,
      personIdleMs: () => 60_000,
    });
    expect(cap.exitCode()).toBe(0);
    expect(state.stops).toBe(1);
    expect(state.starts).toEqual([true]);
    expect(calls.map((c) => c.tool)).toEqual(["browser_prepare"]);
    // An ordinary call leaves a granted daemon alone.
    await run(["call", "click", "{}"], { driver, prefs, config });
    expect(state.stops).toBe(1);
  });

  test("turning it on asks first and restarts the daemon with the grant", async () => {
    const { driver, state } = attachDriver(false);
    const confirm = fakeConfirm();
    const prefs = fakePrefs();
    const cap = await run(["browser-attach", "on"], {
      driver,
      confirm,
      prefs,
      config: allowing(),
    });
    expect(cap.exitCode()).toBe(0);
    expect(confirm.asked[0]?.title).toBe("Let agents work in your browser?");
    expect(prefs.state.attachWrites).toEqual([{ root: "/proj", on: true }]);
    expect(state.starts).toEqual([true]);
    expect(cap.text.join("\n")).toContain("restarted the daemon with browser attach");
  });

  test("turning it off restarts a granted daemon without the grant, and does not ask", async () => {
    const { driver, state } = attachDriver(true);
    const confirm = fakeConfirm();
    const prefs = fakePrefs({ browser_attach_projects: { "/proj": true } });
    const cap = await run(["browser-attach", "off"], {
      driver,
      confirm,
      prefs,
      config: allowing(),
    });
    expect(cap.exitCode()).toBe(0);
    expect(confirm.asked).toHaveLength(0);
    expect(state.starts).toEqual([false]);
  });

  test("a daemon is not restarted while another agent holds the desktop", async () => {
    const { driver, state } = attachDriver(true);
    const cap = await run(["browser-attach", "off"], {
      driver,
      prefs: fakePrefs({ browser_attach_projects: { "/proj": true } }),
      config: allowing(),
      lease: fakeLease(lease()),
    });
    expect(state.stops).toBe(0);
    expect(cap.text.join("\n")).toContain(
      "was not restarted because the desktop is held by agent-Other",
    );
  });

  test("a declined pop-up changes nothing, and a project that does not allow it refuses", async () => {
    const prefs = fakePrefs();
    const declined = await run(["browser-attach", "on"], {
      confirm: fakeConfirm({ answer: "denied", via: "dialog" }),
      prefs,
      config: allowing(),
    });
    expect(declined.exitCode()).toBe(EXIT_APPROVAL_REQUIRED);
    const refused = await run(["browser-attach", "on"], { prefs, config: allowing(false) });
    expect(refused.errors[0]?.code).toBe("browser_attach_not_allowed");
    expect(prefs.state.attachWrites).toHaveLength(0);
  });
});

describe("computer with two drivers", () => {
  const pair = () => ({
    a: fakeDriver({ id: "alpha" }),
    b: fakeDriver({ id: "beta", hasDaemon: false, running: false }),
  });

  test("call uses the first driver by default, computer.driver, or --driver", async () => {
    const { a, b } = pair();
    await run(["call", "click", "{}"], { drivers: [a, b] });
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);

    await run(["call", "click", "{}"], {
      drivers: [a, b],
      config: () => cfg("on", { driver: "beta" }),
    });
    expect(b.calls).toHaveLength(1);

    const cap = await run(["call", "--driver", "alpha", "click", "{}"], {
      drivers: [a, b],
      config: () => cfg("on", { driver: "beta" }),
    });
    expect(cap.exitCode()).toBe(0);
    expect(a.calls).toHaveLength(2);
  });

  test("a daemonless driver is called without starting anything", async () => {
    const { a, b } = pair();
    await run(["call", "--driver", "beta", "snapshot", "{}"], { drivers: [a, b] });
    expect(b.calls[0]?.args.session).toBe("agent-Me");
    expect(b.started).toBe(0);
  });

  test("an unknown driver id is a usage error naming the available ones", async () => {
    const { a, b } = pair();
    const cap = await run(["tools", "--driver", "gamma"], { drivers: [a, b] });
    expect(cap.exitCode()).toBe(1);
    expect(cap.errors[0]?.message).toContain(
      'Unknown desktop driver "gamma". Available: alpha, beta.',
    );
  });

  test("status lists both drivers and marks the default", async () => {
    const { a, b } = pair();
    const cap = await run(["status"], {
      drivers: [a, b],
      config: () => cfg("on", { driver: "beta" }),
    });
    const out = cap.text.join("\n");
    expect(out).toContain("alpha 1.2.3 (pinned): fake driver");
    expect(out).toContain("beta 1.2.3 (pinned, default): fake driver");
    expect(out).toContain("not needed (runs per call)");
  });

  test("install previews and installs every driver unless --driver narrows it", async () => {
    const a = fakeDriver({ id: "alpha", installed: false });
    const b = fakeDriver({ id: "beta", installed: false, hasDaemon: false });
    const preview = await run(["install"], { drivers: [a, b] });
    expect(preview.text.join("\n").match(/Would install/g)).toHaveLength(2);
    await run(["install", "--yes"], { drivers: [a, b] });
    expect([a.installs, b.installs]).toEqual([1, 1]);
    await run(["install", "--driver", "beta", "--yes"], { drivers: [a, b] });
    expect([a.installs, b.installs]).toEqual([1, 2]);
  });

  test("up starts only daemon drivers; doctor reports per driver", async () => {
    const a = fakeDriver({ id: "alpha", running: false });
    const b = fakeDriver({ id: "beta", hasDaemon: false });
    const up = await run(["up"], { drivers: [a, b] });
    expect(a.started).toBe(1);
    expect(up.text.join("\n")).toContain("beta: no daemon needed.");
    const doctor = await run(["doctor", "--json"], { drivers: [a, b] });
    expect(doctor.data[0]).toMatchObject({
      ok: true,
      drivers: [
        { driver: "alpha", ok: true },
        { driver: "beta", ok: true },
      ],
    });
  });
});

describe("computer background processes", () => {
  /** A daemonless driver that left command hosts running. */
  function withHosts(pids: number[]) {
    const state = { pids: [...pids], stops: 0 };
    const driver = {
      ...fakeDriver({ id: "beta", hasDaemon: false }),
      backgroundProcesses: () => state.pids.map((pid) => ({ pid, kind: "command host" })),
      stopBackgroundProcesses: () => {
        state.stops++;
        state.pids = [];
        return [];
      },
    } as FakeDriver;
    return { driver, state };
  }

  test("status lists them with the command that stops them", async () => {
    const { driver } = withHosts([501, 502]);
    const cap = await run(["status"], { drivers: [driver] });
    expect(cap.text.join("\n")).toContain(
      "helpers:   2 command hosts running (pid 501, 502); `acme computer down` stops them",
    );
    const json = await run(["status", "--json"], { drivers: [driver] });
    expect(json.data[0]).toMatchObject({
      drivers: [{ id: "beta", background_processes: [{ pid: 501 }, { pid: 502 }] }],
    });
  });

  test("down stops them while the desktop is free or yours", async () => {
    const { driver, state } = withHosts([501, 502]);
    const cap = await run(["down"], { drivers: [driver] });
    expect(cap.text.join("\n").trim()).toBe("beta: stopped 2 command hosts.");
    expect(state.stops).toBe(1);
    expect(cap.exitCode()).toBe(0);
    const again = await run(["down"], { drivers: [driver] });
    expect(again.text.join("\n").trim()).toBe("beta: no daemon.");
  });

  test("down leaves them running while another agent holds the desktop, exit 3", async () => {
    const { driver, state } = withHosts([501]);
    const cap = await run(["down"], { drivers: [driver], lease: fakeLease(lease()) });
    expect(state.stops).toBe(0);
    expect(cap.text.join("\n")).toContain("beta: left 1 command host running (pid 501)");
    expect(cap.text.join("\n")).toContain("agent-Other");
    expect(cap.exitCode()).toBe(EXIT_LEASE_HELD);
  });

  test("a call holds the lease for that call's own timeout", async () => {
    const driver = {
      ...fakeDriver(),
      callTimeoutMs: 30_000,
      callTimeoutFor: (_tool: string, args: Record<string, unknown>) =>
        30_000 + Number(args.ms ?? 0),
    } as FakeDriver;
    driver.calls = [];
    const leaseApi = fakeLease();
    await run(["call", "wait", '{"ms": 200000}'], {
      driver,
      lease: leaseApi,
      config: () => cfg("on", { idle_seconds: 60 }),
    });
    expect(leaseApi.acquired[0]?.idleMs).toBe(245_000);
  });
});

describe("redactInlineScreenshots for generic keys", () => {
  test("also redacts long base64 under a generic key", () => {
    const b64 = "QUJD".repeat(1000);
    const out = redactInlineScreenshots(`{"data":{"data":"${b64}","format":"png"}}`);
    expect(out).not.toContain(b64);
    expect(out).toContain('"format":"png"');
    expect(redactInlineScreenshots('{"data":"short"}')).toBe('{"data":"short"}');
  });
});

describe("computer browser guard (ADR 0250)", () => {
  const attachOn = () => cfg("on", { browser_attach: true, project_browser_attach: true });
  const owner = { id: "me-id", label: "agent-Me" };

  test("a refused browser call sends nothing, takes no lease, and exits 4", async () => {
    const { driver, calls } = browserDriver();
    const leaseApi = fakeLease();
    const guard = fakeGuard({
      refuse: () => ({ ok: false, code: "browser_sensitive_field", message: "no", hint: "ask" }),
    });
    const cap = await run(["call", "type_text", '{"target_id":"t-1","text":"x"}'], {
      driver,
      lease: leaseApi,
      browserGuard: () => guard,
    });
    expect(cap.errors[0]?.code).toBe("browser_sensitive_field");
    expect(cap.exitCode()).toBe(EXIT_APPROVAL_REQUIRED);
    expect(calls).toHaveLength(0);
    expect(leaseApi.acquired).toHaveLength(0);
    expect(guard.log.checks[0]?.owner).toEqual(owner);
    expect(guard.log.checks[0]?.call.session).toBe("agent-Me");
  });

  test("a passing direct call is observed through the driver's observation", async () => {
    const { driver, calls } = browserDriver();
    const guard = fakeGuard();
    const cap = await run(["call", "type_text", '{"target_id":"t-1","text":"x"}'], {
      driver,
      browserGuard: () => guard,
    });
    expect(cap.exitCode()).toBe(0);
    expect(calls).toHaveLength(1);
    expect(guard.log.observed).toEqual([
      {
        call: expect.objectContaining({ kind: "type", tool: "type_text" }),
        observation: { delivered: true },
        personWindow: false,
      },
    ]);
  });

  test("nested steps are each observed with whether the call went through", async () => {
    const { driver } = browserDriver();
    const guard = fakeGuard();
    await run(["call", "run_steps", '{"steps":[]}'], { driver, browserGuard: () => guard });
    expect(guard.log.observed.map((o) => [o.call.tool, o.observation])).toEqual([
      ["click", { delivered: true }],
      ["type_text", { delivered: true }],
    ]);
  });

  test("a call that touches no browser never reaches the guard", async () => {
    const { driver } = browserDriver();
    const guard = fakeGuard();
    await run(["call", "list_apps", "{}"], { driver, browserGuard: () => guard });
    expect(guard.log.checks).toHaveLength(0);
    expect(guard.log.observed).toHaveLength(0);
  });

  test("--person-window reaches check and observe, and an attach is logged", async () => {
    const { driver } = browserDriver();
    const guard = fakeGuard();
    const grants = fakeGrants();
    const cap = await run(
      ["call", "browser_prepare", '{"pid":7,"window_id":8}', "--person-window"],
      { driver, browserGuard: () => guard, grants, config: attachOn, personIdleMs: () => 60_000 },
    );
    expect(cap.exitCode()).toBe(0);
    expect(guard.log.checks[0]?.personWindow).toBe(true);
    expect(guard.log.observed[0]?.personWindow).toBe(true);
    expect(grants.logged).toContainEqual(
      expect.objectContaining({
        event: "browser-attach-changed",
        owner_id: "me-id",
        detail: "person window used: pid 7 window 8 (browser_prepare)",
      }),
    );
  });

  test("a guard that fails to record does not fail the call", async () => {
    const { driver, calls } = browserDriver();
    const cap = await run(["call", "type_text", '{"target_id":"t-1"}'], {
      driver,
      browserGuard: () => fakeGuard({ observeThrows: true }),
    });
    expect(cap.exitCode()).toBe(0);
    expect(calls).toHaveLength(1);
    expect(cap.stderr.join("")).toContain("could not record this call's result: disk full");
  });
});

describe("computer browser open", () => {
  const attachOn = () => cfg("on", { browser_attach: true, project_browser_attach: true });

  test("opens, records, attaches, binds and prints the ids as JSON", async () => {
    const { driver, order, opened, calls } = browserDriver();
    const guard = fakeGuard();
    const leaseApi = fakeLease();
    const cap = await run(
      ["browser", "open", "https://example.com/", "--browser-pid", "700", "--json"],
      {
        driver,
        lease: leaseApi,
        browserGuard: () => guard,
        config: attachOn,
        personIdleMs: () => 60_000,
      },
    );
    expect(cap.errors).toEqual([]);
    expect(cap.exitCode()).toBe(0);
    expect(opened).toEqual([{ url: "https://example.com/", pid: 700 }]);
    expect(order).toEqual(["open", "call:browser_prepare", "call:get_browser_state"]);
    expect(guard.log.ops).toEqual([
      "record",
      "observe:browser_prepare",
      "observe:get_browser_state",
    ]);
    expect(guard.log.recorded).toEqual([{ pid: 700, window_id: 55, session: "agent-Me" }]);
    expect(calls[0]?.args).toEqual({
      pid: 700,
      window_id: 55,
      session: "agent-Me",
      strategy: { kind: "existing_profile" },
    });
    expect(calls[1]?.args).toEqual({ pid: 700, window_id: 55, session: "agent-Me" });
    expect(cap.data[0]).toEqual({
      pid: 700,
      window_id: 55,
      session: "agent-Me",
      target_id: "t-9",
      tab_id: "tab-2",
      url: "https://example.com/",
      placement_skipped: "no installed driver can move windows",
    });
    // Taken for the open, then refreshed to the idle period.
    expect(leaseApi.acquired.length).toBe(2);
  });

  test("text output names the ids and the close command", async () => {
    const { driver } = browserDriver({
      bindStdout: JSON.stringify({ target_id: "t-1", tabs: [{ tab_id: "a", url: "about:blank" }] }),
    });
    const cap = await run(["browser", "open"], {
      driver,
      browserGuard: () => fakeGuard(),
      config: attachOn,
      personIdleMs: () => 60_000,
    });
    const out = cap.text.join("\n");
    expect(out).toContain("window 55 (pid 700)");
    expect(out).toContain("target t-1, tab a at about:blank");
    expect(out).toContain("acme computer browser close");
  });

  test("is refused while browser attach is off, and nothing opens", async () => {
    const { driver, order } = browserDriver();
    const leaseApi = fakeLease();
    const cap = await run(["browser", "open"], {
      driver,
      lease: leaseApi,
      browserGuard: () => fakeGuard(),
    });
    expect(cap.errors[0]?.code).toBe("browser_attach_off");
    expect(cap.exitCode()).toBe(EXIT_APPROVAL_REQUIRED);
    expect(order).toEqual([]);
    expect(leaseApi.acquired).toHaveLength(0);
  });

  test("a driver that cannot open a window is refused", async () => {
    const { driver } = browserDriver({ openBrowserWindow: false });
    const cap = await run(["browser", "open"], { driver, config: attachOn });
    expect(cap.errors[0]?.code).toBe("browser_open_unsupported");
    expect(cap.exitCode()).toBe(1);
  });

  test("a failed attach prints the driver's output, exits 1, and closes the window again", async () => {
    const { driver, order } = browserDriver({ prepareExit: 2 });
    const guard = fakeGuard();
    const cap = await run(["browser", "open", "--json"], {
      driver,
      browserGuard: () => guard,
      config: attachOn,
      personIdleMs: () => 60_000,
    });
    expect(cap.exitCode()).toBe(1);
    expect(cap.text.join("")).toContain("attach failed");
    expect(cap.data).toEqual([]);
    expect(order).toEqual(["open", "call:browser_prepare", "call:end_session", "close:55"]);
    expect(guard.log.cleared).toBe(1);
    expect(cap.stderr.join("")).toContain("was closed again");
  });

  test("a refused attach, which the driver answers with exit 0, is a failure too", async () => {
    const { driver, order } = browserDriver({
      prepareStdout: JSON.stringify({ status: "refused", refusal: { code: "nope" } }),
    });
    const cap = await run(["browser", "open", "--json"], {
      driver,
      browserGuard: () => fakeGuard(),
      config: attachOn,
      personIdleMs: () => 60_000,
    });
    expect(cap.exitCode()).toBe(1);
    expect(cap.text.join("")).toContain("nope");
    expect(order).not.toContain("call:get_browser_state");
  });

  test("a bind without a target counts as a failure", async () => {
    const { driver } = browserDriver({ bindStdout: "not json" });
    const cap = await run(["browser", "open"], {
      driver,
      browserGuard: () => fakeGuard(),
      config: attachOn,
      personIdleMs: () => 60_000,
    });
    expect(cap.exitCode()).toBe(1);
    expect(cap.text.join("")).toContain("not json");
  });

  test("waits for the person to go quiet before opening", async () => {
    const { driver, order } = browserDriver();
    const cap = await run(["browser", "open"], {
      driver,
      browserGuard: () => fakeGuard(),
      config: attachOn,
      personIdleMs: () => 0,
      sleep: async () => {},
      now: (() => {
        let t = NOW;
        return () => (t += 1000);
      })(),
    });
    expect(cap.errors[0]?.code).toBe("person_active");
    expect(cap.exitCode()).toBe(EXIT_PERSON_ACTIVE);
    expect(order).toEqual([]);
  });
});

describe("computer browser cleanup", () => {
  const work = {
    sessions: ["agent-Me"],
    windows: [
      { pid: 700, window_id: 55 },
      { pid: 700, window_id: 56 },
    ],
  };
  const stuck = (w: WindowRef) => w.window_id !== 56;

  test("browser close ends sessions, closes windows, clears, and names a window left open", async () => {
    const { driver, order } = browserDriver({ closeable: stuck });
    const guard = fakeGuard({ work });
    const cap = await run(["browser", "close", "--json"], { driver, browserGuard: () => guard });
    expect(order).toEqual(["call:end_session", "close:55", "close:56"]);
    expect(guard.log.cleared).toBe(1);
    expect(cap.data[0]).toEqual({
      sessions: ["agent-Me"],
      closed: [{ pid: 700, window_id: 55 }],
      left_open: [{ pid: 700, window_id: 56 }],
    });
    const text = await run(["browser", "close"], {
      driver,
      browserGuard: () => fakeGuard({ work }),
    });
    const out = text.text.join("\n");
    expect(out).toContain("Ended browser session agent-Me and closed window 55 (pid 700).");
    expect(out).toContain("Could not close browser window 56 (pid 700); tell the person");
  });

  test("browser close with nothing recorded says so and writes nothing", async () => {
    const { driver } = browserDriver();
    const guard = fakeGuard();
    const cap = await run(["browser", "close"], { driver, browserGuard: () => guard });
    expect(cap.text.join("")).toContain("No browser work of yours to close.");
    expect(guard.log.cleared).toBe(0);
  });

  test("done and lease release clean up too, and say so", async () => {
    for (const argv of [["done"], ["lease", "release"]]) {
      const { driver, order } = browserDriver({ closeable: stuck });
      const guard = fakeGuard({ work });
      const cap = await run(argv, { driver, browserGuard: () => guard });
      expect(order).toEqual(["call:end_session", "close:55", "close:56"]);
      expect(guard.log.cleared).toBe(1);
      const out = cap.text.join("\n");
      expect(out).toContain("closed window 55 (pid 700)");
      expect(out).toContain("Could not close browser window 56");
    }
  });

  test("done adds nothing when there is no browser work, or no browser driver", async () => {
    const plain = await run(["done"], { browserGuard: () => fakeGuard({ work }) });
    expect(plain.text.join("")).toBe("You did not hold the desktop.\n");
    const { driver } = browserDriver();
    const none = await run(["done"], { driver, browserGuard: () => fakeGuard() });
    expect(none.text.join("")).toBe("You did not hold the desktop.\n");
  });
});

describe("computer daemon version (ADR 0250)", () => {
  function staleDriver() {
    const driver = fakeDriver();
    const state = { version: "1.0.0", running: true, stops: 0, starts: 0 };
    driver.daemonStatus = () => ({
      running: state.running,
      detail: "x",
      ...(state.running ? { pid: 42, version: state.version } : {}),
    });
    driver.stopDaemon = () => {
      state.stops++;
      state.running = false;
      return { running: false, detail: "stopped" };
    };
    driver.startDaemon = async () => {
      state.starts++;
      state.running = true;
      state.version = driver.version;
      return { running: true, detail: "running", pid: 43, version: driver.version };
    };
    return { driver, state };
  }

  test("call restarts a daemon running another version", async () => {
    const { driver, state } = staleDriver();
    const cap = await run(["call", "click", "{}"], { driver });
    expect(cap.exitCode()).toBe(0);
    expect(state).toMatchObject({ stops: 1, starts: 1 });
    await run(["call", "click", "{}"], { driver });
    expect(state).toMatchObject({ stops: 1, starts: 1 });
  });

  test("up reports the restart and the old version", async () => {
    const { driver, state } = staleDriver();
    const cap = await run(["up"], { driver });
    expect(state.stops).toBe(1);
    expect(cap.text.join("")).toContain("restarted the daemon on the pinned 1.2.3 (was 1.0.0)");
  });

  test("status shows a daemon version that differs from the pinned one", async () => {
    const { driver } = staleDriver();
    const cap = await run(["status"], { driver });
    expect(cap.text.join("")).toContain("version 1.0.0 (not the pinned 1.2.3");
  });
});

describe("computer status browser windows", () => {
  test("lists open agent browser windows in text and JSON", async () => {
    const list: GuardWindow[] = [
      {
        owner_id: "a",
        owner_label: "agent-A",
        pid: 1,
        window_id: 11,
        session: "agent-A",
        opened_at: new Date(NOW).toISOString(),
      },
      {
        owner_id: "b",
        owner_label: "agent-B",
        pid: 1,
        window_id: 12,
        session: "agent-B",
        opened_at: new Date(NOW).toISOString(),
      },
    ];
    const cap = await run(["status"], { browserGuard: () => fakeGuard({ list }) });
    expect(cap.text.join("")).toContain(
      "windows:   2 agent browser windows open: agent-A (window 11), agent-B (window 12)",
    );
    const json = await run(["status", "--json"], { browserGuard: () => fakeGuard({ list }) });
    expect((json.data[0] as { browser_windows: unknown }).browser_windows).toEqual(list);
    const none = await run(["status"]);
    expect(none.text.join("")).not.toContain("windows:");
  });
});

/** Fully resolved deps for calling placeWindow and refreshDisplays directly. */
function directDeps(over: Partial<ComputerDeps> = {}): ComputerDeps & { stderr: string[] } {
  const cap = capture();
  const prefs = fakePrefs();
  return {
    emit: cap.emit,
    binName: "acme",
    host: () => WSL_HOST,
    drivers: [fakeDriver()],
    lease: fakeLease(),
    owner: () => ({ id: "me-id", label: "agent-Me" }),
    config: () => cfg("on"),
    grants: fakeGrants(),
    confirm: fakeConfirm(),
    prefs,
    projectRoot: () => "/proj",
    leaseDir: (dir) => `${dir}/computer`,
    defaultIdleMs: 120_000,
    writeStderr: (s) => cap.stderr.push(s),
    personIdleMs: () => null,
    sleep: async () => {},
    now: () => NOW,
    browserGuard: () => fakeGuard(),
    displays: fakeDisplays(),
    stderr: cap.stderr,
    ...over,
  };
}

const HOST = WSL_HOST as HostInfo & { desktopStateDir: string };
const WINDOW: WindowRef = { pid: 700, window_id: 55 };

describe("computer displays", () => {
  test("reads the displays now, saves them, and numbers them left to right", async () => {
    const displays = fakeDisplays();
    const cap = await run(["displays"], { displays });
    expect(cap.exitCode()).toBe(0);
    expect(displays.log.probes).toBe(1);
    expect(displays.log.writes).toEqual([
      { dir: `${WSL_HOST.desktopStateDir}/computer`, snapshot: TWO_DISPLAYS },
    ]);
    const out = cap.text.join("\n");
    expect(out).toContain("1. DISPLAY1: 1920 by 1080, primary\n");
    expect(out).toContain("2. DISPLAY2: 2560 by 1440 (agent windows go here)");
    expect(out).toContain("from windows.");
  });

  test("--cached prints the last reading without probing, and --json emits it", async () => {
    const displays = fakeDisplays({ cache: TWO_DISPLAYS });
    const cap = await run(["displays", "--cached", "--json"], { displays });
    expect(displays.log.probes).toBe(0);
    expect(cap.data).toEqual([TWO_DISPLAYS]);
    const none = await run(["displays", "--cached"], { displays: fakeDisplays() });
    expect(none.errors[0]?.code).toBe("displays_not_read");
    expect(none.errors[0]?.message).toContain("acme computer displays");
    expect(none.exitCode()).toBe(1);
  });

  test("no displays prints the error and exits 1", async () => {
    const empty: DisplaySnapshot = {
      probed_at: TWO_DISPLAYS.probed_at,
      source: "none",
      displays: [],
      error: "powershell.exe exited 1",
    };
    const cap = await run(["displays"], { displays: fakeDisplays({ probe: empty }) });
    expect(cap.errors[0]?.message).toContain("powershell.exe exited 1");
    expect(cap.exitCode()).toBe(1);
    const json = await run(["displays", "--json"], { displays: fakeDisplays({ probe: empty }) });
    expect(json.data).toEqual([empty]);
    expect(json.exitCode()).toBe(1);
  });

  test("refreshDisplays turns a probe failure into an empty reading", () => {
    const deps = directDeps({ displays: fakeDisplays({ probeThrows: true }) });
    const snapshot = refreshDisplays(deps, HOST);
    expect(snapshot.displays).toEqual([]);
    expect(snapshot.error).toBe("probe exploded");
  });
});

describe("computer window", () => {
  /** Effective settings that apply the person's saved agent-window choice. */
  const placing = (prefsState: { prefs: ComputerPreferences }) => (prefs?: ComputerPreferences) => {
    const chosen = (prefs ?? prefsState.prefs).agent_window;
    return cfg("on", {
      agent_window: {
        display: "secondary",
        corner: "bottom-right",
        margin: 0,
        move_apps: true,
        ...chosen,
      },
      agent_window_source: chosen ? "user" : "default",
    });
  };

  test("shows the effective placement and where it came from", async () => {
    const cap = await run(["window"]);
    expect(cap.text.join("")).toBe(
      "Agent windows go: the smallest size the program allows, bottom-right corner of the secondary display; launched programs move there too (the default).\n",
    );
    const json = await run(["window", "--json"]);
    expect(json.data[0]).toEqual({
      agent_window: { display: "secondary", corner: "bottom-right", margin: 0, move_apps: true },
      agent_window_source: "default",
    });
  });

  test("saves each option as the person's own choice, without asking", async () => {
    const prefs = fakePrefs();
    const confirm = fakeConfirm();
    const cap = await run(
      [
        "window",
        "--display",
        "2",
        "--corner",
        "top-left",
        "--size",
        "800x600",
        "--margin",
        "10",
        "--apps",
        "off",
      ],
      { prefs, confirm, config: placing(prefs.state) },
    );
    expect(cap.errors).toEqual([]);
    expect(confirm.asked).toEqual([]);
    expect(prefs.state.windowWrites).toEqual([
      { display: "2", corner: "top-left", width: 800, height: 600, margin: 10, move_apps: false },
    ]);
    expect(cap.text.join("")).toBe(
      "Agent windows now go: 800 by 600, top-left corner of display 2, 10px from the edges; launched programs stay where they open (your setting).\n",
    );
  });

  test("smallest removes the size, and --clear removes the whole choice", async () => {
    const prefs = fakePrefs({ agent_window: { width: 800, height: 600, corner: "top-left" } });
    const cap = await run(["window", "--size", "smallest"], {
      prefs,
      config: placing(prefs.state),
    });
    expect(prefs.state.windowWrites).toEqual([{ width: null, height: null }]);
    expect(cap.text.join("")).toContain("the smallest size the program allows, top-left corner");
    const cleared = await run(["window", "--clear", "--json"], {
      prefs,
      config: placing(prefs.state),
    });
    expect(prefs.state.windowWrites[1]).toBeNull();
    expect(cleared.data[0]).toMatchObject({ agent_window_source: "default", changed: true });
  });

  test("rejects a bad corner, size, margin or apps value, and settings with --clear", async () => {
    for (const argv of [
      ["--corner", "middle"],
      ["--size", "800"],
      ["--size", "0x600"],
      ["--size", "axb"],
      ["--size", "20001x10"],
      ["--margin", "-1"],
      ["--margin", "2.5"],
      ["--apps", "maybe"],
      ["--display", " "],
      ["--corner", "top-left", "--clear"],
    ]) {
      const prefs = fakePrefs();
      const cap = await run(["window", ...argv], { prefs });
      expect(cap.errors[0]?.code).toBe("computer_usage");
      expect(cap.exitCode()).toBe(1);
      expect(prefs.state.windowWrites).toEqual([]);
    }
  });
});

describe("placeWindow", () => {
  test("moves onto the target display at the smallest size, then into the corner the clamped size fits", () => {
    const { driver, frames } = moverDriver();
    const displays = fakeDisplays({ cache: TWO_DISPLAYS });
    const deps = directDeps({ drivers: [driver], displays });
    const placed = placeWindow(deps, HOST, WINDOW, { resize: true });
    expect(frames).toEqual([
      { window: WINDOW, frame: { x: 1920, y: 0, width: 100, height: 100 } },
      { window: WINDOW, frame: { x: 1920 + 2560 - 400, y: 1400 - 300 } },
    ]);
    // The program's own minimum (400 by 300), not the request, decides the corner.
    expect(displays.log.corners).toEqual([
      { display: "DISPLAY2", corner: "bottom-right", size: { width: 400, height: 300 }, margin: 0 },
    ]);
    expect(placed).toEqual({
      display: "DISPLAY2",
      frame: { x: 4080, y: 1100, width: 400, height: 300 },
    });
    expect(displays.log.probes).toBe(0);
  });

  test("a requested size, display, corner and margin are used, and fresh reads the displays now", () => {
    const { driver, frames } = moverDriver();
    const displays = fakeDisplays({ cache: TWO_DISPLAYS });
    const deps = directDeps({
      drivers: [driver],
      displays,
      config: () =>
        cfg("on", {
          agent_window: {
            display: "primary",
            corner: "top-right",
            width: 800,
            height: 600,
            margin: 10,
            move_apps: true,
          },
        }),
    });
    const placed = placeWindow(deps, HOST, WINDOW, { resize: true, fresh: true });
    expect(displays.log.probes).toBe(1);
    expect(frames[0]?.frame).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(frames[1]?.frame).toEqual({ x: 1920 - 800 - 10, y: 10 });
    expect(placed).toMatchObject({ display: "DISPLAY1" });
  });

  test("without resize, moves a window and keeps its size unless it cannot fit", () => {
    const { driver, frames } = moverDriver({
      windows: [[{ pid: 700, window_id: 55, frame: { x: 10, y: 10, width: 1000, height: 700 } }]],
    });
    const deps = directDeps({ drivers: [driver], displays: fakeDisplays({ cache: TWO_DISPLAYS }) });
    const placed = placeWindow(deps, HOST, WINDOW, { resize: false });
    expect(frames).toEqual([{ window: WINDOW, frame: { x: 4480 - 1000, y: 1400 - 700 } }]);
    expect(placed).toMatchObject({ display: "DISPLAY2" });

    const big = moverDriver({
      windows: [[{ pid: 700, window_id: 55, frame: { x: 0, y: 0, width: 3000, height: 700 } }]],
    });
    // Too wide for the target display: cut down to what fits there, then moved.
    const fitted = placeWindow(
      directDeps({ drivers: [big.driver], displays: fakeDisplays({ cache: TWO_DISPLAYS }) }),
      HOST,
      WINDOW,
      { resize: false },
    );
    expect(fitted).toMatchObject({ display: "DISPLAY2" });
    expect(big.frames).toHaveLength(2);
    expect(big.frames[0]?.frame.height).toBe(700);
    expect(big.frames[0]?.frame.width).toBeLessThan(3000);
    expect(Object.keys(big.frames[1]?.frame ?? {}).sort()).toEqual(["x", "y"]);
  });

  test("each reason to leave the window alone is reported, never thrown", () => {
    const cached = () => fakeDisplays({ cache: TWO_DISPLAYS });
    expect(placeWindow(directDeps({ displays: cached() }), HOST, WINDOW, { resize: true })).toEqual(
      { skipped: "no installed driver can move windows" },
    );
    const empty = fakeDisplays({
      probe: {
        probed_at: TWO_DISPLAYS.probed_at,
        source: "none",
        displays: [],
        error: "no screen",
      },
    });
    expect(
      placeWindow(directDeps({ drivers: [moverDriver().driver], displays: empty }), HOST, WINDOW, {
        resize: true,
      }),
    ).toEqual({ skipped: "no displays were found (no screen)" });
    expect(
      placeWindow(
        directDeps({
          drivers: [moverDriver().driver],
          displays: cached(),
          config: () =>
            cfg("on", {
              agent_window: { display: "9", corner: "bottom-right", margin: 0, move_apps: true },
            }),
        }),
        HOST,
        WINDOW,
        { resize: true },
      ),
    ).toEqual({ skipped: 'no display matches "9"' });
    expect(
      placeWindow(
        directDeps({ drivers: [moverDriver({ frameFails: true }).driver], displays: cached() }),
        HOST,
        WINDOW,
        { resize: true },
      ),
    ).toEqual({ skipped: "the driver could not size the window" });
    expect(
      placeWindow(
        directDeps({ drivers: [moverDriver({ windows: [[]] }).driver], displays: cached() }),
        HOST,
        WINDOW,
        { resize: false },
      ),
    ).toEqual({ skipped: "the window's size is unknown" });
    const throwing = moverDriver();
    throwing.driver.setWindowFrame = () => {
      throw new Error("bad handle");
    };
    expect(
      placeWindow(directDeps({ drivers: [throwing.driver], displays: cached() }), HOST, WINDOW, {
        resize: true,
      }),
    ).toEqual({ skipped: "placing the window failed: bad handle" });
  });
});

describe("computer browser open placement", () => {
  const attachOn = () => cfg("on", { browser_attach: true, project_browser_attach: true });

  test("picks the page tab, not the browser's own setup page left active by the attach", async () => {
    const { driver } = browserDriver({
      bindStdout: JSON.stringify({
        status: "ok",
        target_id: "t-1",
        tabs: [
          { active: false, tab_id: "tab-page", url: "https://example.com/" },
          { active: true, tab_id: "tab-setup", url: "chrome://inspect/#remote-debugging" },
        ],
      }),
    });
    const cap = await run(["browser", "open", "https://example.com/", "--json"], {
      driver,
      config: attachOn,
      displays: fakeDisplays(),
      personIdleMs: () => 60_000,
    });
    expect(cap.data[0]).toMatchObject({ tab_id: "tab-page", url: "https://example.com/" });
  });

  test("shrinks the window after the attach, binds last, and reports the frame", async () => {
    const { driver, order } = browserDriver();
    const mover = moverDriver();
    driver.setWindowFrame = (host, window, frame) => {
      order.push("frame");
      return mover.driver.setWindowFrame?.(host, window, frame);
    };
    const displays = fakeDisplays();
    const cap = await run(["browser", "open", "--json"], {
      driver,
      config: attachOn,
      displays,
      personIdleMs: () => 60_000,
    });
    expect(cap.errors).toEqual([]);
    expect(order).toEqual([
      "open",
      "call:browser_prepare",
      "frame",
      "frame",
      "call:get_browser_state",
    ]);
    // A fresh reading right before placing.
    expect(displays.log.probes).toBe(1);
    expect(cap.data[0]).toMatchObject({
      display: "DISPLAY2",
      frame: { x: 4080, y: 1100, width: 400, height: 300 },
    });
    expect(cap.data[0]).not.toHaveProperty("placement_skipped");

    const text = await run(["browser", "open"], {
      driver,
      config: attachOn,
      displays: fakeDisplays(),
      personIdleMs: () => 60_000,
    });
    expect(text.text.join("")).toContain("Placed it on display DISPLAY2 at 4080,1100, 400 by 300.");
  });

  test("a skipped placement is one stderr line and does not fail the open", async () => {
    const { driver } = browserDriver();
    const cap = await run(["browser", "open"], {
      driver,
      config: attachOn,
      personIdleMs: () => 60_000,
    });
    expect(cap.exitCode()).toBe(0);
    expect(cap.stderr).toEqual([
      "Left the browser window where it opened: no installed driver can move windows.\n",
    ]);
    expect(cap.text.join("")).not.toContain("Placed it");
  });
});

describe("computer call and displays", () => {
  test("reads the displays when the lease is newly taken, not on a refresh", async () => {
    const fresh = fakeDisplays();
    await run(["call", "click", "{}"], { displays: fresh });
    expect(fresh.log.probes).toBe(1);
    expect(fresh.log.writes).toHaveLength(1);

    const held = fakeDisplays();
    const refreshing = fakeLease();
    refreshing.acquire = async (owner, opts) => {
      refreshing.acquired.push(opts);
      return {
        ok: true,
        fresh: false,
        lease: lease({ owner_id: owner.id, owner_label: owner.label, generation: 1 }),
      };
    };
    await run(["call", "click", "{}"], { displays: held, lease: refreshing });
    expect(held.log.probes).toBe(0);
  });

  test("moves a launched program's windows to the corner without resizing them", async () => {
    const { driver, frames, windowsCalls } = moverDriver({
      launched: 900,
      windows: [
        [],
        [
          { pid: 900, window_id: 1, frame: { x: 0, y: 0, width: 1000, height: 700 } },
          { pid: 900, window_id: 2, frame: { x: 0, y: 0, width: 600, height: 400 } },
        ],
      ],
    });
    const slept: number[] = [];
    const cap = await run(["call", "launch_app", '{"name":"notepad"}'], {
      driver,
      displays: fakeDisplays(),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(cap.exitCode()).toBe(0);
    expect(windowsCalls).toEqual([900, 900]);
    expect(slept).toEqual([250]);
    expect(frames).toEqual([
      { window: { pid: 900, window_id: 1 }, frame: { x: 3480, y: 700 } },
      { window: { pid: 900, window_id: 2 }, frame: { x: 3880, y: 1000 } },
    ]);
    expect(cap.stderr).toEqual(["Moved the launched program's window to display DISPLAY2.\n"]);
  });

  test("leaves launched programs alone when move_apps is off, or nothing was launched", async () => {
    const off = moverDriver({
      launched: 900,
      windows: [[{ pid: 900, window_id: 1, frame: { x: 0, y: 0, width: 500, height: 400 } }]],
    });
    const cap = await run(["call", "launch_app", "{}"], {
      driver: off.driver,
      config: () =>
        cfg("on", {
          agent_window: {
            display: "secondary",
            corner: "bottom-right",
            margin: 0,
            move_apps: false,
          },
        }),
    });
    expect(cap.exitCode()).toBe(0);
    expect(off.windowsCalls).toEqual([]);
    expect(off.frames).toEqual([]);
    expect(cap.stderr).toEqual([]);

    const other = moverDriver({ launched: 900 });
    await run(["call", "click", "{}"], { driver: other.driver });
    expect(other.windowsCalls).toEqual([]);
  });

  test("gives up quietly after 3 seconds when the program shows no window", async () => {
    const { driver, frames, windowsCalls } = moverDriver({ launched: 900, windows: [[]] });
    const cap = await run(["call", "launch_app", "{}"], { driver, sleep: async () => {} });
    expect(windowsCalls).toHaveLength(13);
    expect(frames).toEqual([]);
    expect(cap.stderr).toEqual([]);
    expect(cap.exitCode()).toBe(0);
  });
});

describe("computer status displays and window", () => {
  test("names the last display reading and the placement", async () => {
    const reading = { ...TWO_DISPLAYS, probed_at: new Date(NOW - 40_000).toISOString() };
    const cap = await run(["status"], { displays: fakeDisplays({ cache: reading }) });
    const out = cap.text.join("\n");
    expect(out).toContain(
      "displays:  2 displays, read 40s ago; `acme computer displays` reads them now",
    );
    expect(out).toContain(
      "window:    the smallest size the program allows, bottom-right corner of the secondary display; launched programs move there too (the default)",
    );
    const none = await run(["status"]);
    expect(none.text.join("\n")).toContain(
      "displays:  not read yet; `acme computer displays` reads them now",
    );
    const json = await run(["status", "--json"], { displays: fakeDisplays({ cache: reading }) });
    expect(json.data[0]).toMatchObject({
      displays: reading,
      agent_window: { display: "secondary", corner: "bottom-right", margin: 0, move_apps: true },
      agent_window_source: "default",
    });
  });
});
