import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedScheduleRecords,
  captureScheduleToolCall,
  isScheduleToolName,
  readScheduleObservations,
  SCHEDULE_OBSERVATIONS_MAX_LINES,
  type ScheduleToolCall,
  scheduleObservationFromToolCall,
  scheduleObservationKey,
  scheduleObservationsById,
} from "./capture.ts";
import { scheduleObservedPath } from "./paths.ts";
import {
  type ScheduleObservation,
  validateScheduleObservation,
  validateScheduleRecord,
} from "./types.ts";

const PROMPT = "SECRET-PROMPT-zq81 please read the inbox and email Bob";
const T3_ID = "scheduled-task:e1a523a6-41b6-4205-8d71-b22491f76a22";
const AT = "2026-11-22T18:00:00.000Z";

function call(overrides: Partial<ScheduleToolCall>): ScheduleToolCall {
  return {
    toolName: "CronCreate",
    toolInput: {},
    toolResponse: "",
    instanceId: "inst-1",
    agentName: "agent-Test",
    task: "Testing capture",
    observedAt: AT,
    ...overrides,
  };
}

const t3Input = {
  title: "Morning check",
  prompt: PROMPT,
  enabled: false,
  schedule: { type: "once", runAt: "2027-01-01T12:00:00.000Z" },
};
const t3Result = {
  scheduledTaskId: T3_ID,
  title: "Morning check",
  prompt: PROMPT,
  enabled: false,
  projectId: "838bbe65-ca06-44c1-ae90-3604831ddcc6",
  boundThreadId: "72262e65-1579-4aab-8f77-2d15f10b6a26",
  freshSession: false,
  schedule: { type: "once", runAt: "2027-01-01T12:00:00.000Z" },
  nextRunAt: null,
  lastRunStatus: "never",
};
const cronText =
  "Scheduled one-shot task 72490f3c (17 3 1 1 *). Next run: Jan 1 3:17am. Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete.";

function valid(o: ScheduleObservation | null): ScheduleObservation {
  expect(o).not.toBeNull();
  const v = validateScheduleObservation(o);
  expect(v.ok).toBe(true);
  return o as ScheduleObservation;
}

describe("isScheduleToolName", () => {
  test("matches every schedule tool in both T3 spellings", () => {
    for (const name of [
      "mcp__t3-code__schedule_task",
      "mcp__t3_code__schedule_task",
      "mcp__t3-code__delete_scheduled_task",
      "mcp__t3_code__delete_scheduled_task",
      "CronCreate",
      "CronDelete",
      "RemoteTrigger",
    ]) {
      expect(isScheduleToolName(name)).toBe(true);
    }
  });
  test("rejects other tools", () => {
    for (const name of [
      undefined,
      "",
      "Bash",
      "CronList",
      "mcp__t3-code__list_scheduled_tasks",
      "mcp__t3-code__run_scheduled_task_now",
      "mcp__t3-code__schedule_task_x",
      "mcp__other__schedule_task",
    ]) {
      expect(isScheduleToolName(name)).toBe(false);
    }
  });
});

