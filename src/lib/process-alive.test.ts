import { describe, expect, test } from "bun:test";

import { processAlive, processMayBeAlive } from "./process-alive.ts";

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

describe("processMayBeAlive", () => {
  test("the current process may be alive", () => {
    expect(processMayBeAlive(process.pid)).toBe(true);
  });

  test("an exited process is gone", () => {
    const child = Bun.spawnSync([process.execPath, "-e", ""]);
    expect(processMayBeAlive(child.pid)).toBe(false);
  });

  test("invalid ids are gone, so they never pin a lock", () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(processMayBeAlive(pid)).toBe(false);
  });
});
