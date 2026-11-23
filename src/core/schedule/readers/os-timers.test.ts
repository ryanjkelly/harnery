import { describe, expect, test } from "bun:test";
import type {
  ScheduleCommandResult,
  ScheduleCommandRunner,
  ScheduleReadContext,
  ScheduleReadResult,
} from "../types.ts";
import { validateScheduleReadResult } from "../types.ts";
import {
  CRONTAB_LIST_ARGV,
  osTimersScheduleReader,
  parseCrontab,
  parseSystemdTimespan,
  parseTimerListText,
  SYSTEMD_LIST_JSON_ARGV,
  SYSTEMD_LIST_TEXT_ARGV,
  systemdShowArgv,
} from "./os-timers.ts";

const MACHINE = "test-machine";
const NOW = Date.parse("2026-11-22T12:00:00Z");

const ok = (stdout: string): ScheduleCommandResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (exitCode: number, stderr: string): ScheduleCommandResult => ({
  exitCode,
  stdout: "",
  stderr,
});
const ENOENT: ScheduleCommandResult = { exitCode: null, stdout: "", stderr: "", error: "ENOENT" };
const NO_CRONTAB = fail(1, "no crontab for tester\n");

type Responses = Map<string, ScheduleCommandResult>;

function fakeRunner(responses: Responses, calls: string[][] = []): ScheduleCommandRunner {
  return async (argv) => {
    calls.push([...argv]);
    const key = JSON.stringify(argv);
    if (responses.has(key)) return responses.get(key) as ScheduleCommandResult;
    // Any `systemctl show` not registered answers with nothing.
    if (argv[2] === "show") return ok("");
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
}

function ctx(runCommand: ScheduleCommandRunner): ScheduleReadContext {
  return {
    coordRoot: "/nonexistent",
    env: {},
    homeDir: "/nonexistent",
    platform: "linux",
    machine: MACHINE,
    now: () => NOW,
    runCommand,
    tmpDir: "/nonexistent",
  };
}

function key(argv: readonly string[]): string {
  return JSON.stringify(argv);
}

async function read(responses: Responses, calls?: string[][]): Promise<ScheduleReadResult> {
  const result = await osTimersScheduleReader.read(ctx(fakeRunner(responses, calls)));
  const v = validateScheduleReadResult(result);
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return result;
}

const usec = (iso: string): number => Date.parse(iso) * 1000;

const TIMERS_JSON = JSON.stringify([
  {
    next: usec("2026-11-22T12:05:00Z"),
    left: usec("2026-11-22T12:05:00Z"),
    last: usec("2026-11-22T12:00:00Z"),
    passed: usec("2026-11-22T12:00:00Z"),
    unit: "example-sync.timer",
    activates: "example-sync.service",
  },
  {
    next: usec("2026-11-23T06:00:00Z"),
    left: usec("2026-11-23T06:00:00Z"),
    last: 0,
    passed: 0,
    unit: "example-report.timer",
    activates: "example-report.service",
  },
  {
    next: null,
    left: null,
    last: usec("2026-11-21T03:00:00Z"),
    passed: usec("2026-11-21T03:00:00Z"),
    unit: "example-backup.timer",
    activates: "example-backup.service",
  },
]);

const SHOW_UNITS = [
  "example-sync.timer",
  "example-sync.service",
  "example-report.timer",
  "example-report.service",
  "example-backup.timer",
  "example-backup.service",
];

const SHOW_OUTPUT = [
  [
    "Id=example-sync.timer",
    "TimersMonotonic={ OnUnitActiveUSec=5min ; next_elapse=1w 4d 4h 49min 32.480440s }",
    "TimersMonotonic={ OnStartupUSec=1min 30s ; next_elapse=1min 52.808229s }",
    "UnitFileState=enabled",
    "ActiveState=active",
    "Result=success",
  ].join("\n"),
  [
    "Id=example-sync.service",
    "UnitFileState=static",
    "ActiveState=inactive",
    "Result=success",
    "ExecMainStatus=0",
  ].join("\n"),
  [
    "Id=example-report.timer",
    "TimersCalendar={ OnCalendar=*-*-* 06:00:00 ; next_elapse=Mon 2026-11-23 06:00:00 UTC }",
    "UnitFileState=enabled",
    "ActiveState=active",
    "Result=success",
  ].join("\n"),
  [
    "Id=example-report.service",
    "UnitFileState=static",
    "ActiveState=inactive",
    "Result=success",
    "ExecMainStatus=0",
  ].join("\n"),
  [
    "Id=example-backup.timer",
    "TimersCalendar={ OnCalendar=*-*-* 03:00:00 ; next_elapse=n/a }",
    "UnitFileState=disabled",
    "ActiveState=inactive",
    "Result=success",
  ].join("\n"),
  [
    "Id=example-backup.service",
    "UnitFileState=static",
    "ActiveState=failed",
    "Result=exit-code",
    "ExecMainStatus=2",
    "ExecStart={ path=/usr/bin/example ; argv[]=/usr/bin/example --token=SHOULD-NOT-LEAK }",
  ].join("\n"),
].join("\n\n");

function happyResponses(): Responses {
  return new Map([
    [key(SYSTEMD_LIST_JSON_ARGV), ok(TIMERS_JSON)],
    [key(systemdShowArgv(SHOW_UNITS)), ok(`${SHOW_OUTPUT}\n`)],
    [key(CRONTAB_LIST_ARGV), NO_CRONTAB],
  ]);
}

describe("osTimersScheduleReader: systemd", () => {
  test("is the os-timer reader and needs no opt-in", () => {
    expect(osTimersScheduleReader.id).toBe("os-timer");
    expect(osTimersScheduleReader.requiresOptIn).toBe(false);
  });

  test("reads the JSON list and batches the show call", async () => {
    const calls: string[][] = [];
    const result = await read(happyResponses(), calls);
    expect(result.coverage).toEqual({
      source: "os-timer",
      account: MACHINE,
      state: "current",
      read_at: "2026-11-22T12:00:00.000Z",
    });
    expect(calls.filter((c) => c[2] === "show")).toHaveLength(1);
    const sync = result.records.find((r) => r.id === "systemd-user:example-sync.timer");
    expect(sync).toEqual({
      source: "os-timer",
      account: MACHINE,
      id: "systemd-user:example-sync.timer",
      title: "example-sync.timer",
      trigger: {
        kind: "interval",
        everyMs: 300_000,
        raw: "OnUnitActiveUSec=5min; OnStartupUSec=1min 30s",
      },
      runs_on: { host: MACHINE },
      enabled: true,
      next_run_at: "2026-11-22T12:05:00.000Z",
      last_run: { at: "2026-11-22T12:00:00.000Z", status: "succeeded" },
      created_by: null,
    });
  });

  test("a calendar timer that never ran has no last run", async () => {
    const result = await read(happyResponses());
    const report = result.records.find((r) => r.id === "systemd-user:example-report.timer");
    expect(report?.trigger).toEqual({
      kind: "event",
      description: "calendar: *-*-* 06:00:00",
      raw: "OnCalendar=*-*-* 06:00:00",
    });
    expect(report?.last_run).toBeNull();
    expect(report?.next_run_at).toBe("2026-11-23T06:00:00.000Z");
  });

  test("a disabled timer with a failed service", async () => {
    const result = await read(happyResponses());
    const backup = result.records.find((r) => r.id === "systemd-user:example-backup.timer");
    expect(backup?.enabled).toBe(false);
    expect(backup?.next_run_at).toBeNull();
    expect(backup?.last_run).toEqual({ at: "2026-11-21T03:00:00.000Z", status: "failed" });
    expect(JSON.stringify(result)).not.toContain("SHOULD-NOT-LEAK");
    expect(JSON.stringify(result)).not.toContain("ExecStart");
  });

  test("never asks systemctl for ExecStart", async () => {
    const calls: string[][] = [];
    await read(happyResponses(), calls);
    for (const c of calls) expect(c.join(" ")).not.toContain("ExecStart");
  });

  test("falls back to the text table when --output=json is refused", async () => {
    const text = [
      "Sun 2026-11-22 12:05:00 UTC 4min 20s left Sun 2026-11-22 12:00:00 UTC 41s ago      example-sync.timer   example-sync.service",
      "Mon 2026-11-23 06:00:00 CST 17h left      n/a                         n/a          example-report.timer example-report.service",
      "",
    ].join("\n");
    const responses: Responses = new Map([
      [key(SYSTEMD_LIST_JSON_ARGV), fail(1, "systemctl: unrecognized option '--output=json'\n")],
      [key(SYSTEMD_LIST_TEXT_ARGV), ok(text)],
      [key(CRONTAB_LIST_ARGV), NO_CRONTAB],
      [
        key(
          systemdShowArgv([
            "example-sync.timer",
            "example-sync.service",
            "example-report.timer",
            "example-report.service",
          ]),
        ),
        ok(SHOW_OUTPUT),
      ],
    ]);
    const result = await read(responses);
    expect(result.coverage.state).toBe("current");
    expect(result.records.map((r) => r.id)).toEqual([
      "systemd-user:example-sync.timer",
      "systemd-user:example-report.timer",
    ]);
    const [sync, report] = result.records;
    expect(sync?.next_run_at).toBe("2026-11-22T12:05:00.000Z");
    expect(sync?.last_run).toEqual({ at: "2026-11-22T12:00:00.000Z", status: "succeeded" });
    // A non-UTC zone abbreviation is not guessed.
    expect(report?.next_run_at).toBeNull();
    expect(report?.last_run).toBeNull();
  });

  test("falls back to the text table on malformed JSON", async () => {
    const responses: Responses = new Map([
      [key(SYSTEMD_LIST_JSON_ARGV), ok("[{not json")],
      [
        key(SYSTEMD_LIST_TEXT_ARGV),
        ok("n/a n/a Sun 2026-11-22 10:00:00 CST 2h ago example-once.timer example-once.service\n"),
      ],
      [key(CRONTAB_LIST_ARGV), NO_CRONTAB],
    ]);
    const result = await read(responses);
    expect(result.coverage.state).toBe("current");
    expect(result.records).toHaveLength(1);
    const [once] = result.records;
    expect(once?.next_run_at).toBeNull();
    // It ran, at a time we will not guess, and the service's result is unknown.
    expect(once?.last_run).toBeNull();
    expect(once?.enabled).toBeNull();
    expect(once?.trigger.kind).toBe("event");
  });

  test("the user bus being unavailable is unreadable", async () => {
    const bus = fail(1, "Failed to connect to bus: No medium found\n");
    const responses: Responses = new Map([
      [key(SYSTEMD_LIST_JSON_ARGV), bus],
      [key(SYSTEMD_LIST_TEXT_ARGV), bus],
      [key(CRONTAB_LIST_ARGV), ok("0 6 * * * example-job\n")],
    ]);
    const result = await read(responses);
    expect(result.coverage.state).toBe("unreadable");
    expect(result.coverage.detail).toContain("Failed to connect to bus");
    // The crontab still answered, and its records are returned.
    expect(result.records.map((r) => r.id)).toEqual(["crontab:1"]);
  });
});

describe("osTimersScheduleReader: crontab", () => {
  test("an empty crontab is current with no records", async () => {
    const responses: Responses = new Map([
      [key(SYSTEMD_LIST_JSON_ARGV), ok("[]")],
      [key(CRONTAB_LIST_ARGV), NO_CRONTAB],
    ]);
    const result = await read(responses);
    expect(result.coverage.state).toBe("current");
    expect(result.coverage.detail).toBeUndefined();
    expect(result.records).toEqual([]);
  });

  test("comments, assignments and macros", async () => {
    const crontab = [
      "# m h dom mon dow command",
      "SHELL=/bin/sh",
      "MAILTO=someone",
      "",
      "*/15 * * * * /usr/local/bin/example --api-key=sk-SECRET123 >/dev/null 2>&1",
      "@daily /usr/local/bin/example-daily TOKEN=ghp_SECRETTOKEN",
      "CRON_TZ=America/Chicago",
      "30 2 * * 1-5 example-weekday",
      "   # indented comment",
      "@reboot example-boot",
    ].join("\n");
    const responses: Responses = new Map([
      [key(SYSTEMD_LIST_JSON_ARGV), ENOENT],
      [key(CRONTAB_LIST_ARGV), ok(crontab)],
    ]);
    const result = await read(responses);
    expect(result.coverage.state).toBe("current");
    expect(result.coverage.detail).toContain("systemctl is not installed");
    expect(result.records.map((r) => [r.id, r.title, r.trigger])).toEqual([
      ["crontab:1", "crontab entry 1", { kind: "cron", expr: "*/15 * * * *", raw: "*/15 * * * *" }],
      [
        "crontab:2",
        "crontab entry 2",
        { kind: "event", description: "cron macro: @daily", raw: "@daily" },
      ],
      [
        "crontab:3",
        "crontab entry 3",
        { kind: "cron", expr: "30 2 * * 1-5", zone: "America/Chicago", raw: "30 2 * * 1-5" },
      ],
      [
        "crontab:4",
        "crontab entry 4",
        { kind: "event", description: "cron macro: @reboot", raw: "@reboot" },
      ],
    ]);
    for (const r of result.records) {
      expect(r.enabled).toBe(true);
      expect(r.next_run_at).toBeNull();
      expect(r.last_run).toBeNull();
      expect(r.account).toBe(MACHINE);
      expect(r.runs_on).toEqual({ host: MACHINE });
    }
    const json = JSON.stringify(result);
    for (const leak of [
      "SECRET123",
      "ghp_SECRETTOKEN",
      "/usr/local/bin",
      "example-weekday",
      "example-boot",
    ]) {
      expect(json).not.toContain(leak);
    }
  });

  test("a line the reader cannot parse keeps no text", () => {
    const records = parseCrontab("not a cron line with-secret-word\n", MACHINE);
    expect(records).toHaveLength(1);
    expect(records[0]?.trigger).toEqual({
      kind: "event",
      description: "crontab line the reader does not recognise",
      raw: "",
    });
    expect(JSON.stringify(records)).not.toContain("with-secret-word");
  });

  test("a crontab that fails unexpectedly is unreadable", async () => {
    const responses: Responses = new Map([
      [key(SYSTEMD_LIST_JSON_ARGV), ok("[]")],
      [key(CRONTAB_LIST_ARGV), fail(1, "crontab: cannot open your crontab: permission denied\n")],
    ]);
    const result = await read(responses);
    expect(result.coverage.state).toBe("unreadable");
    expect(result.coverage.detail).toContain("crontab could not be read");
  });
});

describe("osTimersScheduleReader: coverage", () => {
  test("both tools absent is unsupported", async () => {
    const responses: Responses = new Map([
      [key(SYSTEMD_LIST_JSON_ARGV), ENOENT],
      [key(CRONTAB_LIST_ARGV), ENOENT],
    ]);
    const result = await read(responses);
    expect(result.coverage.state).toBe("unsupported");
    expect(result.coverage.detail).toBe(
      "Neither systemctl nor crontab is installed on this machine.",
    );
    expect(result.records).toEqual([]);
  });

  test("crontab absent with systemd working stays current", async () => {
    const responses = happyResponses();
    responses.set(key(CRONTAB_LIST_ARGV), ENOENT);
    const result = await read(responses);
    expect(result.coverage.state).toBe("current");
    expect(result.coverage.detail).toBe("crontab is not installed, so no crontab was read.");
    expect(result.records).toHaveLength(3);
  });

  test("returns records from both tools together", async () => {
    const responses = happyResponses();
    responses.set(key(CRONTAB_LIST_ARGV), ok("0 * * * * example\n"));
    const result = await read(responses);
    expect(result.records.map((r) => r.id)).toEqual([
      "systemd-user:example-sync.timer",
      "systemd-user:example-report.timer",
      "systemd-user:example-backup.timer",
      "crontab:1",
    ]);
  });

  test("never throws, even when the runner does", async () => {
    const result = await osTimersScheduleReader.read(
      ctx(async () => {
        throw new Error("boom");
      }),
    );
    expect(validateScheduleReadResult(result).ok).toBe(true);
    expect(result.coverage.state).toBe("unreadable");
  });
});

describe("parsers", () => {
  test("parseSystemdTimespan", () => {
    expect(parseSystemdTimespan("5min")).toBe(300_000);
    expect(parseSystemdTimespan("1h 30min")).toBe(5_400_000);
    expect(parseSystemdTimespan("1min 30s")).toBe(90_000);
    expect(parseSystemdTimespan("1d")).toBe(86_400_000);
    expect(parseSystemdTimespan("500ms")).toBe(500);
    expect(parseSystemdTimespan("soon")).toBeNull();
    expect(parseSystemdTimespan("")).toBeNull();
  });

  test("parseTimerListText reads a dash for a timer that never ran", () => {
    const rows = parseTimerListText(
      "Mon 2026-11-23 06:00:00 UTC 17h - - example-new.timer example-new.service\n",
    );
    expect(rows).toEqual([
      {
        unit: "example-new.timer",
        activates: "example-new.service",
        next: "2026-11-23T06:00:00.000Z",
        last: null,
        neverRan: true,
      },
    ]);
  });

  test("show batches stay within the batch size", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      next: 0,
      left: 0,
      last: 0,
      passed: 0,
      unit: `example-${i}.timer`,
      activates: `example-${i}.service`,
    }));
    const calls: string[][] = [];
    const responses: Responses = new Map([
      [key(SYSTEMD_LIST_JSON_ARGV), ok(JSON.stringify(many))],
      [key(CRONTAB_LIST_ARGV), NO_CRONTAB],
    ]);
    const result = await read(responses, calls);
    expect(result.records).toHaveLength(30);
    const shows = calls.filter((c) => c[2] === "show");
    expect(shows).toHaveLength(2);
    expect(shows.map((c) => c.length - 5)).toEqual([40, 20]);
  });
});