describe("T3 Code schedule_task", () => {
  const shapes: [string, unknown][] = [
    ["object", t3Result],
    ["JSON string", JSON.stringify(t3Result)],
    ["content blocks", [{ type: "text", text: JSON.stringify(t3Result) }]],
    ["wrapped content", { content: [{ type: "text", text: JSON.stringify(t3Result) }] }],
  ];
  for (const toolName of ["mcp__t3-code__schedule_task", "mcp__t3_code__schedule_task"]) {
    for (const [label, toolResponse] of shapes) {
      test(`${toolName} with result as ${label}`, () => {
        const o = valid(
          scheduleObservationFromToolCall(call({ toolName, toolInput: t3Input, toolResponse })),
        );
        expect(o.tool).toBe("t3-code.schedule_task");
        expect(o.operation).toBe("create");
        expect(o.native_id).toBe(T3_ID);
        expect(o.title).toBe("Morning check");
        expect(o.trigger).toEqual({
          kind: "once",
          at: "2027-01-01T12:00:00.000Z",
          raw: "once 2027-01-01T12:00:00.000Z",
        });
        expect(o.expires_with_session).toBe(false);
        expect(o.agent_name).toBe("agent-Test");
        expect(o.task).toBe("Testing capture");
      });
    }
  }

  test("an input id makes an update, and the input id is the fallback", () => {
    const o = valid(
      scheduleObservationFromToolCall(
        call({
          toolName: "mcp__t3-code__schedule_task",
          toolInput: { scheduledTaskId: T3_ID, enabled: true },
          toolResponse: "ok",
        }),
      ),
    );
    expect(o.operation).toBe("update");
    expect(o.native_id).toBe(T3_ID);
    expect(o.title).toBeNull();
    expect(o.trigger).toBeNull();
  });

  test("maps interval, fixed_time and webhook schedules", () => {
    const map = (schedule: unknown) =>
      valid(
        scheduleObservationFromToolCall(
          call({
            toolName: "mcp__t3-code__schedule_task",
            toolInput: { title: "t", prompt: PROMPT, schedule },
            toolResponse: { scheduledTaskId: T3_ID },
          }),
        ),
      ).trigger;
    expect(map({ type: "interval", everyMs: 3_600_000 })).toEqual({
      kind: "interval",
      everyMs: 3_600_000,
      raw: "interval 3600000ms",
    });
    expect(map({ type: "fixed_time", timeOfDay: "09:05", weekdays: [5, 1, 3] })).toEqual({
      kind: "cron",
      expr: "5 9 * * 1,3,5",
      raw: "fixed_time 09:05 weekdays 1,3,5",
    });
    expect(
      map({ type: "fixed_time", timeOfDay: "23:30", weekdays: [0, 1, 2, 3, 4, 5, 6] }),
    ).toEqual({ kind: "cron", expr: "30 23 * * *", raw: "fixed_time 23:30" });
    expect(map({ type: "webhook" })).toEqual({
      kind: "event",
      description: "webhook",
      raw: "webhook",
    });
    expect(map({ type: "fixed_time", timeOfDay: "25:00" })).toBeNull();
  });

  test("a failed call returns null", () => {
    const base = { toolName: "mcp__t3-code__schedule_task", toolInput: t3Input };
    expect(scheduleObservationFromToolCall(call({ ...base, toolResponse: "Error: bad" }))).toBe(
      null,
    );
    expect(
      scheduleObservationFromToolCall(
        call({
          ...base,
          toolResponse: { isError: true, content: [{ type: "text", text: "boom" }] },
        }),
      ),
    ).toBeNull();
    expect(
      scheduleObservationFromToolCall(
        call({
          toolName: "mcp__t3-code__schedule_task",
          toolInput: { scheduledTaskId: T3_ID },
          toolResponse: { isError: true, content: [] },
        }),
      ),
    ).toBeNull();
  });
});

describe("T3 Code delete_scheduled_task", () => {
  for (const toolName of [
    "mcp__t3-code__delete_scheduled_task",
    "mcp__t3_code__delete_scheduled_task",
  ]) {
    test(toolName, () => {
      const o = valid(
        scheduleObservationFromToolCall(
          call({ toolName, toolInput: { scheduledTaskId: T3_ID }, toolResponse: "{}" }),
        ),
      );
      expect(o.tool).toBe("t3-code.delete_scheduled_task");
      expect(o.operation).toBe("delete");
      expect(o.native_id).toBe(T3_ID);
    });
  }
});

describe("CronCreate and CronDelete", () => {
  for (const [label, toolResponse] of [
    ["text", cronText],
    ["content blocks", [{ type: "text", text: cronText }]],
    ["recurring wording", "Scheduled recurring task ab12cd34 (*/5 * * * *). Next run: soon."],
  ] as [string, unknown][]) {
    test(`CronCreate result as ${label}`, () => {
      const o = valid(
        scheduleObservationFromToolCall(
          call({
            toolName: "CronCreate",
            toolInput: { cron: "17 3 1 1 *", prompt: PROMPT, recurring: false },
            toolResponse,
          }),
        ),
      );
      expect(o.tool).toBe("claude-code.cron_create");
      expect(o.operation).toBe("create");
      expect(o.native_id).toBe(label === "recurring wording" ? "ab12cd34" : "72490f3c");
      expect(o.trigger).toEqual({ kind: "cron", expr: "17 3 1 1 *", raw: "17 3 1 1 *" });
      expect(o.expires_with_session).toBe(true);
      expect(o.title).toBeNull();
    });
  }

  test("CronCreate without an id in the result returns null", () => {
    expect(
      scheduleObservationFromToolCall(
        call({ toolName: "CronCreate", toolInput: { cron: "* * * * *" }, toolResponse: "nope" }),
      ),
    ).toBeNull();
  });

  test("CronDelete", () => {
    const o = valid(
      scheduleObservationFromToolCall(
        call({
          toolName: "CronDelete",
          toolInput: { id: "72490f3c" },
          toolResponse: "Cancelled 72490f3c",
        }),
      ),
    );
    expect(o.operation).toBe("delete");
    expect(o.native_id).toBe("72490f3c");
    expect(o.expires_with_session).toBe(true);
  });
});

