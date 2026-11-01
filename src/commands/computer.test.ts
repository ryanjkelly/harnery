import { describe, expect, test } from "bun:test";
import { Command } from "commander";
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
  };
  return {
    state,
    read: () => state.prefs,
    write: (root: string | null, mode: ComputerMode | null) => {
      state.writes.push({ root, mode });
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
  opts: { installed?: boolean; running?: boolean; stdout?: string } = {},
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
    id: "fake",
    version: "1.2.3",
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
    expect(out).toContain("fake 1.2.3 (pinned)");
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
      driver: { id: "fake", version: "1.2.3" },
      installed: null,
      daemon: null,
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
    expect(cap.errors[0]?.message).toContain("acme computer install --yes");
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
      `<omitted ${b64.length} chars; pass screenshot_out_file or --keep-screenshot>`,
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
