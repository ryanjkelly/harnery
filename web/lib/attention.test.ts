import { describe, expect, test } from "bun:test";

import {
  isAcked,
  loadAcked,
  markAcked,
  parseStoredRequest,
  pruneAcked,
} from "./attention";

/** Minimal in-memory Storage stand-in (bun test has no DOM). */
function memoryStore(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

const DAY = 24 * 60 * 60 * 1000;

describe("acked-key store", () => {
  test("mark → isAcked round-trips through the store", () => {
    const store = memoryStore();
    expect(isAcked("att:c1:r3:copy:agent-A", store)).toBe(false);
    markAcked("att:c1:r3:copy:agent-A", store, 1000);
    expect(isAcked("att:c1:r3:copy:agent-A", store, 2000)).toBe(true);
    // a different key (new actionable moment) is not acked
    expect(isAcked("att:c1:r3:copy:agent-B", store, 2000)).toBe(false);
  });

  test("acks expire after the 24h TTL", () => {
    const store = memoryStore();
    markAcked("att:c1:r3:advance", store, 0);
    expect(isAcked("att:c1:r3:advance", store, DAY - 1)).toBe(true);
    expect(isAcked("att:c1:r3:advance", store, DAY + 1)).toBe(false);
  });

  test("markAcked prunes stale entries as it writes", () => {
    const store = memoryStore();
    markAcked("old", store, 0);
    markAcked("fresh", store, DAY + 5000);
    const map = loadAcked(store);
    expect(map.old).toBeUndefined();
    expect(map.fresh).toBe(DAY + 5000);
  });

  test("pruneAcked is pure and drops only expired keys", () => {
    const map = { a: 0, b: 500 };
    const pruned = pruneAcked(map, DAY + 100);
    expect(pruned).toEqual({ b: 500 });
    expect(map).toEqual({ a: 0, b: 500 });
  });

  test("corrupt or non-object storage payloads degrade to empty", () => {
    expect(loadAcked(memoryStore({ "harnery.attention.acked": "not json" }))).toEqual({});
    expect(loadAcked(memoryStore({ "harnery.attention.acked": "[1,2]" }))).toEqual({});
    expect(
      loadAcked(
        memoryStore({ "harnery.attention.acked": '{"k":"not-a-number","ok":5}' }),
      ),
    ).toEqual({ ok: 5 });
  });

  test("null store (SSR) is a safe no-op", () => {
    expect(loadAcked(null)).toEqual({});
    expect(isAcked("anything", null)).toBe(false);
    expect(() => markAcked("anything", null)).not.toThrow();
  });
});

describe("parseStoredRequest (replay-bell persistence)", () => {
  test("round-trips a {key, label} payload", () => {
    const raw = JSON.stringify({ key: "att:c:r3:copy:agent-A", label: "Copy it" });
    expect(parseStoredRequest(raw)).toEqual({
      key: "att:c:r3:copy:agent-A",
      label: "Copy it",
    });
  });

  test("rejects malformed payloads", () => {
    expect(parseStoredRequest(null)).toBeNull();
    expect(parseStoredRequest("not json")).toBeNull();
    expect(parseStoredRequest("[1,2]")).toBeNull();
    expect(parseStoredRequest('{"key":"","label":"x"}')).toBeNull();
    expect(parseStoredRequest('{"key":"k"}')).toBeNull();
    expect(parseStoredRequest('{"key":5,"label":"x"}')).toBeNull();
  });
});
