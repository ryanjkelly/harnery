import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HEAL_BACKOFF_HOURS,
  groupByItem,
  healBackoffHours,
  healRetryAfter,
  isStaleRevision,
  isTransportFailure,
  loadHealBackoff,
  loadRevisions,
  readItemWithRetry,
  revisionKey,
  saveHealBackoff,
  saveRevisions,
} from "./state.ts";

describe("revisions", () => {
  test("an absent revision counts as 1 on both sides", () => {
    expect(isStaleRevision(undefined, undefined)).toBe(false);
    expect(isStaleRevision(1, undefined)).toBe(false);
    expect(isStaleRevision(2, undefined)).toBe(true);
    expect(isStaleRevision(2, 2)).toBe(false);
    expect(isStaleRevision(2, 3)).toBe(false);
  });

  test("state round-trips and a corrupt file reads as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "harn-creds-state-"));
    try {
      const path = join(dir, "nested", "revisions.json");
      expect(loadRevisions(path)).toEqual({});
      saveRevisions(path, { [revisionKey("host", ".credentials/a.env")]: 2 });
      expect(loadRevisions(path)).toEqual({ "host:.credentials/a.env": 2 });
      writeFileSync(path, "not json");
      expect(loadRevisions(join(dir, "nested", "revisions.json"))).toEqual({});
      saveHealBackoff(join(dir, "b.json"), { k: { failed_at: "2026-01-01T00:00:00.000Z" } });
      expect(loadHealBackoff(join(dir, "b.json")).k?.failed_at).toBe("2026-01-01T00:00:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("heal backoff", () => {
  test("reads the host's environment variable and falls back on invalid values", () => {
    expect(healBackoffHours("HOST_BACKOFF", { HOST_BACKOFF: "6" })).toBe(6);
    expect(healBackoffHours("HOST_BACKOFF", { HOST_BACKOFF: "0" })).toBe(0);
    expect(healBackoffHours("HOST_BACKOFF", { HOST_BACKOFF: "-1" })).toBe(
      DEFAULT_HEAL_BACKOFF_HOURS,
    );
    expect(healBackoffHours("HOST_BACKOFF", { HOST_BACKOFF: "x" })).toBe(
      DEFAULT_HEAL_BACKOFF_HOURS,
    );
    expect(healBackoffHours("HOST_BACKOFF", {})).toBe(DEFAULT_HEAL_BACKOFF_HOURS);
  });

  test("waits out the delay, and a newer pull script ends it early", () => {
    const failedAt = Date.parse("2026-01-01T00:00:00.000Z");
    const failure = { failed_at: new Date(failedAt).toISOString() };
    expect(healRetryAfter(undefined, failedAt, 24, null)).toBeNull();
    expect(healRetryAfter(failure, failedAt + 3_600_000, 24, null)?.getTime()).toBe(
      failedAt + 24 * 3_600_000,
    );
    expect(healRetryAfter(failure, failedAt + 25 * 3_600_000, 24, null)).toBeNull();
    expect(healRetryAfter(failure, failedAt + 3_600_000, 24, failedAt + 1)).toBeNull();
  });

  test("a script written in the same millisecond as the failure does not end the delay", () => {
    const failedAt = Date.parse("2026-01-01T00:00:00.000Z");
    const failure = { failed_at: new Date(failedAt).toISOString() };
    expect(healRetryAfter(failure, failedAt + 1000, 24, failedAt + 0.6)).not.toBeNull();
  });
});

describe("groupByItem", () => {
  test("merges fields and scripts per item and marks fields only pending entries name", () => {
    const groups = groupByItem([
      { vault: "V", item: "A", fields: ["key", "id"], scripts: ["one"] },
      { vault: "V", item: "A", fields: ["key", "future"], scripts: ["two"], pending: true },
      { vault: "V", item: "Doc", fields: [], scripts: ["three"], kind: "document" },
    ]);
    expect(groups).toEqual([
      {
        vault: "V",
        item: "A",
        fields: ["key", "id", "future"],
        scripts: ["one", "two"],
        pendingFields: ["future"],
        pending: false,
        kind: "fields",
      },
      {
        vault: "V",
        item: "Doc",
        fields: [],
        scripts: ["three"],
        pendingFields: [],
        pending: false,
        kind: "document",
      },
    ]);
  });
});

describe("transport failures", () => {
  test("recognizes transport errors and not vault verdicts", () => {
    expect(isTransportFailure(new Error("UtilAcceptVsock: accept4 failed 110"))).toBe(true);
    expect(isTransportFailure("connection reset by peer")).toBe(true);
    expect(isTransportFailure(new Error('"x" isn\'t an item in the "V" vault'))).toBe(false);
    expect(isTransportFailure("")).toBe(false);
  });

  test("retries only transport failures", async () => {
    let calls = 0;
    const flaky = () => {
      calls++;
      return calls < 3 ? Promise.reject(new Error("connection refused")) : Promise.resolve("ok");
    };
    expect(await readItemWithRetry(flaky, 3, async () => {})).toBe("ok");
    expect(calls).toBe(3);
    calls = 0;
    const missing = () => {
      calls++;
      return Promise.reject(new Error("item not found"));
    };
    await expect(readItemWithRetry(missing, 3, async () => {})).rejects.toThrow("item not found");
    expect(calls).toBe(1);
  });
});
