import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateScheduleTimerInstall } from "./job-types.ts";
import { scheduleTimerInstallPath } from "./paths.ts";
import {
  installScheduleTimer,
  renderScheduleServiceUnit,
  renderScheduleTimerUnit,
  ScheduleTimerError,
  scheduleTimerKey,
  scheduleTimerOnCalendar,
  scheduleTimerStatus,
  scheduleTimerUnitDir,
  scheduleTimerUnits,
  systemdQuoteExecArg,
  uninstallScheduleTimer,
} from "./timer-systemd.ts";
import type { ScheduleCommandResult, ScheduleCommandRunner } from "./types.ts";

interface FakeRunner {
  runner: ScheduleCommandRunner;
  calls: string[][];
}

function fakeRunner(
  respond: (argv: readonly string[]) => Partial<ScheduleCommandResult> | undefined = () =>
    undefined,
): FakeRunner {
  const calls: string[][] = [];
  const runner: ScheduleCommandRunner = async (argv) => {
    calls.push([...argv]);
    const custom = respond(argv);
    if (custom) return { exitCode: 0, stdout: "", stderr: "", ...custom };
    if (argv[2] === "is-system-running") return { exitCode: 0, stdout: "running\n", stderr: "" };
    if (argv[0] === "loginctl") return { exitCode: 0, stdout: "yes\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

let base: string;
let coordRoot: string;
let unitDir: string;

const ENTRY = { execPath: "/opt/runtime/bin/bun", script: "/opt/tool/src/cli.ts" };
const ENV = { PATH: "/usr/local/bin:/usr/bin:/bin", USER: "tester", SECRET_TOKEN: "do-not-leak" };

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "harnery-timer-")));
  coordRoot = join(base, "checkout");
  mkdirSync(coordRoot);
  unitDir = join(base, "units");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function opts(fake: FakeRunner, extra: Record<string, unknown> = {}) {
  return {
    coordRoot,
    unitDir,
    runner: fake.runner,
    env: ENV,
    platform: "linux" as const,
    isWsl: false,
    entry: ENTRY,
    now: () => new Date("2026-11-22T12:00:00.000Z"),
    ...extra,
  };
}

describe("unit text", () => {
  test("plain path", () => {
    const checkout = "/srv/work/project";
    const command = [
      ENTRY.execPath,
      ENTRY.script,
      "schedule",
      "tick",
      "--source",
      "timer",
      "--root",
      checkout,
    ];
    const input = { checkout, command, path: "/usr/bin:/bin", intervalMinutes: 5 };
    expect(renderScheduleServiceUnit(input)).toBe(
      [
        "[Unit]",
        "Description=Harnery schedule tick for project",
        "",
        "[Service]",
        "Type=oneshot",
        "WorkingDirectory=/srv/work/project",
        'Environment="PATH=/usr/bin:/bin"',
        'ExecStart="/opt/runtime/bin/bun" "/opt/tool/src/cli.ts" "schedule" "tick" "--source" "timer" "--root" "/srv/work/project"',
        "",
      ].join("\n"),
    );
    expect(renderScheduleTimerUnit(input)).toBe(
      [
        "[Unit]",
        "Description=Harnery schedule timer for project",
        "",
        "[Timer]",
        "OnCalendar=*:0/5",
        "Persistent=true",
        "AccuracySec=30s",
        "",
        "[Install]",
        "WantedBy=timers.target",
        "",
      ].join("\n"),
    );
  });

  test("a path with a space, a percent sign, a quote and a dollar", () => {
    const checkout = '/srv/my work/100% "done" $HOME';
    const command = [ENTRY.execPath, ENTRY.script, "--root", checkout];
    const service = renderScheduleServiceUnit({
      checkout,
      command,
      path: "/opt/50%/bin:/usr/bin",
      intervalMinutes: 5,
    });
    expect(service).toContain('WorkingDirectory=/srv/my work/100%% "done" $HOME');
    expect(service).toContain('"--root" "/srv/my work/100%% \\"done\\" $$HOME"');
    expect(service).toContain('Environment="PATH=/opt/50%%/bin:/usr/bin"');
    expect(service).toContain('Description=Harnery schedule tick for 100%% "done" $HOME');
    expect(systemdQuoteExecArg("a\\b")).toBe('"a\\\\b"');
  });

  test("refuses a control character", () => {
    expect(() =>
      renderScheduleServiceUnit({
        checkout: "/a\nb",
        command: ["/x"],
        path: "/bin",
        intervalMinutes: 5,
      }),
    ).toThrow(ScheduleTimerError);
  });

  test("intervals: divisors of an hour only", () => {
    expect(scheduleTimerOnCalendar(5)).toBe("*:0/5");
    expect(scheduleTimerOnCalendar(15)).toBe("*:0/15");
    expect(scheduleTimerOnCalendar(60)).toBe("*:00");
    for (const bad of [7, 0, 90, 2.5])
      expect(() => scheduleTimerOnCalendar(bad)).toThrow(/divides an hour/);
  });

  test("unit dir follows XDG_CONFIG_HOME", () => {
    expect(scheduleTimerUnitDir({ XDG_CONFIG_HOME: "/x/cfg" }, "/h")).toBe("/x/cfg/systemd/user");
    expect(scheduleTimerUnitDir({}, "/h")).toBe("/h/.config/systemd/user");
  });

  test("two checkouts get different unit names", () => {
    const other = join(base, "other");
    mkdirSync(other);
    const a = scheduleTimerUnits({ coordRoot, unitDir });
    const b = scheduleTimerUnits({ coordRoot: other, unitDir });
    expect(a.timer).not.toBe(b.timer);
    expect(a.timer).toMatch(/^harnery-schedule-[0-9a-f]{12}\.timer$/);
    expect(a.service).toBe(a.timer.replace(/\.timer$/, ".service"));
    expect(scheduleTimerKey(coordRoot)).toBe(a.key);
  });
});