describe("RemoteTrigger", () => {
  const body = { name: "Nightly digest", cron_expression: "0 6 * * 1-5", prompt: PROMPT };
  const createText = `HTTP 200\n${JSON.stringify({ id: "trig_01ABC", name: "Nightly digest", cron_expression: "0 6 * * 1-5", prompt: PROMPT }, null, 2)}\nCreated routine trig_01ABC.`;

  test("create reads the id, title and cron from the result and body", () => {
    for (const toolResponse of [createText, [{ type: "text", text: createText }]]) {
      const o = valid(
        scheduleObservationFromToolCall(
          call({ toolName: "RemoteTrigger", toolInput: { action: "create", body }, toolResponse }),
        ),
      );
      expect(o.tool).toBe("claude-code.remote_trigger");
      expect(o.operation).toBe("create");
      expect(o.native_id).toBe("trig_01ABC");
      expect(o.title).toBe("Nightly digest");
      expect(o.trigger).toEqual({ kind: "cron", expr: "0 6 * * 1-5", raw: "0 6 * * 1-5" });
      expect(o.expires_with_session).toBe(false);
    }
  });

  test("update takes the input trigger_id", () => {
    const o = valid(
      scheduleObservationFromToolCall(
        call({
          toolName: "RemoteTrigger",
          toolInput: { action: "update", trigger_id: "trig_9", body: { prompt: PROMPT } },
          toolResponse: 'HTTP 200\n{"ok":true}',
        }),
      ),
    );
    expect(o.operation).toBe("update");
    expect(o.native_id).toBe("trig_9");
    expect(o.trigger).toBeNull();
  });

  test("create with no id found still observes, with a null id", () => {
    const o = valid(
      scheduleObservationFromToolCall(
        call({
          toolName: "RemoteTrigger",
          toolInput: { action: "create", body: { prompt: PROMPT } },
          toolResponse: "HTTP 201\nnot json\nsummary",
        }),
      ),
    );
    expect(o.native_id).toBeNull();
  });

  test("create_webhook_trigger", () => {
    const o = valid(
      scheduleObservationFromToolCall(
        call({
          toolName: "RemoteTrigger",
          toolInput: { action: "create_webhook_trigger", trigger_id: "trig_5" },
          toolResponse: 'HTTP 200\n{"url":"https://example.invalid/hook"}',
        }),
      ),
    );
    expect(o.native_id).toBe("trig_5");
    expect(o.trigger?.kind).toBe("event");
    expect(JSON.stringify(o)).not.toContain("example.invalid");
  });

  test("read-only actions and failures return null", () => {
    for (const action of ["list", "get", "run", "list_runs", "get_run_log"]) {
      expect(
        scheduleObservationFromToolCall(
          call({
            toolName: "RemoteTrigger",
            toolInput: { action },
            toolResponse: 'HTTP 200\n{"data":[],"has_more":false}',
          }),
        ),
      ).toBeNull();
    }
    expect(
      scheduleObservationFromToolCall(
        call({
          toolName: "RemoteTrigger",
          toolInput: { action: "create", body },
          toolResponse: 'HTTP 400\n{"error":"bad"}',
        }),
      ),
    ).toBeNull();
    expect(
      scheduleObservationFromToolCall(
        call({
          toolName: "RemoteTrigger",
          toolInput: { action: "create", body },
          toolResponse: "network down",
        }),
      ),
    ).toBeNull();
  });
});

