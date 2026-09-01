import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QaRunResult } from "../../lib/browser/qa-run-contracts.ts";
import {
  formatQaSignalAge,
  formatQaSignalDuration,
  formatQaSignalRow,
  parseQaSignal,
  QA_SIGNAL_SCHEMA_VERSION,
  QA_SIGNAL_STALE_AFTER_MS,
  type QaSignalPointer,
  qaSignalPath,
  qaSignalStatusRow,
  readQaSignal,
  recordQaSignal,
} from "./qa-signal.ts";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const INSTANCE = "inst_test_0001";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-qa-signal-"));
  mkdirSync(join(root, ".harnery"), { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function pointer(overrides: Partial<QaSignalPointer> = {}): QaSignalPointer {
  return {
    schema_version: QA_SIGNAL_SCHEMA_VERSION,
    run_id: "run-abc",
    verdict: "passed",
    evidence_source: "runner",
    completed_at: new Date(NOW - 4 * 60_000).toISOString(),
    out_dir: "/runs/run-abc",
    wall_time_ms: { total: 90_000 },
    target: "https://example.test/page",
    ...overrides,
  };
}

function result(overrides: Partial<QaRunResult> = {}): QaRunResult {
  return {
    schema_version: 3,
    evidence_source: "runner",
    run: {
      run_id: "run-abc",
      started_at: new Date(NOW - 200_000).toISOString(),
      completed_at: new Date(NOW - 4 * 60_000).toISOString(),
      revision_source: "unknown",
      job_digest: "digest",
      out_dir: "/runs/run-abc",
    },
    host: {
      start: {
        captured_at: new Date(NOW - 200_000).toISOString(),
        loadavg_1m: 1,
        free_mem_bytes: 1,
        total_mem_bytes: 2,
        cpu_count: 4,
      },
      finish: {
        captured_at: new Date(NOW - 4 * 60_000).toISOString(),
        loadavg_1m: 1,
        free_mem_bytes: 1,
        total_mem_bytes: 2,
        cpu_count: 4,
      },
    },
    last_completed_stage: "snapshot",
    target: "https://example.test/page",
    mode: "signoff",
    qa_plan: null,
    contexts: [],
    commands: [],
    critique: [],
    snapshot: { saved: true },
    wall_time_ms: {
      plan: 1_000,
      gates: 60_000,
      interactions: 10_000,
      critique: 15_000,
      snapshot: 4_000,
      total: 90_000,
    },
    blockers: [],
    verdict: "passed",
    ...overrides,
  } as QaRunResult;
}

describe("qaSignalPath", () => {
  test("resolves under the coordination root's qa directory", () => {
    expect(qaSignalPath("/repo", INSTANCE)).toBe(`/repo/.harnery/qa/${INSTANCE}.json`);
  });

  test("refuses an instance id that could escape the directory", () => {
    expect(() => qaSignalPath("/repo", "../escape")).toThrow();
    expect(() => qaSignalPath("/repo", "")).toThrow();
  });
});

describe("write/read round trip", () => {
  test("records a completed run and reads it back", () => {
    const root = makeRoot();
    const written = recordQaSignal(result(), { coordRoot: root, instanceId: INSTANCE });
    expect(written).not.toBeNull();
    expect(written?.verdict).toBe("passed");
    expect(written?.wall_time_ms).toEqual({ total: 90_000 });

    const read = readQaSignal({ coordRoot: root, instanceId: INSTANCE });
    expect(read).toEqual(written as QaSignalPointer);
    expect(read?.run_id).toBe("run-abc");
    expect(read?.out_dir).toBe("/runs/run-abc");
    expect(read?.target).toBe("https://example.test/page");
  });

  test("carries queue time separately and never folded into total", () => {
    const root = makeRoot();
    const queued = result({
      wall_time_ms: {
        plan: 1_000,
        gates: 60_000,
        interactions: 10_000,
        critique: 15_000,
        snapshot: 4_000,
        total: 90_000,
        queue: 120_000,
      },
    });
    recordQaSignal(queued, { coordRoot: root, instanceId: INSTANCE });
    const read = readQaSignal({ coordRoot: root, instanceId: INSTANCE });
    expect(read?.wall_time_ms.total).toBe(90_000);
    expect(read?.wall_time_ms.queue).toBe(120_000);
  });

  test("a later run overwrites the pointer", () => {
    const root = makeRoot();
    recordQaSignal(result(), { coordRoot: root, instanceId: INSTANCE });
    recordQaSignal(
      result({
        verdict: "failed",
        run: { ...result().run, run_id: "run-def" },
      }),
      { coordRoot: root, instanceId: INSTANCE },
    );
    const read = readQaSignal({ coordRoot: root, instanceId: INSTANCE });
    expect(read?.run_id).toBe("run-def");
    expect(read?.verdict).toBe("failed");
  });

  test("manual evidence round trips as manual", () => {
    const root = makeRoot();
    recordQaSignal(result({ evidence_source: "manual", verdict: "incomplete" }), {
      coordRoot: root,
      instanceId: INSTANCE,
    });
    expect(readQaSignal({ coordRoot: root, instanceId: INSTANCE })?.evidence_source).toBe("manual");
  });

  test("reading a session with no pointer yields null, not an error", () => {
    const root = makeRoot();
    expect(readQaSignal({ coordRoot: root, instanceId: INSTANCE })).toBeNull();
  });

  test("an unusable target writes nothing and reads null", () => {
    const root = makeRoot();
    expect(recordQaSignal(result(), { coordRoot: root, instanceId: "../escape" })).toBeNull();
    expect(readQaSignal({ coordRoot: root, instanceId: "../escape" })).toBeNull();
  });

  test("a corrupt pointer file reads as null instead of throwing", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".harnery", "qa"), { recursive: true });
    writeFileSync(join(root, ".harnery", "qa", `${INSTANCE}.json`), "{ not json");
    expect(readQaSignal({ coordRoot: root, instanceId: INSTANCE })).toBeNull();
  });
});