describe("installScheduleTimer", () => {
  test("writes both files, reloads then enables, and records timer.json", async () => {
    const fake = fakeRunner();
    const result = await installScheduleTimer(opts(fake));
    const units = scheduleTimerUnits({ coordRoot, unitDir });
    expect(existsSync(units.timerPath)).toBe(true);
    expect(existsSync(units.servicePath)).toBe(true);
    const mutating = fake.calls.filter((c) => c[0] === "systemctl" && c[2] !== "is-system-running");
    expect(mutating).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", units.timer],
    ]);
    const record = JSON.parse(readFileSync(scheduleTimerInstallPath(coordRoot), "utf8"));
    expect(validateScheduleTimerInstall(record).ok).toBe(true);
    expect(record).toEqual({
      schema_version: 1,
      installed_at: "2026-11-22T12:00:00.000Z",
      interval_minutes: 5,
      unit: units.timer,
      command: [
        ENTRY.execPath,
        ENTRY.script,
        "schedule",
        "tick",
        "--source",
        "timer",
        "--root",
        coordRoot,
      ],
    });
    expect(result.path_dirs).toEqual(["/usr/local/bin", "/usr/bin", "/bin"]);
    expect(result.linger.enabled).toBe(true);
    expect(result.reinstalled).toBe(false);
    expect(result.notes).toEqual([]);
  });

  test("no environment variable other than PATH reaches the unit", async () => {
    await installScheduleTimer(opts(fakeRunner()));
    const units = scheduleTimerUnits({ coordRoot, unitDir });
    const text = readFileSync(units.servicePath, "utf8") + readFileSync(units.timerPath, "utf8");
    const envLines = text.split("\n").filter((l) => l.startsWith("Environment"));
    expect(envLines).toEqual(['Environment="PATH=/usr/local/bin:/usr/bin:/bin"']);
    expect(text).not.toContain("do-not-leak");
    expect(text).not.toContain("tester");
  });

  test("installing twice is idempotent and picks up a new PATH", async () => {
    await installScheduleTimer(opts(fakeRunner()));
    const second = await installScheduleTimer(
      opts(fakeRunner(), { env: { ...ENV, PATH: "/new/bin" } }),
    );
    expect(second.reinstalled).toBe(true);
    const units = scheduleTimerUnits({ coordRoot, unitDir });
    expect(readFileSync(units.servicePath, "utf8")).toContain('Environment="PATH=/new/bin"');
    expect(
      validateScheduleTimerInstall(
        JSON.parse(readFileSync(scheduleTimerInstallPath(coordRoot), "utf8")),
      ).ok,
    ).toBe(true);
  });

  test("a failed enable rolls back the files and reports the error", async () => {
    const fake = fakeRunner((argv) =>
      argv[2] === "enable" ? { exitCode: 1, stderr: "Failed to enable unit" } : undefined,
    );
    await expect(installScheduleTimer(opts(fake))).rejects.toThrow(/Failed to enable unit/);
    const units = scheduleTimerUnits({ coordRoot, unitDir });
    expect(existsSync(units.timerPath)).toBe(false);
    expect(existsSync(units.servicePath)).toBe(false);
    expect(existsSync(scheduleTimerInstallPath(coordRoot))).toBe(false);
    expect(fake.calls.at(-1)).toEqual(["systemctl", "--user", "daemon-reload"]);
  });

  test("refuses on macOS and Windows without calling systemctl", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      const fake = fakeRunner();
      await expect(installScheduleTimer(opts(fake, { platform }))).rejects.toThrow(
        /macOS and Windows timers are not supported yet/,
      );
      expect(fake.calls).toEqual([]);
    }
  });

  test("refuses when systemctl is missing or the user manager is not usable", async () => {
    const missing = fakeRunner((argv) =>
      argv[0] === "systemctl" ? { exitCode: null, error: "ENOENT" } : undefined,
    );
    await expect(installScheduleTimer(opts(missing))).rejects.toThrow(/systemctl is not installed/);
    const offline = fakeRunner((argv) =>
      argv[2] === "is-system-running"
        ? { exitCode: 1, stdout: "offline\n", stderr: "Failed to connect to bus" }
        : undefined,
    );
    await expect(installScheduleTimer(opts(offline, { isWsl: true }))).rejects.toThrow(
      /only while the guest is running/,
    );
    expect(existsSync(unitDir)).toBe(false);
  });

  test("refuses an interval that does not divide an hour before writing", async () => {
    const fake = fakeRunner();
    await expect(installScheduleTimer(opts(fake, { intervalMinutes: 7 }))).rejects.toThrow(
      /divides an hour/,
    );
    expect(fake.calls).toEqual([]);
    expect(existsSync(unitDir)).toBe(false);
  });

  test("reports lingering off and the WSL note", async () => {
    const fake = fakeRunner((argv) => (argv[0] === "loginctl" ? { stdout: "no\n" } : undefined));
    const result = await installScheduleTimer(opts(fake, { isWsl: true }));
    expect(result.linger).toEqual({
      enabled: false,
      enable_command: "loginctl enable-linger tester",
    });
    expect(result.notes.join("\n")).toContain("loginctl enable-linger tester");
    expect(result.notes.join("\n")).toContain("only while the WSL guest is running");
  });
});

