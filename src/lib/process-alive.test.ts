import { describe, expect, test } from "bun:test";

import { processAlive } from "./process-alive.ts";

describe("processAlive", () => {
  test("the current process is alive", () => {
    expect(processAlive(process.pid)).toBe(true);
  });

  test("zero, negative, and fractional ids are never alive", () => {
    expect(processAlive(0)).toBe(false);
    expect(processAlive(-1)).toBe(false);
    expect(processAlive(1.5)).toBe(false);
    expect(processAlive(Number.NaN)).toBe(false);
  });
});
