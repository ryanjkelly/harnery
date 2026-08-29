import { describe, expect, test } from "bun:test";
import { BoundedLogBuffer } from "./buffer.ts";

describe("bounded log buffer", () => {
  test("reserves bytes for high-severity records and drains explicitly", async () => {
    const drained: number[] = [];
    const dropped: string[] = [];
    const buffer = new BoundedLogBuffer<number>({
      max_bytes: 100,
      max_records: 10,
      high_severity_reserve_bytes: 30,
      flush_interval_ms: 60_000,
      drain: async (items) => {
        drained.push(...items.map((item) => item.value));
      },
      on_drop: (reason) => dropped.push(reason),
    });
    expect(buffer.enqueue({ value: 1, bytes: 70, high_priority: false })).toBeTrue();
    expect(buffer.enqueue({ value: 2, bytes: 1, high_priority: false })).toBeFalse();
    expect(buffer.enqueue({ value: 3, bytes: 30, high_priority: true })).toBeTrue();
    await buffer.flush();
    expect(drained).toEqual([1, 3]);
    expect(dropped).toEqual(["normal_capacity"]);
    await buffer.close();
  });
});