test("no tool's observation carries the prompt", () => {
  const calls: ScheduleToolCall[] = [
    call({ toolName: "mcp__t3-code__schedule_task", toolInput: t3Input, toolResponse: t3Result }),
    call({
      toolName: "mcp__t3_code__delete_scheduled_task",
      toolInput: { scheduledTaskId: T3_ID, prompt: PROMPT },
      toolResponse: { ok: true, prompt: PROMPT },
    }),
    call({
      toolName: "CronCreate",
      toolInput: { cron: "17 3 1 1 *", prompt: PROMPT },
      toolResponse: `${cronText} ${PROMPT}`,
    }),
    call({
      toolName: "CronDelete",
      toolInput: { id: "72490f3c", prompt: PROMPT },
      toolResponse: PROMPT,
    }),
    call({
      toolName: "RemoteTrigger",
      toolInput: { action: "create", body: { name: "n", prompt: PROMPT } },
      toolResponse: `HTTP 200\n${JSON.stringify({ id: "trig_1", prompt: PROMPT })}\n${PROMPT}`,
    }),
  ];
  for (const c of calls) {
    const o = valid(scheduleObservationFromToolCall(c));
    expect(JSON.stringify(o)).not.toContain("SECRET-PROMPT");
  }
});

describe("file capture", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "harnery-capture-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("appends a private line and reads it back", () => {
    const o = captureScheduleToolCall({
      ...call({
        toolName: "CronCreate",
        toolInput: { cron: "17 3 1 1 *" },
        toolResponse: cronText,
      }),
      coordRoot: root,
    });
    expect(o).not.toBeNull();
    expect(captureScheduleToolCall({ ...call({ toolName: "Bash" }), coordRoot: root })).toBeNull();
    const path = scheduleObservedPath(root);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0);
    expect(readScheduleObservations(root)).toEqual([o as ScheduleObservation]);
  });

  test("never throws, and reads a missing file as empty", () => {
    expect(readScheduleObservations(root)).toEqual([]);
    const blocker = join(root, "file");
    writeFileSync(blocker, "x");
    expect(
      captureScheduleToolCall({
        ...call({ toolName: "CronDelete", toolInput: { id: "abc" } }),
        coordRoot: blocker,
      }),
    ).toBeNull();
  });

  test("skips corrupt and invalid lines", () => {
    const first = captureScheduleToolCall({
      ...call({ toolName: "CronDelete", toolInput: { id: "abc" } }),
      coordRoot: root,
    });
    const path = scheduleObservedPath(root);
    writeFileSync(path, `${readFileSync(path, "utf8")}{not json\n{"schema_version":2}\n\n`);
    captureScheduleToolCall({
      ...call({ toolName: "CronDelete", toolInput: { id: "def" } }),
      coordRoot: root,
    });
    const read = readScheduleObservations(root);
    expect(read.map((o) => o.native_id)).toEqual([first?.native_id ?? "", "def"]);
  });

  test("keeps the newest lines when the file grows past the bound", () => {
    const total = SCHEDULE_OBSERVATIONS_MAX_LINES + 7;
    for (let i = 0; i < total; i++) {
      captureScheduleToolCall({
        ...call({ toolName: "CronDelete", toolInput: { id: `id${i}` } }),
        coordRoot: root,
      });
    }
    const read = readScheduleObservations(root);
    expect(read.length).toBe(SCHEDULE_OBSERVATIONS_MAX_LINES);
    expect(read[0]?.native_id).toBe(`id${total - SCHEDULE_OBSERVATIONS_MAX_LINES}`);
    expect(read.at(-1)?.native_id).toBe(`id${total - 1}`);
  });
});

function obs(partial: Partial<ScheduleObservation>): ScheduleObservation {
  return {
    schema_version: 1,
    observed_at: AT,
    instance_id: "inst-1",
    tool: "claude-code.cron_create",
    operation: "create",
    native_id: "c1",
    title: null,
    trigger: { kind: "cron", expr: "* * * * *", raw: "* * * * *" },
    expires_with_session: true,
    ...partial,
  };
}

