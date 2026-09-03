import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSystemResources, type SystemResourceOptions } from "./system.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harnery-system-resources-"));
  roots.push(root);
  const procRoot = join(root, "proc");
  const sysRoot = join(root, "sys");
  mkdirSync(join(procRoot, "pressure"), { recursive: true });
  mkdirSync(join(sysRoot, "block"), { recursive: true });
  const options: SystemResourceOptions = {
    platform: "linux",
    procRoot,
    sysRoot,
    tmpPath: root,
    statfs: () => ({ bsize: 4_096, blocks: 100, bfree: 40, bavail: 30 }),
    nowMs: 1_000,
  };
  return { root, procRoot, sysRoot, options };
}

function addDevice(sysRoot: string, device: string, slaves: string[] = []) {
  const path = join(sysRoot, "block", device, "slaves");
  mkdirSync(path, { recursive: true });
  for (const slave of slaves) writeFileSync(join(path, slave), "");
}

function diskLine(device: string, read: number, write: number, minor = 0): string {
  return `8 ${minor} ${device} 1 0 ${read} 0 1 0 ${write} 0 0 0 0\n`;
}

function vmstatText(values: {
  pswpin: number;
  pswpout: number;
  direct: number;
  major: number;
}): string {
  return [
    "pgfault 4096",
    `pswpin ${values.pswpin}`,
    `pswpout ${values.pswpout}`,
    `pgscan_direct ${values.direct}`,
    // A neighbouring counter whose name extends pgscan_direct must never be read as it.
    "pgscan_direct_throttle 7",
    `pgmajfault ${values.major}`,
    "oom_kill 0",
    "",
  ].join("\n");
}

