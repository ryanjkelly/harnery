import { describe, expect, test } from "bun:test";
import {
  describeScheduleEnrollment,
  describeScheduleJobWork,
  formatScheduleArgv,
  formatScheduleDuration,
} from "./describe-job.ts";
import type { ScheduleHarneryJob } from "./types.ts";

const base: ScheduleHarneryJob = {
  commands: [],
  agent: null,
  enrollment: { state: "enrolled", detail: null, enrolled_at: "2026-11-20T00:00:00.000Z" },
  owner: null,
  timeout_minutes: 10,
  max_launches_per_day: 2,
  zone: "UTC",
  latest_run: null,
};
const cmd = (name: string, argv: string[]) => ({ name, argv, env: [], finding_exit_codes: [] });
const agent = { adapter: "codex", model: "m-1", effort: "medium", prompt: "p" };

describe("describeScheduleJobWork", () => {
  test("names a single script with no agent", () => {
    expect(describeScheduleJobWork({ ...base, commands: [cmd("sync", ["scripts/sync.sh"])] })).toBe(
      "Runs a script: scripts/sync.sh · no AI agent",
    );
  });
  test("counts commands before the judging agent", () => {
    const job = { ...base, commands: [cmd("a", ["a"]), cmd("b", ["b"]), cmd("c", ["c"])], agent };
    expect(describeScheduleJobWork(job)).toBe(
      "Runs 3 commands, then a codex agent (m-1, medium) judges the output",
    );
  });
  test("an agent-only job says no commands run first", () => {
    expect(
      describeScheduleJobWork({ ...base, agent: { ...agent, model: null, effort: null } }),
    ).toBe("Starts a codex agent (default model, default effort) · no commands run first");
  });
});

describe("describeScheduleEnrollment", () => {
  const rec = { account: "box", runs_on: { host: "box" } };
  test("reads each state in plain words", () => {
    expect(describeScheduleEnrollment(rec, base)).toBe("Enrolled on this machine and checkout");
    expect(
      describeScheduleEnrollment(rec, {
        ...base,
        enrollment: { state: "changed", detail: "x", enrolled_at: null },
      }),
    ).toBe("Changed since enrollment; stopped until enrolled again");
  });
  test("a job for another host says so first", () => {
    expect(describeScheduleEnrollment({ account: "box", runs_on: { host: "srv" } }, base)).toBe(
      "For host srv; it does not run on this machine (box)",
    );
  });
});

test("argv and duration formatting", () => {
  expect(formatScheduleArgv(["bin/x", "hello world", "--n=1"])).toBe('bin/x "hello world" --n=1');
  expect(formatScheduleDuration(41_000)).toBe("41s");
  expect(formatScheduleDuration(125_000)).toBe("2m 5s");
  expect(formatScheduleDuration(3_780_000)).toBe("1h 3m");
});
