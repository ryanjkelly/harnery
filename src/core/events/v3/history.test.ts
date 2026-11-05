import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmitContext } from "../../../commander.ts";
import { createHarneryProgram } from "../../../commander.ts";
import {
  countEventHistoryV3,
  listEventHistoryEpochsV3,
  parseHistoryInstantV3,
  scanEventHistoryV3,
} from "./history.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function event(
  id: string,
  type: string,
  at: string,
  instance: string,
  payload: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    event_id: id,
    event_type: type,
    payload,
    producer: { component: "agent-hook" },
    scope: { instance_id: instance },
    time: { recorded_at: at },
  });
}

const failed = (openId: string) => ({
  outcome: "failed",
  duration_ms: { state: "observed", value: 40 },
  span: { open_event_id: openId },
});

/** One closed epoch (Nov 1) and the active epoch (Nov 3). */
function historyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-history-"));
  roots.push(root);
  const archive = join(root, ".harnery", "ledgers", "v3-archives", "epoch-20261102000000000");
  const active = join(root, ".harnery", "ledgers", "v3");
  mkdirSync(archive, { recursive: true });
  mkdirSync(active, { recursive: true });
  writeFileSync(
    join(archive, "active.ndjson"),
    [
      event("e1", "tool.requested", "2026-11-01T10:00:00.000Z", "inst_aaa", {
        tool: { name: "Bash" },
      }),
      event("e2", "tool.completed", "2026-11-01T10:00:01.000Z", "inst_aaa", failed("e1")),
      "not json",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(active, "active.ndjson"),
    [
      event("e3", "session.started", "2026-11-03T09:00:00.000Z", "inst_bbb"),
      event("e4", "tool.requested", "2026-11-03T09:00:01.000Z", "inst_bbb", {
        tool: { name: "Read" },
      }),
      event("e5", "tool.completed", "2026-11-03T09:00:02.000Z", "inst_bbb", failed("e4")),
    ].join("\n"),
  );
  return root;
}

describe("event history across epochs", () => {
  test("lists archives oldest first and the active epoch last", () => {
    const names = listEventHistoryEpochsV3(historyRoot()).map(({ name }) => name);
    expect(names).toEqual(["epoch-20261102000000000", "active"]);
  });

  test("reads archived and active events as one history", () => {
    const scan = scanEventHistoryV3(historyRoot());
    expect(scan.rows.map(({ event_id }) => event_id)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(scan.epochs.map(({ events, malformed_lines }) => [events, malformed_lines])).toEqual([
      [2, 1],
      [3, 0],
    ]);
  });

  test("joins completions to their tool and filters by outcome, type and session", () => {
    const root = historyRoot();
    const failures = scanEventHistoryV3(root, { types: ["tool."], outcome: "failed" });
    expect(failures.rows.map(({ subject, duration_ms }) => [subject, duration_ms])).toEqual([
      ["Bash", 40],
      ["Read", 40],
    ]);
    expect(scanEventHistoryV3(root, { session: "bbb", subject: "read" }).rows).toHaveLength(2);
    expect(countEventHistoryV3(failures.rows, "subject")).toEqual([
      { key: "Bash", count: 1 },
      { key: "Read", count: 1 },
    ]);
  });

  test("skips epochs that closed before --since", () => {
    const scan = scanEventHistoryV3(historyRoot(), {
      since: new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(scan.skipped_epochs).toBe(1);
    expect(scan.rows.map(({ event_id }) => event_id)).toEqual(["e3", "e4", "e5"]);
  });

  test("parses relative and absolute times", () => {
    const now = new Date("2026-11-05T00:00:00.000Z");
    expect(parseHistoryInstantV3("2d", now).toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(parseHistoryInstantV3("2026-11-01", now).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(() => parseHistoryInstantV3("soon", now)).toThrow("cannot read");
  });

  test("the query command counts failures across the archive boundary", async () => {
    let out = "";
    const append = (value: unknown) => {
      out += typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
    };
    const emit: EmitContext = {
      config: () => {},
      data: append,
      rows: append,
      text: append,
      file: () => {},
      error: append,
      log: () => {},
      setExitCode: () => {},
    };
    await createHarneryProgram({ emit }).parseAsync(
      [
        "events",
        "query",
        "--root",
        historyRoot(),
        "--outcome",
        "failed",
        "--count-by",
        "subject",
        "--tz",
        "UTC",
      ],
      { from: "user" },
    );
    expect(out).toContain("2 matching events. Searched 2 epochs back to 2026-11-01 10:00:00.");
  });
});