describe("parseQaSignal", () => {
  test("accepts a complete pointer", () => {
    expect(parseQaSignal(pointer())).toEqual(pointer());
  });

  test("rejects non-objects and a foreign schema version", () => {
    expect(parseQaSignal(null)).toBeNull();
    expect(parseQaSignal("passed")).toBeNull();
    expect(parseQaSignal([pointer()])).toBeNull();
    expect(parseQaSignal({ ...pointer(), schema_version: 2 })).toBeNull();
  });

  test("rejects a partial document field by field", () => {
    for (const field of [
      "run_id",
      "verdict",
      "evidence_source",
      "completed_at",
      "out_dir",
      "wall_time_ms",
      "target",
    ] as const) {
      const partial: Record<string, unknown> = { ...pointer() };
      delete partial[field];
      expect(parseQaSignal(partial)).toBeNull();
    }
  });

  test("rejects out-of-vocabulary verdict and evidence source", () => {
    expect(parseQaSignal({ ...pointer(), verdict: "ok" })).toBeNull();
    expect(parseQaSignal({ ...pointer(), evidence_source: "guess" })).toBeNull();
  });

  test("rejects an unparseable completion instant and bad timings", () => {
    expect(parseQaSignal({ ...pointer(), completed_at: "whenever" })).toBeNull();
    expect(parseQaSignal({ ...pointer(), wall_time_ms: { total: -1 } })).toBeNull();
    expect(parseQaSignal({ ...pointer(), wall_time_ms: { total: "90s" } })).toBeNull();
    expect(parseQaSignal({ ...pointer(), wall_time_ms: { total: 1, queue: -5 } })).toBeNull();
  });
});

describe("formatQaSignalAge", () => {
  test("renders one coarse unit", () => {
    expect(formatQaSignalAge(0)).toBe("0s");
    expect(formatQaSignalAge(45_000)).toBe("45s");
    expect(formatQaSignalAge(4 * 60_000)).toBe("4m");
    expect(formatQaSignalAge(3 * 3_600_000)).toBe("3h");
    expect(formatQaSignalAge(2 * 86_400_000)).toBe("2d");
  });

  test("clamps a negative age to zero", () => {
    expect(formatQaSignalAge(-5_000)).toBe("0s");
  });
});

describe("formatQaSignalDuration", () => {
  test("keeps seconds readable below two minutes", () => {
    expect(formatQaSignalDuration(34_000)).toBe("34s");
    expect(formatQaSignalDuration(90_000)).toBe("90s");
  });

  test("switches to minutes and hours above that", () => {
    expect(formatQaSignalDuration(120_000)).toBe("2m");
    expect(formatQaSignalDuration(9 * 60_000)).toBe("9m");
    expect(formatQaSignalDuration(3_600_000)).toBe("1h");
    expect(formatQaSignalDuration(3_600_000 + 30 * 60_000)).toBe("1h 30m");
  });
});

