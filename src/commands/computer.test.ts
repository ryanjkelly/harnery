import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import type { ComputerProjectConfig } from "../core/config.ts";
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
  EXIT_LEASE_HELD,
  redactInlineScreenshots,
} from "./computer.ts";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const WSL_HOST: HostInfo = { kind: "wsl", desktopStateDir: "/mnt/c/Users/u/AppData/Local/harnery" };

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
      config: () => ({ enabled: true }),
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
    expect(out).toContain("enabled:   yes");
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
      config: () => ({ enabled: false }),
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
    const cap = await run(["install", "--yes"], { driver, config: () => ({ enabled: false }) });
    expect(cap.exitCode()).toBe(1);
    expect(cap.errors[0]?.message).toContain('"computer": { "enabled": true }');
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
      config: () => ({ enabled: true, idle_seconds: 60, wait_seconds: 5 }),
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

    const off = await run(["call", "click"], { config: () => ({ enabled: false }) });
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
