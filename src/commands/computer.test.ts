import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { initializeV3Fixture, seedV3Session } from "../../tests/helpers/event-v3-runtime.ts";
import type { EmitContext } from "../commander.ts";
import type { ComputerMode, ComputerPreferences, ComputerProjectConfig } from "../core/config.ts";
import type { ConfirmRequest, ConfirmResult } from "../lib/computer/confirm.ts";
import type { DesktopGrant, GrantLogEntry } from "../lib/computer/grants.ts";
import type {
  DaemonStatus,
  DesktopDriver,
  DesktopLease,
  DriverCallResult,
  HostInfo,
  InstallPlan,
  LeaseAcquireResult,
  LeaseApi,
  LeaseOptions,
  LeaseOwner,
} from "../lib/computer/types.ts";
import {
  type ComputerDepsInput,
  createComputerCommand,
  EXIT_APPROVAL_REQUIRED,
  EXIT_LEASE_HELD,
  type GrantsApi,
  redactInlineScreenshots,
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
  };
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
    rmSync(base, { recursive: true, force: true });
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