describe("formatQaSignalRow", () => {
  test("renders a fresh runner pass with the runner clock", () => {
    expect(formatQaSignalRow(pointer(), NOW)).toBe("passed 4m ago · 90s runner");
  });

  test("shows queue time separately from runner time", () => {
    const row = formatQaSignalRow(
      pointer({ wall_time_ms: { total: 90_000, queue: 120_000 } }),
      NOW,
    );
    expect(row).toBe("passed 4m ago · 90s runner (2m queued)");
  });

  test("renders an incomplete verdict", () => {
    const row = formatQaSignalRow(
      pointer({
        verdict: "incomplete",
        completed_at: new Date(NOW - 3 * 3_600_000).toISOString(),
        wall_time_ms: { total: 34_000 },
      }),
      NOW,
    );
    expect(row).toBe("incomplete 3h ago · 34s runner");
  });

  test("manual evidence reports no verdict and no runner clock", () => {
    const row = formatQaSignalRow(
      pointer({
        evidence_source: "manual",
        verdict: "incomplete",
        completed_at: new Date(NOW - 12 * 60_000).toISOString(),
        wall_time_ms: { total: 900_000 },
      }),
      NOW,
    );
    expect(row).toBe("manual 12m ago · not a pass");
  });

  test("omits a zero queue rather than printing (0s queued)", () => {
    expect(formatQaSignalRow(pointer({ wall_time_ms: { total: 90_000, queue: 0 } }), NOW)).toBe(
      "passed 4m ago · 90s runner",
    );
  });

  test("past the staleness horizon it reports only staleness", () => {
    const stale = pointer({
      completed_at: new Date(NOW - QA_SIGNAL_STALE_AFTER_MS - 60_000).toISOString(),
    });
    expect(formatQaSignalRow(stale, NOW)).toBe("stale (1d)");

    const veryStale = pointer({
      completed_at: new Date(NOW - 3 * 86_400_000).toISOString(),
      evidence_source: "manual",
    });
    expect(formatQaSignalRow(veryStale, NOW)).toBe("stale (3d)");
  });

  test("exactly at the horizon is still fresh", () => {
    const edge = pointer({
      completed_at: new Date(NOW - QA_SIGNAL_STALE_AFTER_MS).toISOString(),
    });
    expect(formatQaSignalRow(edge, NOW)).toBe("passed 1d ago · 90s runner");
  });

  test("renders nothing for an absent pointer or an unparseable instant", () => {
    expect(formatQaSignalRow(null, NOW)).toBeNull();
    expect(formatQaSignalRow({ ...pointer(), completed_at: "whenever" }, NOW)).toBeNull();
  });

  test("a clock skewed pointer from the future clamps to zero age", () => {
    const future = pointer({ completed_at: new Date(NOW + 60_000).toISOString() });
    expect(formatQaSignalRow(future, NOW)).toBe("passed 0s ago · 90s runner");
  });

  test("the row stays short enough for the status box", () => {
    const row = formatQaSignalRow(
      pointer({ wall_time_ms: { total: 3_600_000 + 30 * 60_000, queue: 3_600_000 } }),
      NOW,
    );
    expect(row).not.toBeNull();
    expect((row as string).length).toBeLessThan(60);
  });
});

describe("qaSignalStatusRow", () => {
  test("returns the rendered row plus the pointer it came from", () => {
    const root = makeRoot();
    recordQaSignal(result(), { coordRoot: root, instanceId: INSTANCE });
    const row = qaSignalStatusRow({ coordRoot: root, instanceId: INSTANCE }, NOW);
    expect(row?.value).toBe("passed 4m ago · 90s runner");
    expect(row?.pointer.run_id).toBe("run-abc");
  });

  test("returns null when the session has no pointer", () => {
    const root = makeRoot();
    expect(qaSignalStatusRow({ coordRoot: root, instanceId: INSTANCE }, NOW)).toBeNull();
  });

  test("returns null for a malformed pointer instead of throwing", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".harnery", "qa"), { recursive: true });
    writeFileSync(
      join(root, ".harnery", "qa", `${INSTANCE}.json`),
      JSON.stringify({ schema_version: 1, run_id: "partial" }),
    );
    expect(qaSignalStatusRow({ coordRoot: root, instanceId: INSTANCE }, NOW)).toBeNull();
  });
});
