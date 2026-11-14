import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORNERS,
  cornerPosition,
  type DisplayInfo,
  describeDisplay,
  pickDisplay,
  probeDisplays,
  readDisplayCache,
  writeDisplayCache,
} from "./displays.ts";
import type { SpawnResult, SpawnSyncFn } from "./driver-support.ts";
import type { HostInfo } from "./types.ts";

const WINDOWS_OUTPUT =
  '[{"id":"\\\\\\\\.\\\\DISPLAY2","primary":false,"scale":1.25,"bounds":{"y":700,"width":5120,"height":1440,"x":5120},"work_area":{"y":700,"width":5120,"height":1380,"x":5120}},{"id":"\\\\\\\\.\\\\DISPLAY1","primary":true,"scale":1.5,"bounds":{"y":0,"width":5120,"height":2160,"x":0},"work_area":{"y":0,"width":5120,"height":2088,"x":0}}]';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const host = (kind: HostInfo["kind"]): HostInfo => ({ kind });

interface Call {
  command: string;
  args: string[];
  timeout: number;
}

function fakeSpawn(answers: Record<string, Partial<SpawnResult>>, calls: Call[] = []): SpawnSyncFn {
  return (command, args, options) => {
    calls.push({ command, args, timeout: options.timeout });
    const key = Object.keys(answers).find((k) => command.endsWith(k));
    const answer = key ? answers[key] : undefined;
    if (!answer)
      return { status: null, stdout: "", stderr: "", error: new Error(`spawn ${command} ENOENT`) };
    return { status: 0, stdout: "", stderr: "", ...answer };
  };
}

const driverList: DisplayInfo[] = [
  { id: "d1", primary: true, bounds: { x: 0, y: 0, width: 1000, height: 800 } },
];

