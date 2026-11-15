import { describe, expect, test } from "bun:test";
import { plainStatusAttention, statusBoxRows } from "../../../commands/agents.ts";
import {
  containsFencedPlainStatus,
  formatPlainStatus,
  formatPlainStatusFull,
  type PlainStatusInput,
  plainPeersSentence,
  STATUS_PROBLEM_ROWS,
  type StatusProblemRow,
  textHasPlainStatusHead,
} from "./status-plain.ts";

const base: PlainStatusInput = {
  name: "Maya",
  task: "Fix the table",
  state: "active",
  stateReason: null,
  otherAgents: 4,
  overlaps: [],
  time: "9:41 AM CDT",
  attention: [],
};

describe("formatPlainStatus", () => {
  test("in progress: two lines, no box drawing", () => {
    const out = formatPlainStatus(base);
    expect(out).toBe(
      [
        "◇ Maya · working on: Fix the table · still in progress",
        "4 other agents are active; none is using the same files · 9:41 AM CDT",
      ].join("\n"),
    );
    expect(out).not.toMatch(/[┌│└─]/u);
  });

  test("waiting names the reason; finished says finished", () => {
    expect(
      formatPlainStatus({ ...base, state: "blocked", stateReason: "needs a sign-in" }).split(
        "\n",
      )[0],
    ).toBe("◇ Maya · working on: Fix the table · waiting on something: needs a sign-in");
    expect(formatPlainStatus({ ...base, state: "blocked" }).split("\n")[0]).toEndWith(
      "· waiting on something",
    );
    expect(formatPlainStatus({ ...base, state: "done" }).split("\n")[0]).toEndWith("· finished");
  });

  test("a problem adds a third line and never more", () => {
    const out = formatPlainStatus({
      ...base,
      attention: [
        "this conversation has used 85% of its memory",
        "this computer is busy: high load",
      ],
    });
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(
      "Heads up: this conversation has used 85% of its memory; this computer is busy: high load",
    );
  });

  test("no task and no other agents read naturally", () => {
    const out = formatPlainStatus({ ...base, task: "", otherAgents: 0 });
    expect(out).toBe(
      "◇ Maya · no task named yet · still in progress\nNo other agents are active · 9:41 AM CDT",
    );
  });

  test("terminal escapes in stored text are removed", () => {
    expect(formatPlainStatus({ ...base, task: "Fix\u001b[31m it\nnow" })).toContain(
      "working on: Fix it now",
    );
  });
});

describe("plainPeersSentence", () => {
  test("warns only when a peer holds a file this session touched", () => {
    expect(plainPeersSentence(1, [])).toBe(
      "1 other agent is active; it is not using the same files",
    );
    expect(plainPeersSentence(3, [{ name: "Owen", sharedFiles: ["parser.ts"] }])).toBe(
      "3 other agents are active; careful: Owen is also using parser.ts",
    );
    expect(
      plainPeersSentence(5, [
        { name: "Owen", sharedFiles: ["a.ts", "b.ts"] },
        { name: "Ines", sharedFiles: ["b.ts", "c.ts", "d.ts"] },
      ]),
    ).toBe(
      "5 other agents are active; careful: Owen and Ines are also using a.ts, b.ts, c.ts, and 1 more",
    );
  });
});

describe("formatPlainStatusFull", () => {
  test("--full lists every fact on its own labelled line, time last", () => {
    const lines = formatPlainStatusFull({
      ...base,
      attention: ["this session will close after this turn"],
      fullTime: "Sat, Oct 31, 2026, 9:41 AM CDT",
      sessionLength: "15m",
      turnLength: "12s",
      changes: "+3 / -1 lines",
      activity: "working",
      startedBy: "unknown: not recorded",
      memory: "120K / 200K (60%)",
      computer: "No contention.",
      filesHeld: ["table.ts"],
      peerNames: ["Owen", "Ines"],
    }).split("\n");
    expect(lines[0]).toStartWith("◇ Maya · ");
    expect(lines.map((l) => l.split(":")[0])).toEqual([
      lines[0]!.split(":")[0],
      "Session length",
      "This turn",
      "Changes this turn",
      "Doing right now",
      "Started by",
      "Conversation memory",
      "Computer",
      "Files this agent holds",
      "Other agents",
      "Heads up",
      "Time",
    ]);
    expect(lines.join("\n")).not.toMatch(/[┌│└]/u);
  });
});

