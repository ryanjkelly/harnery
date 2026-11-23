import { describe, expect, test } from "bun:test";
import {
  applyScheduleObservation,
  isScheduleIsoInstant,
  isScheduleRecord,
  type ScheduleObservation,
  type ScheduleRecord,
  scheduleObservationSource,
  scheduleRecordKey,
  validateScheduleObservation,
  validateScheduleReadResult,
  validateScheduleRecord,
  validateScheduleTrigger,
} from "./types.ts";

function record(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    source: "t3-code",
    account: "box-1",
    id: "scheduled-task:abc",
    title: "Nightly check",
    trigger: { kind: "once", at: "2027-01-01T12:00:00.000Z", raw: '{"type":"once"}' },
    runs_on: { host: "box-1", project: "p1", thread: "t1" },
    enabled: false,
    next_run_at: null,
    last_run: null,
    created_by: null,
    ...overrides,
  };
}

function observation(overrides: Partial<ScheduleObservation> = {}): ScheduleObservation {
  return {
    schema_version: 1,
    observed_at: "2026-11-22T10:00:00.000Z",
    instance_id: "inst-1",
    agent_name: "agent-A",
    task: "Set up nightly check",
    tool: "t3-code.schedule_task",
    operation: "create",
    native_id: "scheduled-task:abc",
    title: "Nightly check",
    trigger: { kind: "once", at: "2027-01-01T12:00:00.000Z", raw: "{}" },
    expires_with_session: false,
    ...overrides,
  };
}

describe("ISO instants", () => {
  test("need a time and an explicit zone", () => {
    expect(isScheduleIsoInstant("2026-01-01T06:00:00Z")).toBe(true);
    expect(isScheduleIsoInstant("2026-01-01T06:00:00.123+05:30")).toBe(true);
    expect(isScheduleIsoInstant("2026-01-01T06:00")).toBe(false);
    expect(isScheduleIsoInstant("2026-01-01")).toBe(false);
    expect(isScheduleIsoInstant("2026-13-01T06:00:00Z")).toBe(false);
    expect(isScheduleIsoInstant(123)).toBe(false);
  });
});

describe("validateScheduleRecord", () => {
  test("accepts a full record and one with nulls", () => {
    expect(validateScheduleRecord(record()).ok).toBe(true);
    expect(
      isScheduleRecord(
        record({
          source: "os-timer",
          trigger: { kind: "cron", expr: "0 6 * * *", zone: "UTC", raw: "0 6 * * *" },
          enabled: null,
          next_run_at: "2026-11-23T06:00:00Z",
          last_run: { at: null, status: "unknown" },
          created_by: { instance_id: "i", observed_at: "2026-11-22T10:00:00Z" },
          runs_on: { host: "box-1" },
        }),
      ),
    ).toBe(true);
  });

  test("rejects a prompt or command field by name", () => {
    const v = validateScheduleRecord({ ...record(), prompt: "do things" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors).toContain("record.prompt: is not a known field");
    expect(isScheduleRecord({ ...record(), command: "rm -rf" })).toBe(false);
  });

  test("names each bad field", () => {
    const v = validateScheduleRecord({
      ...record(),
      source: "cursor",
      enabled: "yes",
      next_run_at: "tomorrow",
      last_run: { at: null, status: "great" },
      runs_on: {},
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors.join("\n")).toContain("record.source");
      expect(v.errors.join("\n")).toContain("record.enabled");
      expect(v.errors.join("\n")).toContain("record.next_run_at");
      expect(v.errors.join("\n")).toContain("record.last_run.status");
      expect(v.errors.join("\n")).toContain("record.runs_on.host");
    }
  });

  test("checks each trigger kind", () => {
    expect(validateScheduleTrigger({ kind: "interval", everyMs: 60000, raw: "" }).ok).toBe(true);
    expect(validateScheduleTrigger({ kind: "rrule", rule: "FREQ=DAILY", raw: "" }).ok).toBe(true);
    expect(validateScheduleTrigger({ kind: "event", description: "webhook", raw: "" }).ok).toBe(
      true,
    );
    expect(validateScheduleTrigger({ kind: "interval", everyMs: 0, raw: "" }).ok).toBe(false);
    expect(validateScheduleTrigger({ kind: "once", at: "2026-01-01T00:00:00Z" }).ok).toBe(false);
    expect(validateScheduleTrigger({ kind: "fixed_time", raw: "" }).ok).toBe(false);
  });
});

describe("validateScheduleReadResult", () => {
  test("coverage with zero records is valid", () => {
    const v = validateScheduleReadResult({
      coverage: {
        source: "codex-app",
        account: "box-1",
        state: "disabled",
        detail: "Not turned on in schedule.readers.",
        read_at: "2026-11-22T10:00:00Z",
      },
      records: [],
    });
    expect(v.ok).toBe(true);
  });

  test("missing coverage and a bad record are reported with their index", () => {
    const v = validateScheduleReadResult({ records: [record(), { ...record(), id: "" }] });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors).toContain("result.coverage: must be an object");
      expect(v.errors.some((e) => e.startsWith("result.records[1].id"))).toBe(true);
    }
  });
});

describe("observations", () => {
  test("a valid observation passes and a prompt field fails", () => {
    expect(validateScheduleObservation(observation()).ok).toBe(true);
    expect(
      validateScheduleObservation(observation({ native_id: null, title: null, trigger: null })).ok,
    ).toBe(true);
    const v = validateScheduleObservation({ ...observation(), prompt: "secret" });
    expect(v.ok).toBe(false);
    expect(validateScheduleObservation({ ...observation(), schema_version: 2 }).ok).toBe(false);
    expect(validateScheduleObservation({ ...observation(), tool: "CronCreate" }).ok).toBe(false);
  });

  test("tool families map to sources", () => {
    expect(scheduleObservationSource("t3-code.schedule_task")).toBe("t3-code");
    expect(scheduleObservationSource("t3-code.delete_scheduled_task")).toBe("t3-code");
    expect(scheduleObservationSource("claude-code.cron_create")).toBe("captured");
    expect(scheduleObservationSource("claude-code.remote_trigger")).toBe("captured");
  });
});

describe("join key and created_by merge", () => {
  test("the key is stable and separates its parts", () => {
    expect(scheduleRecordKey(record())).toBe(scheduleRecordKey(record({ title: "Other" })));
    expect(scheduleRecordKey({ source: "t3-code", account: "a|b", id: "c" })).not.toBe(
      scheduleRecordKey({ source: "t3-code", account: "a", id: "b|c" }),
    );
  });

  test("a matching create sets created_by without changing the input", () => {
    const base = record();
    const merged = applyScheduleObservation(base, observation());
    expect(merged.created_by).toEqual({
      instance_id: "inst-1",
      agent_name: "agent-A",
      task: "Set up nightly check",
      observed_at: "2026-11-22T10:00:00.000Z",
    });
    expect(base.created_by).toBeNull();
  });

  test("a delete, another id, another source or an existing creator leaves the record", () => {
    const base = record();
    expect(applyScheduleObservation(base, observation({ operation: "delete" }))).toBe(base);
    expect(applyScheduleObservation(base, observation({ native_id: "other" }))).toBe(base);
    expect(applyScheduleObservation(base, observation({ native_id: null }))).toBe(base);
    expect(applyScheduleObservation(base, observation({ tool: "claude-code.cron_create" }))).toBe(
      base,
    );
    const owned = record({
      created_by: { instance_id: "first", observed_at: "2026-11-01T00:00:00Z" },
    });
    expect(applyScheduleObservation(owned, observation())).toBe(owned);
  });
});
