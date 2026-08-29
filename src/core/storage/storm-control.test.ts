import { describe, expect, test } from "bun:test";
import { ProcessStormController } from "./storm-control.ts";

describe("per-process storm control", () => {
  test("samples noisy events but always admits errors", () => {
    let now = 0;
    const storm = new ProcessStormController({
      enabled: true,
      window_ms: 100,
      max_exemplars: 2,
      burst: 1,
      now: () => now,
    });
    expect(storm.admit("event", "debug", 10)).toBeTrue();
    expect(storm.admit("event", "debug", 10)).toBeFalse();
    expect(storm.admit("event", "error", 10)).toBeTrue();
    now = 101;
    const summaries = storm.drainSummaries();
    expect(summaries[0]?.count).toBe(1);
  });
});
