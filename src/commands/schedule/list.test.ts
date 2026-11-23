import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { EmitContext } from "../../commander.ts";
import { resolveBinName } from "../../core/config.ts";
import { scheduleJobFilePath } from "../../core/schedule/paths.ts";
import { harneryScheduleReader } from "../../core/schedule/readers/harnery.ts";
import {
  SCHEDULE_SOURCES,
  type ScheduleReader,
  type ScheduleRecord,
  type ScheduleSource,
} from "../../core/schedule/types.ts";
import { parseScheduleRef, registerScheduleListCommands, type ScheduleListDeps } from "./list.ts";

const MACHINE = "box";
const PROMPT = "SECRET-PROMPT-TEXT summarise the night";
let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "harnery-schedule-list-")));
  spawnSync("git", ["init", "-q"], { cwd: base, windowsHide: true });
  mkdirSync(join(base, ".harnery"), { recursive: true });
  writeFileSync(
    join(base, ".harnery", "config.jsonc"),
    JSON.stringify({ timeZone: "UTC", binName: "harn" }),
  );
  writeFileSync(
    scheduleJobFilePath(base),
    JSON.stringify({
      version: 1,
      jobs: [
        {
          id: "nightly-check",
          title: "Nightly check",
          host: MACHINE,
          trigger: { type: "cron", expr: "0 3 * * *" },
          timeout_minutes: 10,
          max_launches_per_day: 2,
          agent: { adapter: "codex", prompt: PROMPT },
        },
      ],
    }),
  );
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function osRecord(id: string): ScheduleRecord {
  return {
    source: "os-timer",
    account: MACHINE,
    id,
    title: "",
    trigger: { kind: "interval", everyMs: 3_600_000, raw: "OnUnitActiveSec=1h" },
    runs_on: { host: MACHINE },
    enabled: true,
    next_run_at: "2026-11-22T13:00:00.000Z",
    last_run: { at: "2026-11-22T12:00:00.000Z", status: "succeeded" },
    created_by: null,
  };
}

function fake(id: ScheduleSource, records: ScheduleRecord[]): ScheduleReader {
  return {
    id,
    requiresOptIn: false,
    async read(ctx) {
      return {
        coverage: {
          source: id,
          account: ctx.machine,
          state: "current",
          read_at: new Date(ctx.now()).toISOString(),
        },
        records,
      };
    },
  };
}

interface Captured {
  data: unknown[];
  text: string[];
  errors: unknown[];
  exitCode: number;
}

function harness(readers: ScheduleReader[]) {
  const out: Captured = { data: [], text: [], errors: [], exitCode: 0 };
  const emit: EmitContext = {
    config() {},
    data: (p) => out.data.push(p),
    rows: (r) => out.data.push(r),
    text: (s) => out.text.push(s),
    file() {},
    error: (e) => out.errors.push(e),
    log() {},
    setExitCode: (n) => {
      out.exitCode = n;
    },
  };
  const deps: ScheduleListDeps = {
    coordRoot: base,
    machine: MACHINE,
    homeDir: join(base, "home"),
    env: {},
    platform: "linux",
    now: () => Date.parse("2026-11-22T12:30:00.000Z"),
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    readers,
    liveInstanceIds: null,
  };
  const schedule = new Command("schedule").exitOverride();
  registerScheduleListCommands(schedule, emit, deps);
  const run = (...args: string[]) => schedule.parseAsync(args, { from: "user" });
  return { out, run };
}