describe("uninstallScheduleTimer", () => {
  test("removes exactly its own units and the record", async () => {
    await installScheduleTimer(opts(fakeRunner()));
    const units = scheduleTimerUnits({ coordRoot, unitDir });
    const strangerTimer = join(unitDir, "harnery-schedule-000000000000.timer");
    const unrelated = join(unitDir, "something-else.service");
    writeFileSync(strangerTimer, "[Timer]\n");
    writeFileSync(unrelated, "[Service]\n");
    const fake = fakeRunner();
    const result = await uninstallScheduleTimer(opts(fake));
    expect(result.was_installed).toBe(true);
    expect(result.removed_files.sort()).toEqual([units.servicePath, units.timerPath].sort());
    expect(result.removed_record).toBe(true);
    expect(existsSync(units.timerPath)).toBe(false);
    expect(existsSync(units.servicePath)).toBe(false);
    expect(existsSync(scheduleTimerInstallPath(coordRoot))).toBe(false);
    expect(existsSync(strangerTimer)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(fake.calls).toEqual([
      ["systemctl", "--user", "disable", "--now", units.timer],
      ["systemctl", "--user", "daemon-reload"],
    ]);
  });

  test("is safe when nothing is installed", async () => {
    const fake = fakeRunner();
    const result = await uninstallScheduleTimer(opts(fake));
    expect(result.was_installed).toBe(false);
    expect(result.removed_files).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

describe("scheduleTimerStatus", () => {
  test("reads the record, files and systemd state without changing anything", async () => {
    await installScheduleTimer(opts(fakeRunner()));
    const fake = fakeRunner((argv) =>
      argv[2] === "is-enabled"
        ? { stdout: "enabled\n" }
        : argv[2] === "is-active"
          ? { stdout: "active\n" }
          : undefined,
    );
    const status = await scheduleTimerStatus(opts(fake));
    expect(status.record?.interval_minutes).toBe(5);
    expect(status.timer_file).toBe(true);
    expect(status.service_file).toBe(true);
    expect(status.enabled).toBe("enabled");
    expect(status.active).toBe("active");
    expect(fake.calls.map((c) => c[2])).toEqual(["is-enabled", "is-active"]);
  });

  test("with nothing installed", async () => {
    const fake = fakeRunner((argv) => ({
      exitCode: 1,
      stdout: argv[2] === "is-enabled" ? "not-found\n" : "inactive\n",
    }));
    const status = await scheduleTimerStatus(opts(fake));
    expect(status.record).toBeNull();
    expect(status.timer_file).toBe(false);
    expect(status.enabled).toBe("not-found");
    expect(status.active).toBe("inactive");
  });
});
