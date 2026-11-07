import { describe, expect, test } from "bun:test";
import { parseDurationMs } from "./duration.ts";

describe("parseDurationMs", () => {
  test("reads every unit", () => {
    expect(parseDurationMs("250ms")).toBe(250);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("7d")).toBe(604_800_000);
    expect(parseDurationMs("2w")).toBe(1_209_600_000);
  });

  test("accepts decimals, case and surrounding space", () => {
    expect(parseDurationMs("1.5h")).toBe(5_400_000);
    expect(parseDurationMs(" 24H ")).toBe(86_400_000);
  });

  test("rejects zero, bare numbers, unknown units and overflow", () => {
    for (const bad of ["0h", "0.0001ms", "10", "5y", "-3m", "soon", "", "9".repeat(20) + "w"]) {
      expect(parseDurationMs(bad)).toBeNull();
    }
  });
});