describe("schedule list", () => {
  test("--json carries every record and the coverage of every source", async () => {
    const { out, run } = harness([harneryScheduleReader, fake("os-timer", [osRecord("backup")])]);
    await run("list", "--json");
    expect(out.exitCode).toBe(0);
    const payload = out.data[0] as { records: ScheduleRecord[]; coverage: { source: string }[] };
    expect(payload.coverage.map((c) => c.source)).toEqual([...SCHEDULE_SOURCES]);
    expect(payload.records.map((r) => `${r.source}:${r.id}`).sort()).toEqual([
      "harnery:nightly-check",
      "os-timer:backup",
    ]);
    expect(payload.records.find((r) => r.source === "os-timer")?.next_run_at).toBe(
      "2026-11-22T13:00:00.000Z",
    );
    expect(JSON.stringify(out)).not.toContain("SECRET-PROMPT-TEXT");
  });

  test("--source filters records but coverage still shows every source", async () => {
    const { out, run } = harness([harneryScheduleReader, fake("os-timer", [osRecord("backup")])]);
    await run("list", "--json", "--source", "os-timer");
    const payload = out.data[0] as { records: ScheduleRecord[]; coverage: unknown[] };
    expect(payload.records.map((r) => r.id)).toEqual(["backup"]);
    expect(payload.coverage).toHaveLength(SCHEDULE_SOURCES.length);
  });

  test("an unknown source is refused", async () => {
    const { out, run } = harness([]);
    await run("list", "--source", "nope");
    expect(out.exitCode).toBe(1);
    expect(JSON.stringify(out.errors)).toContain("bad_schedule_source");
  });

  test("the table shows the id for an empty title and the coverage section", async () => {
    const { out, run } = harness([harneryScheduleReader, fake("os-timer", [osRecord("backup")])]);
    await run("list");
    const text = out.text.join("");
    expect(text).toContain("backup");
    expect(text).toContain("Nightly check");
    expect(text).toContain("Coverage");
    for (const source of SCHEDULE_SOURCES) expect(text).toContain(source);
    expect(text).toContain("unsupported");
    expect(text).toContain(`${resolveBinName(base)} schedule show`);
    expect(text).not.toContain("SECRET-PROMPT-TEXT");
  });
});

describe("schedule show", () => {
  test("shows a harnery record with its enrollment and report", async () => {
    const { out, run } = harness([harneryScheduleReader]);
    await run("show", "nightly-check", "--json");
    expect(out.exitCode).toBe(0);
    const payload = out.data[0] as {
      record: ScheduleRecord;
      coverage: { source: string; state: string };
      harnery: { enrollment: { state: string }; latest_report: string | null };
    };
    expect(payload.record.id).toBe("nightly-check");
    expect(payload.coverage).toMatchObject({ source: "harnery", state: "current" });
    expect(payload.harnery.enrollment.state).toBe("not-enrolled");
    expect(payload.harnery.latest_report).toBeNull();
    expect(JSON.stringify(out)).not.toContain("SECRET-PROMPT-TEXT");

    const text = harness([harneryScheduleReader]);
    await text.run("show", "nightly-check");
    const shown = text.out.text.join("");
    expect(shown).toContain("enrollment:  not-enrolled");
    expect(shown).not.toContain("SECRET-PROMPT-TEXT");
  });

  test("an id in two sources is ambiguous until named with source:id", async () => {
    const readers = [harneryScheduleReader, fake("os-timer", [osRecord("nightly-check")])];
    const first = harness(readers);
    await first.run("show", "nightly-check");
    expect(first.out.exitCode).toBe(1);
    const error = JSON.stringify(first.out.errors);
    expect(error).toContain("schedule_ambiguous");
    expect(error).toContain("harnery:nightly-check");
    expect(error).toContain("os-timer:nightly-check");

    const second = harness(readers);
    await second.run("show", "os-timer:nightly-check", "--json");
    expect(second.out.exitCode).toBe(0);
    expect((second.out.data[0] as { record: ScheduleRecord }).record.source).toBe("os-timer");
  });

  test("an unknown id exits non-zero", async () => {
    const { out, run } = harness([]);
    await run("show", "missing");
    expect(out.exitCode).toBe(1);
    expect(JSON.stringify(out.errors)).toContain("schedule_not_found");
  });
});

describe("parseScheduleRef", () => {
  test("splits only a known source prefix", () => {
    expect(parseScheduleRef("os-timer:a:b")).toEqual({ source: "os-timer", id: "a:b" });
    expect(parseScheduleRef("unknown:x")).toEqual({ id: "unknown:x" });
    expect(parseScheduleRef("plain")).toEqual({ id: "plain" });
  });
});