describe("system resource collection", () => {
  test("reports available capacity separately from reserved filesystem blocks", () => {
    const { root, options } = fixture();
    const sample = collectSystemResources(root, options);
    expect(sample.disks).toEqual([
      {
        path: root,
        state: "supported",
        total_bytes: 409_600,
        available_bytes: 122_880,
        used_percent: 60,
      },
    ]);
  });

  test("deduplicates workspace and temporary paths on the same filesystem", () => {
    const { root, options } = fixture();
    options.tmpPath = join(root, "temp");
    options.filesystemId = () => 42;
    expect(collectSystemResources(root, options).disks).toHaveLength(1);
    options.filesystemId = (path) => path;
    expect(collectSystemResources(root, options).disks).toHaveLength(2);
  });

  test("does not mistake unavailable disk capacity for zero usage", () => {
    const { root, options } = fixture();
    options.tmpPath = join(root, "denied");
    options.statfs = (path) => {
      if (path === options.tmpPath) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return { bsize: 4_096n, blocks: 100n, bfree: 40n, bavail: 30n };
    };
    expect(collectSystemResources(root, options).disks[1]).toMatchObject({
      state: "error",
      reason: "EACCES",
      total_bytes: null,
      available_bytes: null,
      used_percent: null,
    });
  });

  test("clamps negative available blocks and rejects invalid capacity counters", () => {
    const { root, options } = fixture();
    options.statfs = () => ({ bsize: 4_096, blocks: 100, bfree: 40, bavail: -5 });
    expect(collectSystemResources(root, options).disks[0]?.available_bytes).toBe(0);
    options.statfs = () => ({ bsize: 4_096, blocks: 0, bfree: 0, bavail: 0 });
    expect(collectSystemResources(root, options).disks[0]?.state).toBe("error");
  });

  test.each([
    "darwin",
    "win32",
  ] as const)("collects disk capacity on %s without claiming Linux PSI support", (platform) => {
    const { root, options } = fixture();
    const result = collectSystemResources(root, { ...options, platform });
    expect(result.disks[0]?.state).toBe("supported");
    expect(result.pressure).toMatchObject({
      state: "unsupported",
      cpu: null,
      memory: null,
      io: null,
    });
    expect(result.io).toMatchObject({
      state: "unsupported",
      read_bytes_per_second: null,
      write_bytes_per_second: null,
    });
  });

  test("keeps some and full PSI distinct and omits undefined system-wide CPU full", () => {
    const { root, procRoot, options } = fixture();
    for (const resource of ["cpu", "memory", "io"]) {
      writeFileSync(
        join(procRoot, "pressure", resource),
        "some avg10=1.25 avg60=2.50 avg300=3.75 total=100000\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
      );
    }
    expect(collectSystemResources(root, options).pressure).toEqual({
      state: "supported",
      cpu: { avg10: 1.25, avg60: 2.5, avg300: 3.75 },
      memory: { avg10: 1.25, avg60: 2.5, avg300: 3.75 },
      io: { avg10: 1.25, avg60: 2.5, avg300: 3.75 },
      memory_full: { avg10: 0, avg60: 0, avg300: 0 },
      io_full: { avg10: 0, avg60: 0, avg300: 0 },
    });
  });

  test("distinguishes unsupported, malformed, and partly available PSI", () => {
    const { root, procRoot, options } = fixture();
    expect(collectSystemResources(root, options).pressure.state).toBe("unsupported");
    writeFileSync(join(procRoot, "pressure", "cpu"), "some avg10=no avg60=0 avg300=0 total=0\n");
    expect(collectSystemResources(root, options).pressure).toMatchObject({
      state: "error",
      cpu: null,
    });
    writeFileSync(
      join(procRoot, "pressure", "memory"),
      "some avg10=1 avg60=0 avg300=0 total=0\nfull avg10=0.5 avg60=0 avg300=0 total=0\n",
    );
    const partial = collectSystemResources(root, options).pressure;
    expect(partial.state).toBe("partial");
    expect(partial.reason).toContain("Malformed PSI avg10");
    expect(partial.memory?.avg10).toBe(1);
    expect(partial.memory_full?.avg10).toBe(0.5);
  });

  test.each([
    "some avg10=101 avg60=0 avg300=0 total=0\n",
    "some avg10=0 avg60=0 total=0\n",
    "some avg10=0 avg60=0 avg300=0 total=0 avg10=0\n",
    "some avg10=0 avg60=0 avg300=0 total=0\nsome avg10=0 avg60=0 avg300=0 total=0\n",
  ])("rejects malformed PSI row %s", (text) => {
    const { root, procRoot, options } = fixture();
    writeFileSync(join(procRoot, "pressure", "cpu"), text);
    expect(collectSystemResources(root, options).pressure.state).toBe("error");
  });

  test("calculates byte rates from whole underlying disks without partitions or stacked-device double counts", () => {
    const { root, procRoot, sysRoot, options } = fixture();
    addDevice(sysRoot, "sda");
    addDevice(sysRoot, "dm-0", ["sda1"]);
    addDevice(sysRoot, "loop0");
    writeFileSync(
      join(procRoot, "diskstats"),
      diskLine("sda", 100, 200) +
        diskLine("sda1", 100, 200, 1) +
        diskLine("dm-0", 100, 200) +
        diskLine("loop0", 100, 200),
    );
    expect(collectSystemResources(root, options).io).toMatchObject({
      state: "supported",
      read_bytes_per_second: null,
    });
    writeFileSync(
      join(procRoot, "diskstats"),
      diskLine("sda", 110, 220) +
        diskLine("sda1", 110, 220, 1) +
        diskLine("dm-0", 110, 220) +
        diskLine("loop0", 110, 220),
    );
    expect(collectSystemResources(root, { ...options, nowMs: 3_000 }).io).toEqual({
      state: "supported",
      read_bytes_per_second: 2_560,
      write_bytes_per_second: 5_120,
    });
  });

  test("detects new OOM kills without reporting historic totals or resets as new incidents", () => {
    const { root, procRoot, options } = fixture();
    const file = join(procRoot, "vmstat");
    const sample = (kills: number, nowMs: number) => {
      writeFileSync(file, `pgfault 100\noom_kill ${kills}\n`);
      return collectSystemResources(root, { ...options, nowMs }).oom;
    };
    expect(sample(12, 1_000)).toMatchObject({
      state: "supported",
      total_kills: 12,
      kills_since_last_sample: null,
      last_kill_age_ms: null,
    });
    expect(sample(12, 3_000).kills_since_last_sample).toBe(0);
    expect(sample(14, 5_000)).toMatchObject({ kills_since_last_sample: 2, last_kill_age_ms: 0 });
    expect(sample(14, 7_000)).toMatchObject({
      kills_since_last_sample: 0,
      last_kill_age_ms: 2_000,
    });
    expect(
      collectSystemResources(join(root, "other"), { ...options, nowMs: 9_000 }).oom
        .last_kill_age_ms,
    ).toBeNull();
    expect(sample(1, 9_000)).toMatchObject({
      kills_since_last_sample: null,
      last_kill_age_ms: null,
    });
    expect(sample(2, 9_000).kills_since_last_sample).toBeNull();
    expect(sample(2, 11_000).kills_since_last_sample).toBe(0);
    writeFileSync(file, "oom_kill broken\n");
    expect(collectSystemResources(root, { ...options, nowMs: 13_000 }).oom.state).toBe("error");
    expect(sample(30, 15_000).kills_since_last_sample).toBeNull();
    writeFileSync(file, "pgfault 200\n");
    expect(collectSystemResources(root, options).oom.state).toBe("unsupported");
  });

  test("rejects missing or malformed full PSI instead of fabricating a healthy full-stall value", () => {
    const { root, procRoot, options } = fixture();
    for (const full of ["", "full avg10=NaN avg60=0 avg300=0 total=0\n"]) {
      writeFileSync(
        join(procRoot, "pressure", "memory"),
        `some avg10=1 avg60=0 avg300=0 total=0\n${full}`,
      );
      expect(collectSystemResources(root, options).pressure).toMatchObject({
        state: "error",
        memory_full: null,
      });
    }
  });

  test("restarts the I/O baseline on counter reset, changed devices, and nonadvancing time", () => {
    const { root, procRoot, sysRoot, options } = fixture();
    addDevice(sysRoot, "sda");
    const file = join(procRoot, "diskstats");
    writeFileSync(file, diskLine("sda", 100, 200));
    collectSystemResources(root, options);
    writeFileSync(file, diskLine("sda", 10, 20));
    expect(
      collectSystemResources(root, { ...options, nowMs: 3_000 }).io.read_bytes_per_second,
    ).toBeNull();
    writeFileSync(file, diskLine("sda", 20, 40));
    expect(
      collectSystemResources(root, { ...options, nowMs: 5_000 }).io.read_bytes_per_second,
    ).toBe(2_560);
    addDevice(sysRoot, "sdb");
    writeFileSync(file, diskLine("sda", 30, 60) + diskLine("sdb", 10, 20, 16));
    expect(collectSystemResources(root, { ...options, nowMs: 7_000 }).io.reason).toContain(
      "devices changed",
    );
    expect(collectSystemResources(root, { ...options, nowMs: 7_000 }).io.reason).toContain(
      "did not advance",
    );
  });

  test("does not reuse baselines across coordination roots or namespaces", () => {
    const { root, procRoot, sysRoot, options } = fixture();
    addDevice(sysRoot, "sda");
    writeFileSync(join(procRoot, "diskstats"), diskLine("sda", 100, 200));
    collectSystemResources(root, options);
    const next = { ...options, nowMs: 3_000 };
    expect(collectSystemResources(join(root, "another"), next).io.read_bytes_per_second).toBeNull();
    expect(
      collectSystemResources(root, { ...next, namespace: "wsl" }).io.read_bytes_per_second,
    ).toBeNull();
  });

  test("reports malformed diskstats explicitly and clears the old baseline", () => {
    const { root, procRoot, sysRoot, options } = fixture();
    addDevice(sysRoot, "sda");
    const file = join(procRoot, "diskstats");
    writeFileSync(file, diskLine("sda", 100, 200));
    collectSystemResources(root, options);
    writeFileSync(file, "8 0 sda broken\n");
    expect(collectSystemResources(root, { ...options, nowMs: 3_000 }).io).toMatchObject({
      state: "error",
      read_bytes_per_second: null,
      reason: "Malformed diskstats for sda.",
    });
    writeFileSync(file, diskLine("sda", 200, 400));
    expect(
      collectSystemResources(root, { ...options, nowMs: 5_000 }).io.read_bytes_per_second,
    ).toBeNull();
  });

  test("derives reclaim rates from two consecutive vmstat reads", () => {
    const { root, procRoot, options } = fixture();
    const file = join(procRoot, "vmstat");
    writeFileSync(file, vmstatText({ pswpin: 5, pswpout: 100, direct: 1_000, major: 10 }));
    expect(collectSystemResources(root, options).vmstat).toEqual({
      state: "supported",
      swap_in_bytes_per_second: null,
      swap_out_bytes_per_second: null,
      direct_reclaim_pages_per_second: null,
      major_faults_per_second: null,
      counters_reset: true,
      reason: "Reclaim rates need two consecutive counters, so a baseline started.",
    });
    writeFileSync(file, vmstatText({ pswpin: 5, pswpout: 200, direct: 3_000, major: 30 }));
    expect(collectSystemResources(root, { ...options, nowMs: 3_000 }).vmstat).toEqual({
      state: "supported",
      swap_in_bytes_per_second: 0,
      swap_out_bytes_per_second: 204_800,
      direct_reclaim_pages_per_second: 1_000,
      major_faults_per_second: 10,
      counters_reset: false,
    });
  });

  test("starts a new reclaim baseline when a counter decreases or the clock stalls", () => {
    const { root, procRoot, options } = fixture();
    const file = join(procRoot, "vmstat");
    writeFileSync(file, vmstatText({ pswpin: 5, pswpout: 400, direct: 1_000, major: 10 }));
    collectSystemResources(root, options);
    writeFileSync(file, vmstatText({ pswpin: 5, pswpout: 40, direct: 1_100, major: 12 }));
    const reset = collectSystemResources(root, { ...options, nowMs: 3_000 }).vmstat;
    expect(reset).toMatchObject({
      state: "supported",
      swap_out_bytes_per_second: null,
      direct_reclaim_pages_per_second: null,
      counters_reset: true,
    });
    expect(reset.reason).toContain("decreased");
    writeFileSync(file, vmstatText({ pswpin: 5, pswpout: 60, direct: 1_200, major: 14 }));
    expect(collectSystemResources(root, { ...options, nowMs: 3_000 }).vmstat.reason).toContain(
      "did not advance",
    );
    expect(
      collectSystemResources(root, { ...options, nowMs: 5_000 }).vmstat.swap_out_bytes_per_second,
    ).toBe(0);
  });

  test("reports missing reclaim counters instead of reading them as zero activity", () => {
    const { root, procRoot, options } = fixture();
    const file = join(procRoot, "vmstat");
    expect(collectSystemResources(root, options).vmstat).toMatchObject({
      state: "unsupported",
      swap_out_bytes_per_second: null,
      counters_reset: false,
      reason: "ENOENT",
    });
    writeFileSync(file, "pgfault 100\noom_kill 3\n");
    expect(collectSystemResources(root, { ...options, nowMs: 3_000 }).vmstat).toMatchObject({
      state: "unsupported",
      counters_reset: false,
      reason: "Kernel does not expose the memory reclaim counters.",
    });
    writeFileSync(file, "pswpout 100\npgmajfault 10\n");
    const first = collectSystemResources(root, { ...options, nowMs: 5_000 }).vmstat;
    expect(first.state).toBe("partial");
    expect(first.reason).toContain("pswpin, pgscan_direct");
    writeFileSync(file, "pswpout 200\npgmajfault 30\n");
    expect(collectSystemResources(root, { ...options, nowMs: 7_000 }).vmstat).toEqual({
      state: "partial",
      swap_in_bytes_per_second: null,
      swap_out_bytes_per_second: 204_800,
      direct_reclaim_pages_per_second: null,
      major_faults_per_second: 10,
      counters_reset: false,
      reason: "Kernel does not expose pswpin, pgscan_direct.",
    });
  });

  test.each([
    "pswpout notanumber\n",
    "pswpout 100 200\n",
    "pswpout -5\n",
    "pswpout 100\npswpout 200\n",
  ])("rejects malformed vmstat row %s", (text) => {
    const { root, procRoot, options } = fixture();
    writeFileSync(join(procRoot, "vmstat"), text);
    expect(collectSystemResources(root, options).vmstat).toMatchObject({
      state: "error",
      swap_out_bytes_per_second: null,
      counters_reset: false,
    });
  });

  test("does not reuse reclaim baselines across coordination roots", () => {
    const { root, procRoot, options } = fixture();
    writeFileSync(
      join(procRoot, "vmstat"),
      vmstatText({ pswpin: 1, pswpout: 100, direct: 10, major: 1 }),
    );
    collectSystemResources(root, options);
    writeFileSync(
      join(procRoot, "vmstat"),
      vmstatText({ pswpin: 1, pswpout: 200, direct: 20, major: 2 }),
    );
    expect(
      collectSystemResources(join(root, "another"), { ...options, nowMs: 3_000 }).vmstat
        .counters_reset,
    ).toBe(true);
  });

  test("bounds counter file reads", () => {
    const { root, procRoot, options } = fixture();
    writeFileSync(join(procRoot, "pressure", "cpu"), "x".repeat(4_097));
    const result = collectSystemResources(root, options);
    expect(result.pressure.state).toBe("error");
    expect(result.pressure.reason).toContain("collector limit");
  });
});
