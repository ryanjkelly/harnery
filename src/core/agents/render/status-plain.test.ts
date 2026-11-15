import { describe, expect, test } from "bun:test";
import {
  containsFencedPlainStatus,
  formatPlainStatus,
  formatPlainStatusFull,
  type PlainStatusInput,
  plainPeersSentence,
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