describe("containsFencedPlainStatus", () => {
  const plain = formatPlainStatus(base);
  const fenced = (body: string, info = "") => `Done.\n\n\`\`\`${info}\n${body}\n\`\`\`\n`;

  test("accepts the pasted output in a fence, with or without an info string", () => {
    expect(containsFencedPlainStatus(fenced(plain))).toBe(true);
    expect(containsFencedPlainStatus(fenced(plain, "text"))).toBe(true);
    expect(containsFencedPlainStatus(`~~~\n${plain}\n~~~`)).toBe(true);
    expect(
      containsFencedPlainStatus(fenced(formatPlainStatus({ ...base, attention: ["x"] }))),
    ).toBe(true);
  });

  test("rejects the same text outside a fence or an unclosed fence", () => {
    expect(containsFencedPlainStatus(plain)).toBe(false);
    expect(containsFencedPlainStatus(`\`\`\`\n${plain}\n`)).toBe(false);
  });

  test("rejects a head line alone, a broken block, or a block without the clock", () => {
    const [head, second] = plain.split("\n");
    expect(containsFencedPlainStatus(fenced(head!))).toBe(false);
    expect(containsFencedPlainStatus(fenced(`${head}\n\n${second}`))).toBe(false);
    expect(containsFencedPlainStatus(fenced(`${head}\n4 other agents are active`))).toBe(false);
    expect(containsFencedPlainStatus(fenced(`◇ Maya\n${second}`))).toBe(false);
  });

  test("the loose head signal matches only a structured head", () => {
    expect(textHasPlainStatusHead(plain)).toBe(true);
    expect(textHasPlainStatusHead("◇ a diamond in prose")).toBe(false);
  });
});

describe("box problem row coverage", () => {
  type AttentionInput = Parameters<typeof plainStatusAttention>[0];
  const none: AttentionInput = {
    parentProblem: false,
    parent: "",
    contextPercent: null,
    resources: null,
    quality: null,
    qa: null,
    sync: null,
    sessionEnd: null,
  };
  const cases = {
    parent: {
      input: { parentProblem: true, parent: "conflict" },
      sentence: "the record of which agent started this one conflicts (conflict)",
    },
    context: {
      input: { contextPercent: 86 },
      sentence: "this conversation has used 86% of its memory, so it will need a fresh start soon",
    },
    resources: {
      input: {
        resources: { assessment: { state: "critical", summary: "Memory is nearly full." } },
      },
      sentence: "this computer is badly overloaded: Memory is nearly full.",
    },
    quality: {
      input: { quality: { status: "attention", signal_ids: ["retry-loop"] } },
      sentence: "the work quality check wants a look (retry-loop)",
    },
    qa: { input: { qa: "pass 2m ago" }, sentence: "latest page check: pass 2m ago" },
    sync: {
      input: { sync: { outcome: "failed" } as AttentionInput["sync"] },
      sentence: "tried to bring in other people's latest changes before finishing, but it failed",
    },
    "session end": {
      input: { sessionEnd: "queued" },
      sentence: "this session will close after this turn",
    },
  } satisfies Record<StatusProblemRow, { input: Partial<AttentionInput>; sentence: string }>;

  test("every shared problem identifier has a case and exactly one plain sentence", () => {
    expect(Object.keys(cases)).toEqual([...STATUS_PROBLEM_ROWS]);
    for (const row of STATUS_PROBLEM_ROWS) {
      const { input, sentence } = cases[row];
      expect(plainStatusAttention({ ...none, ...input })).toEqual([sentence]);
    }
  });

  test("conditional diagnostic rows in the box belong to the shared identifiers", () => {
    const box = {
      full: false,
      session: "15m",
      turn: null,
      changes: "none",
      task: "",
      activity: "working",
      lifecycle: "active",
      parent: "conflict",
      context: "86%",
      resources: "busy",
      files: "0 held",
      peers: "none",
      time: "9:41 AM CDT",
    };
    const ordinary = new Set(
      statusBoxRows({
        ...box,
        parentProblem: false,
        contextProblem: false,
        resourcesProblem: false,
      }).map(([id]) => id),
    );
    const problems = statusBoxRows({
      ...box,
      parentProblem: true,
      contextProblem: true,
      resourcesProblem: true,
    })
      .filter(([id]) => !ordinary.has(id))
      .map(([id]) => id);
    expect(problems).toEqual(
      STATUS_PROBLEM_ROWS.filter((id) => ["parent", "context", "resources"].includes(id)),
    );
  });
});
