import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleObservedPath } from "./paths.ts";
import { readAllSchedules, SCHEDULE_READERS } from "./registry.ts";
import {
  SCHEDULE_SOURCES,
  type ScheduleObservation,
  type ScheduleReader,
  type ScheduleRecord,
  type ScheduleSource,
} from "./types.ts";

const MACHINE = "box";
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
let base: string;
let savedXdg: string | undefined;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "harnery-schedule-registry-")));
  mkdirSync(join(base, ".harnery"), { recursive: true });
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(base, "xdg");
});
afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(base, { recursive: true, force: true });
});

function record(source: ScheduleSource, id: string, title = id): ScheduleRecord {
  return {
    source,
    account: MACHINE,
    id,
    title,
    trigger: { kind: "cron", expr: "0 3 * * *", raw: "0 3 * * *" },
    runs_on: { host: MACHINE },
    enabled: true,
    next_run_at: null,
    last_run: null,
    created_by: null,
  };
}

function fake(
  id: ScheduleSource,
  records: ScheduleRecord[],
  opts: { optIn?: boolean; calls?: ScheduleSource[] } = {},
): ScheduleReader {
  return {
    id,
    requiresOptIn: opts.optIn ?? false,
    async read(ctx) {
      opts.calls?.push(id);
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

function throwing(id: ScheduleSource, optIn = false): ScheduleReader {
  return {
    id,
    requiresOptIn: optIn,
    async read() {
      throw new Error("store exploded\nsecond line");
    },
  };
}

function projectConfig(value: unknown): void {
  writeFileSync(join(base, ".harnery", "config.jsonc"), JSON.stringify(value));
}

function observe(lines: ScheduleObservation[]): void {
  const path = scheduleObservedPath(base);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

const observation = (over: Partial<ScheduleObservation>): ScheduleObservation => ({
  schema_version: 1,
  observed_at: "2026-11-21T10:00:00.000Z",
  instance_id: "inst-live",
  agent_name: "agent-Ada",
  task: "set up the nightly check",
  tool: "t3-code.schedule_task",
  operation: "create",
  native_id: "t3-1",
  title: "Nightly",
  trigger: null,
  expires_with_session: false,
  ...over,
});

const read = (readers: ScheduleReader[], extra: { live?: Set<string> | null } = {}) =>
  readAllSchedules({
    coordRoot: base,
    machine: MACHINE,
    homeDir: join(base, "home"),
    env: {},
    platform: "linux",
    now: () => NOW,
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    readers,
    liveInstanceIds: extra.live === undefined ? null : extra.live,
  });

describe("readAllSchedules", () => {
  test("every source gets a coverage row, in source order", async () => {
    const list = await read([]);
    expect(list.coverage.map((c) => c.source)).toEqual([...SCHEDULE_SOURCES]);
    expect(list.coverage.find((c) => c.source === "captured")?.state).toBe("current");
    expect(list.coverage.find((c) => c.source === "harnery")?.state).toBe("unsupported");
    expect(list.records).toEqual([]);
  });

  test("a throwing reader is unreadable with a one-line detail and the list still returns", async () => {
    const list = await read([throwing("os-timer"), fake("harnery", [record("harnery", "a")])]);
    const os = list.coverage.find((c) => c.source === "os-timer");
    expect(os?.state).toBe("unreadable");
    expect(os?.detail).toContain("store exploded");
    expect(os?.detail).not.toContain("second line");
    expect(list.records.map((r) => r.id)).toEqual(["a"]);
  });

  test("an opt-in reader the project has not turned on is disabled and never called", async () => {
    const calls: ScheduleSource[] = [];
    const list = await read([
      fake("t3-code", [record("t3-code", "t3-1")], { optIn: true, calls }),
      throwing("codex-app", true),
    ]);
    expect(calls).toEqual([]);
    expect(list.coverage.find((c) => c.source === "t3-code")?.state).toBe("disabled");
    expect(list.coverage.find((c) => c.source === "codex-app")?.state).toBe("disabled");
    expect(list.records).toEqual([]);
  });

  test("the project config turns an opt-in reader on", async () => {
    projectConfig({ schedule: { readers: ["t3-code", "codex-app"] } });
    const calls: ScheduleSource[] = [];
    const list = await read([
      fake("t3-code", [record("t3-code", "t3-1")], { optIn: true, calls }),
      throwing("codex-app", true),
    ]);
    expect(calls).toEqual(["t3-code"]);
    expect(list.coverage.find((c) => c.source === "t3-code")?.state).toBe("current");
    expect(list.coverage.find((c) => c.source === "codex-app")?.state).toBe("unreadable");
    expect(list.records.map((r) => r.id)).toEqual(["t3-1"]);
  });

  test("a user-global or machine-local setting never turns an opt-in reader on", async () => {
    const xdg = join(base, "xdg", "harnery");
    mkdirSync(xdg, { recursive: true });
    const on = JSON.stringify({ schedule: { readers: ["t3-code", "codex-app"] } });
    writeFileSync(join(xdg, "config.jsonc"), on);
    writeFileSync(join(base, ".harnery", "config.local.jsonc"), on);
    const calls: ScheduleSource[] = [];
    const list = await read([fake("t3-code", [], { optIn: true, calls })]);
    expect(calls).toEqual([]);
    expect(list.coverage.find((c) => c.source === "t3-code")?.state).toBe("disabled");
  });

  test("the built-in opt-in readers stay off without the project setting", async () => {
    const optIn = SCHEDULE_READERS.filter((r) => r.id === "t3-code" || r.id === "codex-app");
    const list = await read(optIn);
    expect(list.coverage.find((c) => c.source === "t3-code")?.state).toBe("disabled");
    expect(list.coverage.find((c) => c.source === "codex-app")?.state).toBe("disabled");
  });

  test("records merge on source, account and id", async () => {
    const list = await read([
      fake("harnery", [record("harnery", "a", "first"), record("harnery", "a", "second")]),
      fake("os-timer", [record("os-timer", "a")]),
    ]);
    expect(list.records.map((r) => `${r.source}:${r.id}:${r.title}`)).toEqual([
      "harnery:a:first",
      "os-timer:a:a",
    ]);
  });

  test("a reader's invalid answer is unreadable", async () => {
    const bad = { ...record("harnery", "a"), prompt: "do the thing" } as unknown as ScheduleRecord;
    const list = await read([fake("harnery", [bad])]);
    expect(list.coverage.find((c) => c.source === "harnery")?.state).toBe("unreadable");
    expect(JSON.stringify(list)).not.toContain("do the thing");
  });

  test("observations attach created_by and add captured records", async () => {
    projectConfig({ schedule: { readers: ["t3-code"] } });
    observe([
      observation({}),
      observation({
        tool: "claude-code.cron_create",
        native_id: "cron-live",
        instance_id: "inst-live",
        expires_with_session: true,
      }),
      observation({
        tool: "claude-code.cron_create",
        native_id: "cron-dead",
        instance_id: "inst-dead",
        expires_with_session: true,
      }),
      observation({ tool: "claude-code.remote_trigger", native_id: "trig-1", instance_id: "x" }),
      // An observation for another source with the same id does not attach.
      observation({ tool: "claude-code.cron_create", native_id: "h-1" }),
    ]);
    const list = await read(
      [
        fake("t3-code", [record("t3-code", "t3-1"), record("t3-code", "t3-2")], { optIn: true }),
        fake("harnery", [record("harnery", "h-1")]),
      ],
      { live: new Set(["inst-live"]) },
    );
    const byKey = new Map(list.records.map((r) => [`${r.source}:${r.id}`, r]));
    expect(byKey.get("t3-code:t3-1")?.created_by).toEqual({
      instance_id: "inst-live",
      agent_name: "agent-Ada",
      task: "set up the nightly check",
      observed_at: "2026-11-21T10:00:00.000Z",
    });
    expect(byKey.get("t3-code:t3-2")?.created_by).toBeNull();
    expect(byKey.get("harnery:h-1")?.created_by).toBeNull();
    expect(byKey.has("captured:cron-live")).toBe(true);
    expect(byKey.has("captured:cron-dead")).toBe(false);
    expect(byKey.has("captured:trig-1")).toBe(true);
    expect(byKey.has("captured:t3-1")).toBe(false);
  });
});
