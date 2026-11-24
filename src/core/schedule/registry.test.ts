import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleObservedPath } from "./paths.ts";
import { readAllSchedules, SCHEDULE_READERS, scheduleReaderDisabledReason } from "./registry.ts";
import {
  SCHEDULE_SOURCES,
  type ScheduleObservation,
  type ScheduleReader,
  type ScheduleReaderId,
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
  id: ScheduleReaderId,
  records: ScheduleRecord[],
  opts: { calls?: ScheduleSource[] } = {},
): ScheduleReader {
  return {
    id,
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

function throwing(id: ScheduleReaderId): ScheduleReader {
  return {
    id,
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

  test("every reader runs when no config switches one off", async () => {
    const calls: ScheduleSource[] = [];
    const list = await read([
      fake("t3-code", [record("t3-code", "t3-1")], { calls }),
      fake("codex-app", [], { calls }),
    ]);
    expect(calls).toEqual(["t3-code", "codex-app"]);
    expect(list.coverage.find((c) => c.source === "t3-code")?.state).toBe("current");
    expect(list.coverage.find((c) => c.source === "codex-app")?.state).toBe("current");
    expect(list.records.map((r) => r.id)).toEqual(["t3-1"]);
  });

  test("a reader the project switched off is disabled, named, and never called", async () => {
    projectConfig({ schedule: { disabledReaders: ["t3-code", "codex-app"] } });
    const calls: ScheduleSource[] = [];
    const list = await read([
      fake("t3-code", [record("t3-code", "t3-1")], { calls }),
      throwing("codex-app"),
      fake("os-timer", [], { calls }),
    ]);
    expect(calls).toEqual(["os-timer"]);
    const t3 = list.coverage.find((c) => c.source === "t3-code");
    expect(t3?.state).toBe("disabled");
    expect(t3?.detail).toBe(
      "Switched off by the operator (schedule.disabledReaders in .harnery/config.jsonc).",
    );
    expect(list.coverage.find((c) => c.source === "codex-app")?.state).toBe("disabled");
    expect(list.records).toEqual([]);
  });

  test("a user-global or machine-local setting also switches a reader off", async () => {
    const xdg = join(base, "xdg", "harnery");
    mkdirSync(xdg, { recursive: true });
    writeFileSync(
      join(xdg, "config.jsonc"),
      JSON.stringify({ schedule: { disabledReaders: ["t3-code"] } }),
    );
    writeFileSync(
      join(base, ".harnery", "config.local.jsonc"),
      JSON.stringify({ schedule: { disabledReaders: ["t3-code", "codex-app"] } }),
    );
    const calls: ScheduleSource[] = [];
    const list = await read([fake("t3-code", [], { calls }), fake("codex-app", [], { calls })]);
    expect(calls).toEqual([]);
    expect(list.coverage.find((c) => c.source === "t3-code")?.detail).toBe(
      "Switched off by the operator (schedule.disabledReaders in ~/.config/harnery/config.jsonc and .harnery/config.local.jsonc).",
    );
    expect(list.coverage.find((c) => c.source === "codex-app")?.state).toBe("disabled");
  });

  test("the built-in readers all run by default", () => {
    expect(SCHEDULE_READERS.map((r) => r.id)).toEqual([
      "t3-code",
      "codex-app",
      "os-timer",
      "harnery",
    ]);
    for (const reader of SCHEDULE_READERS)
      expect(scheduleReaderDisabledReason(reader, base)).toBeNull();
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
        fake("t3-code", [record("t3-code", "t3-1"), record("t3-code", "t3-2")]),
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
