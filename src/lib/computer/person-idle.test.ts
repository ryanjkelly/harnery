import { describe, expect, test } from "bun:test";
import {
  parseIdleMilliseconds,
  parseMacIdleMilliseconds,
  probePersonIdleMs,
  waitForQuietDesktop,
} from "./person-idle.ts";
import type { HostInfo } from "./types.ts";

const WSL: HostInfo = { kind: "wsl", desktopStateDir: "/mnt/c/state/harnery" };
const MAC: HostInfo = { kind: "macos", desktopStateDir: "/Users/u/Library/harnery" };
const LINUX: HostInfo = { kind: "linux", desktopStateDir: "/home/u/.local/state/harnery" };

/** A clock that only moves when the wait sleeps, and a script of idle readings. */
function scripted(readings: (number | null)[]) {
  let clock = 0;
  const slept: number[] = [];
  let index = 0;
  return {
    slept,
    options: {
      probe: () => readings[Math.min(index++, readings.length - 1)] ?? null,
      now: () => clock,
      sleep: async (ms: number) => {
        slept.push(ms);
        clock += ms;
      },
    },
  };
}

describe("idle readings", () => {
  test("reads a millisecond count from a line of its own", () => {
    expect(parseIdleMilliseconds("40062\r\n")).toBe(40062);
    expect(parseIdleMilliseconds("#< CLIXML\n17\n<Objs />\n")).toBe(17);
    expect(parseIdleMilliseconds("no number here\n")).toBeNull();
  });

  test("converts the macOS HID idle time from nanoseconds", () => {
    const ioreg = '    | |   "HIDIdleTime" = 2500000000\n    | |   "HIDParameters" = {}\n';
    expect(parseMacIdleMilliseconds(ioreg)).toBe(2500);
    expect(parseMacIdleMilliseconds("nothing")).toBeNull();
  });

  test("Windows and WSL ask PowerShell with an encoded command", () => {
    const seen: { command: string; args: string[] }[] = [];
    const idle = probePersonIdleMs(WSL, {
      run: (command, args) => {
        seen.push({ command, args });
        return { status: 0, stdout: "1234\n" };
      },
    });
    expect(idle).toBe(1234);
    expect(seen[0]?.command).toContain("powershell.exe");
    expect(seen[0]?.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  });

  test("macOS reads ioreg", () => {
    const idle = probePersonIdleMs(MAC, {
      run: (command) => ({
        status: command === "ioreg" ? 0 : 1,
        stdout: '"HIDIdleTime" = 9000000',
      }),
    });
    expect(idle).toBe(9);
  });

  test("Linux reads xprintidle on X11 and gives no reading without a display", () => {
    const run = () => ({ status: 0, stdout: "700\n" });
    expect(probePersonIdleMs(LINUX, { run, env: { DISPLAY: ":0" } })).toBe(700);
    expect(probePersonIdleMs(LINUX, { run, env: {} })).toBeNull();
  });

  test("a failed or missing helper gives no reading", () => {
    expect(probePersonIdleMs(WSL, { run: () => ({ status: 1, stdout: "" }) })).toBeNull();
    expect(probePersonIdleMs(WSL, { run: () => ({ status: null, stdout: "" }) })).toBeNull();
    expect(
      probePersonIdleMs(MAC, {
        run: () => {
          throw new Error("spawn failed");
        },
      }),
    ).toBeNull();
    expect(probePersonIdleMs({ kind: "unsupported", reason: "x" })).toBeNull();
  });
});

describe("waitForQuietDesktop", () => {
  test("returns at once when the person is already away", async () => {
    const s = scripted([8000]);
    const result = await waitForQuietDesktop({ quietMs: 3000, maxWaitMs: 60_000, ...s.options });
    expect(result).toEqual({ status: "quiet", waitedMs: 0, idleMs: 8000 });
    expect(s.slept).toEqual([]);
  });

  test("sleeps for exactly what the quiet period still needs", async () => {
    const s = scripted([500, 3000]);
    const result = await waitForQuietDesktop({ quietMs: 3000, maxWaitMs: 60_000, ...s.options });
    expect(result).toEqual({ status: "quiet", waitedMs: 2500, idleMs: 3000 });
    expect(s.slept).toEqual([2500]);
  });

  test("keeps waiting while the person keeps typing, then reports busy", async () => {
    const s = scripted([0]);
    const result = await waitForQuietDesktop({ quietMs: 3000, maxWaitMs: 7000, ...s.options });
    expect(result).toEqual({ status: "busy", waitedMs: 7000, idleMs: 0 });
    expect(s.slept).toEqual([3000, 3000, 1000]);
  });

  test("a host with no reading is unknown and never waits", async () => {
    const s = scripted([null]);
    const result = await waitForQuietDesktop({ quietMs: 3000, maxWaitMs: 60_000, ...s.options });
    expect(result).toEqual({ status: "unknown", waitedMs: 0 });
    expect(s.slept).toEqual([]);
  });

  test("a reading that barely misses still sleeps a minimum, so it cannot spin", async () => {
    const s = scripted([2999, 3100]);
    const result = await waitForQuietDesktop({ quietMs: 3000, maxWaitMs: 60_000, ...s.options });
    expect(result.status).toBe("quiet");
    expect(s.slept).toEqual([100]);
  });
});
