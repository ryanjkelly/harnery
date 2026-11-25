import { describe, expect, test } from "bun:test";
import {
  describeScheduleEnrollment,
  describeScheduleWork,
  formatScheduleArgv,
  formatScheduleCommand,
  formatScheduleDuration,
  scheduleCommandHeadline,
} from "./describe-work.ts";
import type { ScheduleCommand, ScheduleHarneryJob, ScheduleWork } from "./types.ts";

const base: ScheduleHarneryJob = {
  enrollment: { state: "enrolled", detail: null, enrolled_at: "2026-11-20T00:00:00.000Z" },
  owner: null,
  timeout_minutes: 10,
  max_launches_per_day: 2,
  zone: "UTC",
  latest_run: null,
};
const cmd = (name: string, argv: string[]): ScheduleCommand => ({
  name,
  argv,
  line: null,
  env: [],
  finding_exit_codes: [],
});
const line = (text: string): ScheduleCommand => ({
  name: null,
  argv: null,
  line: text,
  env: [],
  finding_exit_codes: [],
});
const agent = { adapter: "codex", model: "m-1", effort: "medium", prompt: "p" };
const work = (w: Partial<ScheduleWork>): ScheduleWork => ({
  commands: [],
  agent: null,
  redacted: false,
  ...w,
});

describe("describeScheduleWork", () => {
  test("names a single script with no agent", () => {
    expect(describeScheduleWork(work({ commands: [cmd("sync", ["scripts/sync.sh"])] }))).toBe(
      "Runs: sync.sh",
    );
  });
  test("counts commands before the judging agent", () => {
    const w = work({ commands: [cmd("a", ["a"]), cmd("b", ["b"]), cmd("c", ["c"])], agent });
    expect(describeScheduleWork(w)).toBe(
      "Runs 3 commands, then a codex agent (m-1, medium) judges the output",
    );
  });
  test("an agent-only schedule shows the prompt's first line", () => {
    expect(
      describeScheduleWork(
        work({
          agent: { ...agent, model: null, effort: null, prompt: "\n  Check the logs.\nMore" },
        }),
      ),
    ).toBe("Starts a codex agent (default model, default effort): Check the logs.");
    const long = "x".repeat(200);
    expect(describeScheduleWork(work({ agent: { ...agent, prompt: long } }))).toHaveLength(
      "Starts a codex agent (m-1, medium): ".length + 80,
    );
  });
});

describe("scheduleCommandHeadline", () => {
  test.each([
    [cmd("x", ["/bin/bash", "/home/u/scripts/dev/local-dev-heal.sh"]), "local-dev-heal.sh"],
    [cmd("x", ["/usr/bin/env", "A=1", "node", "dist/main.js", "--once"]), "main.js"],
    [line("cd /srv/app && ./backup.sh --full >/dev/null 2>&1"), "backup.sh"],
    [line("FOO=1 python3 -u tools/sync.py"), "sync.py"],
    [cmd("probe", ["--only-flags"]), "probe"],
  ])("%#", (command, expected) => {
    expect(scheduleCommandHeadline(command)).toBe(expected);
  });
});

test("formatScheduleCommand prints argv quoted and lines unchanged", () => {
  expect(formatScheduleCommand(cmd("a", ["x", "a b"]))).toBe('x "a b"');
  expect(formatScheduleCommand(line("a  'b c'"))).toBe("a  'b c'");
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
