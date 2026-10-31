import { describe, expect, test } from "bun:test";
import { statusBoxRows } from "./agents.ts";

const base = {
  full: false,
  session: "15m",
  turn: "12s",
  changes: "+3 / -1 lines (recorded edits)",
  task: "Fix the table",
  activity: "working",
  lifecycle: "active",
  parent: "unknown: native_child_identity_unavailable",
  parentProblem: false,
  context: "120K / 200K (60%)",
  contextProblem: false,
  resources: "No contention.",
  resourcesProblem: false,
  files: "0 held",
  peers: "none",
  time: "Sat, Oct 31, 2026, 9:41 AM CDT",
};

describe("statusBoxRows", () => {
  test("the compact box keeps only the rows an operator acts on", () => {
    expect(statusBoxRows(base)).toEqual([
      ["task", "Fix the table"],
      ["lifecycle", "active"],
      ["files", "0 held"],
      ["peers", "none"],
      ["time", "Sat, Oct 31, 2026, 9:41 AM CDT (turn 12s)"],
    ]);
  });

  test("diagnostic rows appear when they report a problem", () => {
    const keys = statusBoxRows({
      ...base,
      parentProblem: true,
      contextProblem: true,
      resourcesProblem: true,
    }).map(([key]) => key);
    expect(keys).toEqual([
      "task",
      "lifecycle",
      "parent",
      "context",
      "resources",
      "files",
      "peers",
      "time",
    ]);
  });

  test("no task and no turn evidence drop those parts", () => {
    const rows = statusBoxRows({ ...base, task: "", turn: null });
    expect(rows[0]).toEqual(["lifecycle", "active"]);
    expect(rows.at(-1)).toEqual(["time", base.time]);
  });

  test("--full keeps every row", () => {
    expect(statusBoxRows({ ...base, full: true }).map(([key]) => key)).toEqual([
      "session",
      "turn",
      "changes",
      "task",
      "activity",
      "lifecycle",
      "parent",
      "context",
      "resources",
      "files",
      "peers",
      "time",
    ]);
  });
});
