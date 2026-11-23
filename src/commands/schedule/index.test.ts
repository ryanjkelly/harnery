import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { EmitContext } from "../../commander.ts";
import { registerScheduleCommand } from "./index.ts";

const emit = { emit: () => {} } as unknown as EmitContext;

describe("registerScheduleCommand", () => {
  test("registers the schedule command once with every subcommand once", () => {
    const program = new Command("harn");
    registerScheduleCommand(program, emit);
    const schedules = program.commands.filter((c) => c.name() === "schedule");
    expect(schedules).toHaveLength(1);
    const names = schedules[0]?.commands.map((c) => c.name()) ?? [];
    const expected = [
      "list",
      "show",
      "add",
      "enroll",
      "pause",
      "resume",
      "remove",
      "run",
      "history",
      "tick",
      "install",
      "uninstall",
      "timer-status",
    ];
    expect([...names].sort()).toEqual([...expected].sort());
    expect(new Set(names).size).toBe(names.length);
  });
});