describe("probeDisplays on Windows and WSL", () => {
  for (const kind of ["windows", "wsl"] as const) {
    test(`${kind}: parses the real PowerShell array output`, () => {
      const calls: Call[] = [];
      const snap = probeDisplays(host(kind), {
        spawnSync: fakeSpawn({ "powershell.exe": { stdout: `﻿${WINDOWS_OUTPUT}\r\n` } }, calls),
        now: () => NOW,
        driverDisplays: () => driverList,
      });
      expect(snap.source).toBe("windows");
      expect(snap.probed_at).toBe("2026-11-14T12:00:00.000Z");
      expect(snap.error).toBeUndefined();
      expect(snap.displays).toEqual([
        {
          id: "\\\\.\\DISPLAY2",
          primary: false,
          scale: 1.25,
          bounds: { x: 5120, y: 700, width: 5120, height: 1440 },
          work_area: { x: 5120, y: 700, width: 5120, height: 1380 },
        },
        {
          id: "\\\\.\\DISPLAY1",
          primary: true,
          scale: 1.5,
          bounds: { x: 0, y: 0, width: 5120, height: 2160 },
          work_area: { x: 0, y: 0, width: 5120, height: 2088 },
        },
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command.endsWith("powershell.exe")).toBe(true);
      expect(calls[0]?.args.slice(0, 2)).toEqual(["-NoProfile", "-Command"]);
      expect(calls[0]?.args[2]).toContain("ConvertTo-Json");
      expect(calls[0]?.timeout).toBe(30_000);
    });
  }

  test("parses the single-object form", () => {
    const one = JSON.stringify(JSON.parse(WINDOWS_OUTPUT)[1]);
    const snap = probeDisplays(host("windows"), {
      spawnSync: fakeSpawn({ "powershell.exe": { stdout: `${one}\r\n` } }),
    });
    expect(snap.displays).toHaveLength(1);
    expect(snap.displays[0]?.id).toBe("\\\\.\\DISPLAY1");
    expect(snap.displays[0]?.primary).toBe(true);
  });

  test("falls back to the driver when PowerShell fails", () => {
    const snap = probeDisplays(host("wsl"), {
      spawnSync: fakeSpawn({ "powershell.exe": { status: 1, stderr: "boom" } }),
      driverDisplays: () => driverList,
    });
    expect(snap.source).toBe("driver");
    expect(snap.displays).toEqual(driverList);
  });
});

describe("probeDisplays on macOS", () => {
  // Primary 1440x900 at the origin; one 1920x1080 screen to its right whose
  // bottom sits 100pt above the primary's bottom; one 1280x800 screen above.
  const appkit = JSON.stringify([
    {
      id: "1",
      name: "Built-in Retina Display",
      scale: 2,
      frame: { x: 0, y: 0, width: 1440, height: 900 },
      visible: { x: 0, y: 70, width: 1440, height: 805 },
    },
    { id: "2", name: "DELL", scale: 1, frame: { x: 1440, y: 100, width: 1920, height: 1080 } },
    { id: "3", name: "", scale: 1, frame: { x: 0, y: 900, width: 1280, height: 800 } },
  ]);

  test("driver listing comes first", () => {
    const calls: Call[] = [];
    const snap = probeDisplays(host("macos"), {
      spawnSync: fakeSpawn({ osascript: { stdout: appkit } }, calls),
      driverDisplays: () => driverList,
    });
    expect(snap.source).toBe("driver");
    expect(calls).toHaveLength(0);
  });

  test("native probe flips AppKit coordinates to a top-left origin", () => {
    const calls: Call[] = [];
    const snap = probeDisplays(host("macos"), {
      spawnSync: fakeSpawn({ osascript: { stdout: `${appkit}\n` } }, calls),
      driverDisplays: () => [],
    });
    expect(snap.source).toBe("macos");
    expect(calls[0]?.command).toBe("osascript");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(snap.displays).toEqual([
      {
        id: "1",
        name: "Built-in Retina Display",
        primary: true,
        scale: 2,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        // Menu bar 25pt at top, dock 70pt at bottom.
        work_area: { x: 0, y: 25, width: 1440, height: 805 },
      },
      {
        id: "2",
        name: "DELL",
        primary: false,
        scale: 1,
        bounds: { x: 1440, y: -280, width: 1920, height: 1080 },
      },
      { id: "3", primary: false, scale: 1, bounds: { x: 0, y: -800, width: 1280, height: 800 } },
    ]);
  });

  test("garbage output is no answer", () => {
    const snap = probeDisplays(host("macos"), {
      spawnSync: fakeSpawn({ osascript: { stdout: "not json" } }),
    });
    expect(snap.displays).toEqual([]);
    expect(snap.error).toContain("osascript");
  });
});

describe("probeDisplays on Linux", () => {
  const xrandr = [
    "Screen 0: minimum 320 x 200, current 4480 x 1440, maximum 16384 x 16384",
    "eDP-1 connected primary 1920x1080+0+360 (normal left inverted right x axis y axis) 344mm x 194mm",
    "   1920x1080     60.02*+",
    "HDMI-1 connected 2560x1440+1920+0 (normal left inverted right x axis y axis) 597mm x 336mm",
    "   2560x1440     59.95*+",
    "DP-1 disconnected (normal left inverted right x axis y axis)",
    "DP-2 connected (normal left inverted right x axis y axis)",
  ].join("\n");

  test("driver listing comes first", () => {
    const snap = probeDisplays(host("linux"), {
      spawnSync: fakeSpawn({ xrandr: { stdout: xrandr } }),
      driverDisplays: () => driverList,
    });
    expect(snap.source).toBe("driver");
  });

  test("parses xrandr connected outputs", () => {
    const calls: Call[] = [];
    const snap = probeDisplays(host("linux"), {
      spawnSync: fakeSpawn({ xrandr: { stdout: xrandr } }, calls),
    });
    expect(snap.source).toBe("linux-xrandr");
    expect(calls[0]?.args).toEqual(["--query"]);
    expect(snap.displays).toEqual([
      { id: "eDP-1", primary: true, bounds: { x: 0, y: 360, width: 1920, height: 1080 } },
      { id: "HDMI-1", primary: false, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
    ]);
  });

  test("a missing xrandr and no driver is an error, never a throw", () => {
    const snap = probeDisplays(host("linux"), {
      spawnSync: fakeSpawn({}),
      driverDisplays: () => {
        throw new Error("driver down");
      },
      now: () => NOW,
    });
    expect(snap.displays).toEqual([]);
    expect(snap.error).toContain("driver down");
    expect(snap.error).toContain("xrandr");
    expect(snap.probed_at).toBe("2026-11-14T12:00:00.000Z");
  });
});

test("total failure on Windows and an unsupported host both report an error", () => {
  const win = probeDisplays(host("windows"), {
    spawnSync: () => {
      throw new Error("spawn exploded");
    },
  });
  expect(win.displays).toEqual([]);
  expect(win.error).toContain("spawn exploded");
  expect(win.error).toContain("no driver");
  const none = probeDisplays({ kind: "unsupported", reason: "no desktop" });
  expect(none.displays).toEqual([]);
  expect(none.error).toBe("no desktop");
});

describe("display cache", () => {
  test("round trip, missing and malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "displays-test-"));
    try {
      const nested = join(dir, "a", "b");
      expect(readDisplayCache(nested)).toBeNull();
      const snap = probeDisplays(host("windows"), {
        spawnSync: fakeSpawn({ "powershell.exe": { stdout: WINDOWS_OUTPUT } }),
        now: () => NOW,
      });
      writeDisplayCache(nested, snap);
      expect(readDisplayCache(nested)).toEqual(snap);
      writeFileSync(join(nested, "displays.json"), "{not json");
      expect(readDisplayCache(nested)).toBeNull();
      writeFileSync(
        join(nested, "displays.json"),
        JSON.stringify({ probed_at: "x", source: "y", displays: [{}] }),
      );
      expect(readDisplayCache(nested)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const left: DisplayInfo = {
  id: "LEFT",
  name: "Dell U2720Q",
  primary: false,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
};
const main: DisplayInfo = {
  id: "MAIN",
  primary: true,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  work_area: { x: 0, y: 0, width: 2560, height: 1400 },
};
const below: DisplayInfo = {
  id: "BELOW",
  primary: false,
  bounds: { x: 0, y: 1440, width: 1920, height: 1080 },
};

describe("pickDisplay", () => {
  const all = [main, below, left];
  test("empty list", () => expect(pickDisplay([], "primary")).toBeUndefined());
  test("primary, and the first display when none is primary", () => {
    expect(pickDisplay(all, "primary")).toBe(main);
    expect(pickDisplay([below, left], "primary")).toBe(left);
  });
  test("secondary is the first non-primary left to right, else the only display", () => {
    expect(pickDisplay(all, "secondary")).toBe(left);
    expect(pickDisplay([main], "secondary")).toBe(main);
  });
  test("1-based index in left-to-right, top-to-bottom order", () => {
    expect(pickDisplay(all, "1")).toBe(left);
    expect(pickDisplay(all, "2")).toBe(main);
    expect(pickDisplay(all, "3")).toBe(below);
    expect(pickDisplay(all, "4")).toBeUndefined();
    expect(pickDisplay(all, "0")).toBeUndefined();
  });
  test("id exact, then case-insensitive id or name", () => {
    expect(pickDisplay(all, "BELOW")).toBe(below);
    expect(pickDisplay(all, "below")).toBe(below);
    expect(pickDisplay(all, "dell u2720q")).toBe(left);
    expect(pickDisplay(all, "nope")).toBeUndefined();
  });
});

describe("cornerPosition", () => {
  const size = { width: 400, height: 300 };
  test("every corner with a margin uses the work area", () => {
    expect(CORNERS.map((c) => cornerPosition(main, c, size, 10))).toEqual([
      { x: 10, y: 10 },
      { x: 2150, y: 10 },
      { x: 10, y: 1090 },
      { x: 2150, y: 1090 },
    ]);
  });
  test("bounds when there is no work area; offset displays", () => {
    expect(cornerPosition(left, "bottom-right", size, 0)).toEqual({ x: -400, y: 780 });
    expect(cornerPosition(below, "top-left", size, 0)).toEqual({ x: 0, y: 1440 });
  });
  test("an oversized window keeps its top-left inside the area", () => {
    expect(cornerPosition(below, "bottom-right", { width: 5000, height: 4000 }, 20)).toEqual({
      x: 0,
      y: 1440,
    });
  });
  test("fractional input becomes integers", () => {
    const pos = cornerPosition(main, "bottom-right", { width: 400.6, height: 300.4 }, 0);
    expect(Number.isInteger(pos.x) && Number.isInteger(pos.y)).toBe(true);
  });
});

describe("describeDisplay", () => {
  test("Windows display with scale", () => {
    expect(
      describeDisplay({
        id: "\\\\.\\DISPLAY2",
        primary: false,
        scale: 1.25,
        bounds: { x: 5120, y: 700, width: 5120, height: 1440 },
      }),
    ).toBe("\\\\.\\DISPLAY2: 5120 by 1440 at (5120, 700), 125% scale");
  });
  test("primary and named", () => {
    expect(describeDisplay(main)).toBe("MAIN: 2560 by 1440 at (0, 0), primary");
    expect(describeDisplay(left)).toBe("Dell U2720Q (LEFT): 1920 by 1080 at (-1920, 0)");
  });
});