describe("capturedScheduleRecords", () => {
  test("replays creates, updates and deletes in time order", () => {
    const records = capturedScheduleRecords(
      [
        // Out of order on purpose: the delete is newest.
        obs({
          observed_at: "2026-11-22T18:05:00Z",
          operation: "delete",
          native_id: "c1",
          tool: "claude-code.cron_delete",
        }),
        obs({ observed_at: "2026-11-22T18:00:00Z", native_id: "c1" }),
        obs({ observed_at: "2026-11-22T18:01:00Z", native_id: "c2", instance_id: "inst-2" }),
        obs({
          observed_at: "2026-11-22T18:02:00Z",
          tool: "claude-code.remote_trigger",
          native_id: "t1",
          title: "Digest",
          expires_with_session: false,
          instance_id: "inst-3",
        }),
        obs({
          observed_at: "2026-11-22T18:03:00Z",
          tool: "claude-code.remote_trigger",
          operation: "update",
          native_id: "t1",
          title: null,
          trigger: { kind: "cron", expr: "0 6 * * *", raw: "0 6 * * *" },
          expires_with_session: false,
          instance_id: "inst-4",
        }),
        obs({
          tool: "t3-code.schedule_task",
          native_id: "scheduled-task:x",
          expires_with_session: false,
        }),
      ],
      { machine: "box" },
    );
    expect(records.map((r) => r.id).sort()).toEqual(["c2", "t1"]);
    for (const r of records) {
      expect(validateScheduleRecord(r).ok).toBe(true);
      expect(r.source).toBe("captured");
      expect(r.account).toBe("box");
      expect(r.runs_on).toEqual({ host: "box" });
      expect(r.enabled).toBeNull();
    }
    const t1 = records.find((r) => r.id === "t1");
    expect(t1?.title).toBe("Digest");
    expect(t1?.trigger).toEqual({ kind: "cron", expr: "0 6 * * *", raw: "0 6 * * *" });
    expect(t1?.created_by?.instance_id).toBe("inst-3");
  });

  test("timer and trigger ids do not collide", () => {
    const records = capturedScheduleRecords(
      [
        obs({ native_id: "same" }),
        obs({ tool: "claude-code.remote_trigger", native_id: "same", expires_with_session: false }),
        obs({
          tool: "claude-code.cron_delete",
          operation: "delete",
          native_id: "same",
          observed_at: "2026-11-22T19:00:00Z",
        }),
      ],
      { machine: "box" },
    );
    expect(records.length).toBe(1);
    expect(records[0]?.trigger).toEqual({ kind: "cron", expr: "* * * * *", raw: "* * * * *" });
  });

  test("a null native id gets a stable synthetic id and a placeholder trigger", () => {
    const o = obs({
      tool: "claude-code.remote_trigger",
      native_id: null,
      trigger: null,
      expires_with_session: false,
    });
    const a = capturedScheduleRecords([o], { machine: "box" });
    const b = capturedScheduleRecords([o], { machine: "box" });
    expect(a.length).toBe(1);
    expect(a[0]?.id).toBe(b[0]?.id as string);
    expect(validateScheduleRecord(a[0]).ok).toBe(true);
  });

  test("drops an in-session timer whose session is gone", () => {
    const list = [
      obs({ native_id: "c1", instance_id: "live" }),
      obs({ native_id: "c2", instance_id: "dead" }),
      obs({
        tool: "claude-code.remote_trigger",
        native_id: "t1",
        instance_id: "dead",
        expires_with_session: false,
      }),
    ];
    expect(capturedScheduleRecords(list, { machine: "box" }).length).toBe(3);
    const live = capturedScheduleRecords(list, {
      machine: "box",
      liveInstanceIds: new Set(["live"]),
    });
    expect(live.map((r) => r.id).sort()).toEqual(["c1", "t1"]);
  });
});

test("scheduleObservationsById keeps the oldest create or update per source and id", () => {
  const map = scheduleObservationsById([
    obs({
      tool: "t3-code.schedule_task",
      native_id: "s1",
      instance_id: "new",
      observed_at: "2026-11-22T19:00:00Z",
      operation: "update",
    }),
    obs({
      tool: "t3-code.schedule_task",
      native_id: "s1",
      instance_id: "old",
      observed_at: "2026-11-22T18:00:00Z",
    }),
    obs({
      tool: "t3-code.delete_scheduled_task",
      native_id: "s1",
      operation: "delete",
      observed_at: "2026-11-22T20:00:00Z",
    }),
    obs({ native_id: "c1" }),
    obs({ tool: "claude-code.remote_trigger", native_id: null }),
  ]);
  expect(map.get(scheduleObservationKey("t3-code", "s1"))?.instance_id).toBe("old");
  expect(map.get(scheduleObservationKey("captured", "c1"))?.native_id).toBe("c1");
  expect(map.size).toBe(2);
});
