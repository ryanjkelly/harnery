import { describe, expect, test } from "bun:test";
import { plainStatusAttention, plainStatusOverlaps, statusBoxRows } from "./agents.ts";

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

describe("plain style problem rows", () => {
  const none = {
    parentProblem: false,
    parent: "",
    contextPercent: null,
    resources: null,
    quality: null,
    qa: null,
    sync: null,
    sessionEnd: null,
  } as const;

  test("nothing wrong means nothing to report", () => {
    expect(plainStatusAttention(none)).toEqual([]);
  });

  test("every conditional box row has a plain sentence", () => {
    const out = plainStatusAttention({
      parentProblem: true,
      parent: "conflict: two parents recorded",
      contextPercent: 86.4,
      resources: { assessment: { state: "critical", summary: "Memory is nearly full." } },
      quality: { status: "attention", signal_ids: ["retry-loop"] },
      qa: "pass 2m ago",
      sync: {
        command: "sync-all",
        outcome: "succeeded",
        exit_code: 0,
        commits_pulled: 3,
        submodules_updated: [],
      } as never,
      sessionEnd: "queued",
    });
    expect(out).toEqual([
      "the record of which agent started this one conflicts (conflict: two parents recorded)",
      "this conversation has used 86% of its memory, so it will need a fresh start soon",
      "this computer is badly overloaded: Memory is nearly full.",
      "the work quality check wants a look (retry-loop)",
      "latest page check: pass 2m ago",
      "brought in other people's latest changes before finishing (3 new changes)",
      "this session will close after this turn",
    ]);
    expect(out.join(" ")).not.toContain("`");
  });

  test("a failed sync and a recorded session end read plainly", () => {
    const out = plainStatusAttention({
      ...none,
      sync: {
        command: "sync-all",
        outcome: "failed",
        exit_code: 1,
        commits_pulled: null,
        submodules_updated: [],
      } as never,
      sessionEnd: "recorded",
    });
    expect(out).toEqual([
      "tried to bring in other people's latest changes before finishing, but it failed",
      "this session is closed",
    ]);
  });

  test("a healthy quality check is not a problem", () => {
    expect(
      plainStatusAttention({ ...none, quality: { status: "healthy", signal_ids: [] } }),
    ).toEqual([]);
  });

  test("overlaps name only peers sharing a file this session touched", () => {
    expect(
      plainStatusOverlaps(
        ["/r/src/a.ts", "/r/src/b.ts"],
        [
          { name: "Owen", files: ["/r/src/b.ts", "/r/src/z.ts"] },
          { name: "Ines", files: ["/r/src/z.ts"] },
        ],
      ),
    ).toEqual([{ name: "Owen", sharedFiles: ["b.ts"] }]);
    expect(plainStatusOverlaps([], [{ name: "Owen", files: ["/r/a.ts"] }])).toEqual([]);
  });
});
