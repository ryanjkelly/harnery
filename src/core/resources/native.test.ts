import { describe, expect, test } from "bun:test";
import type { CpuInfo } from "node:os";
import {
  createWindowsHostBackgroundCollector,
  createWindowsHostCollector,
  type NativeResourceSamplerOptions,
  parseMacSwapUsage,
  parseMacVmStat,
  parseWindowsResourceOutput,
  sampleNativeResources,
} from "./native.ts";

const macVm = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 100.
Pages inactive: 200.
Pages speculative: 20.
Pages purgeable: 150.
Pages occupied by compressor: 500.
`;

function cpu(user = 100, idle = 300): CpuInfo[] {
  return [{ model: "fixture", speed: 2_000, times: { user, idle, nice: 0, sys: 0, irq: 0 } }];
}

function options(
  overrides: Partial<NativeResourceSamplerOptions> = {},
): NativeResourceSamplerOptions {
  return {
    platform: "darwin",
    nowMs: 1_000,
    os: {
      cpus: () => cpu(),
      totalmem: () => 16 * 1_024 ** 3,
      freemem: () => 1_024 ** 3,
      availableParallelism: () => 1,
      loadavg: () => [1.2, 1.1, 1],
    },
    command: (file) => {
      if (file === "vm_stat") return macVm;
      if (file === "sysctl") return "total = 2048.00M used = 512.00M free = 1536.00M (encrypted)";
      if (file === "ps") return "   1\n  42\n 100\n";
      return null;
    },
    ...overrides,
  };
}

function windowsFixture(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sampled_at: "2026-09-03T06:00:00.000Z",
    memory_total_kib: "16777216",
    memory_available_kib: "4194304",
    process_count: 123,
    processors: [
      { NumberOfLogicalProcessors: 4, LoadPercentage: 20 },
      { NumberOfLogicalProcessors: 12, LoadPercentage: 60 },
    ],
    pagefiles: [{ AllocatedBaseSize: 4096, CurrentUsage: 1024 }],
    disks: [{ DeviceID: "C:", Size: "1000000000", FreeSpace: "250000000" }],
    ...overrides,
  });
}

describe("native machine resources", () => {
  test("macOS reports real memory, swap and process count with explicit partial attribution", () => {
    const result = sampleNativeResources("/unused", undefined, options());
    expect(result.snapshot.platform).toBe("darwin");
    expect(result.snapshot.namespace).toBe("host");
    expect(result.snapshot.support.state).toBe("partial");
    expect(result.snapshot.support.reason).toContain("native_process_attribution_unavailable");
    expect(result.snapshot.machine.memory_available_bytes).toBe(320 * 16384);
    expect(result.snapshot.machine.swap_total_bytes).toBe(2 * 1_024 ** 3);
    expect(result.snapshot.machine.swap_used_bytes).toBe(512 * 1_024 ** 2);
    expect(result.snapshot.machine.process_count).toBe(3);
    expect(result.snapshot.machine.cpu_percent).toBeNull();
    expect(result.snapshot.machine.cpu_available_parallelism).toBe(1);
    expect(result.snapshot.machine.load_average).toEqual([1.2, 1.1, 1]);
    expect(result.snapshot.processes).toEqual([]);
  });

  test("CPU usage requires valid consecutive counters and recovers after reset", () => {
    const firstOptions = options();
    const first = sampleNativeResources("/unused", undefined, firstOptions);
    const secondOptions = {
      ...firstOptions,
      nowMs: 3_000,
      os: { ...firstOptions.os, cpus: () => cpu(250, 350) },
    };
    const second = sampleNativeResources("/unused", first.state, secondOptions);
    expect(second.snapshot.machine.cpu_percent).toBe(75);
    expect(second.snapshot.interval_ms).toBe(2_000);
    const reset = sampleNativeResources("/unused", second.state, { ...firstOptions, nowMs: 5_000 });
    expect(reset.snapshot.machine.cpu_percent).toBeNull();
    const recovered = sampleNativeResources("/unused", reset.state, {
      ...secondOptions,
      nowMs: 7_000,
    });
    expect(recovered.snapshot.machine.cpu_percent).toBe(75);
    expect(
      sampleNativeResources("/unused", second.state, secondOptions).snapshot.machine.cpu_percent,
    ).toBeNull();
  });

  test("invalid CPU counters do not become zero usage or contaminate future state", () => {
    const base = options();
    for (const rows of [[], cpu(-1), cpu(Number.NaN), cpu(Number.POSITIVE_INFINITY)]) {
      const result = sampleNativeResources("/unused", undefined, {
        ...base,
        os: { ...base.os, cpus: () => rows },
      });
      expect(result.snapshot.machine.cpu_percent).toBeNull();
      expect(result.state).toBeUndefined();
      expect(result.snapshot.support.reason).toContain("cpu_counters_unavailable");
    }
  });

  test("inconsistent idle or stalled CPU counters never produce impossible usage", () => {
    const base = options();
    const first = sampleNativeResources("unused", undefined, base);
    for (const rows of [cpu(100, 300), cpu(400, 250), cpu(50, 450)]) {
      const result = sampleNativeResources("unused", first.state, {
        ...base,
        nowMs: 3_000,
        os: { ...base.os, cpus: () => rows },
      });
      expect(result.snapshot.machine.cpu_percent).toBeNull();
    }
  });

  test("thrown optional macOS commands preserve the usable machine sample", () => {
    const result = sampleNativeResources(
      "unused",
      undefined,
      options({
        command: () => {
          throw new Error("denied");
        },
      }),
    );
    expect(result.snapshot.machine.memory_total_bytes).toBe(16 * 1_024 ** 3);
    expect(result.snapshot.machine.process_count).toBeNull();
    expect(result.snapshot.support.state).toBe("partial");
  });

  test("native command failures preserve OS memory and honestly mark unknown process and swap metrics", () => {
    const result = sampleNativeResources("/unused", undefined, options({ command: () => null }));
    expect(result.snapshot.machine.memory_available_bytes).toBe(1_024 ** 3);
    expect(result.snapshot.machine.memory_percent).toBe(93.8);
    expect(result.snapshot.machine.process_count).toBeNull();
    expect(result.snapshot.machine.swap_used_bytes).toBeNull();
    expect(result.snapshot.support.reason).toContain("vm_stat_unavailable_using_free_memory");
  });

  test("Windows machine sampling uses native OS RAM and CPU deltas even without CIM", () => {
    const base = options({ platform: "win32", command: () => null });
    const first = sampleNativeResources("unused", undefined, base);
    const second = sampleNativeResources("unused", first.state, {
      ...base,
      nowMs: 3_000,
      os: { ...base.os, cpus: () => cpu(250, 350) },
    });
    expect(second.snapshot.platform).toBe("win32");
    expect(second.snapshot.machine.cpu_percent).toBe(75);
    expect(second.snapshot.machine.memory_total_bytes).toBe(16 * 1_024 ** 3);
    expect(second.snapshot.machine.memory_available_bytes).toBe(1_024 ** 3);
    expect(second.snapshot.machine.load_average).toBeNull();
    expect(second.snapshot.machine.process_count).toBeNull();
  });

  test("Windows native auxiliary values preserve pagefile units and actual process count", () => {
    const result = sampleNativeResources(
      "unused",
      undefined,
      options({ platform: "win32", command: () => windowsFixture() }),
    );
    expect(result.snapshot.machine.process_count).toBe(123);
    expect(result.snapshot.machine.swap_total_bytes).toBe(4 * 1_024 ** 3);
    expect(result.snapshot.machine.swap_used_bytes).toBe(1_024 ** 3);
  });
});

describe("macOS native parsers", () => {
  test("uses runtime page size, excludes overlapping purgeable pages and tolerates old output", () => {
    expect(parseMacVmStat(macVm)).toEqual({ available_bytes: 320 * 16384 });
    expect(
      parseMacVmStat(macVm.replace("16384", "4096").replace("Pages speculative: 20.\n", "")),
    ).toEqual({ available_bytes: 300 * 4096 });
    expect(parseMacVmStat("Pages free: 42.")).toBeNull();
    expect(
      parseMacVmStat(macVm.replace("Pages inactive: 200.", "Pages inactive: oops.")),
    ).toBeNull();
    expect(parseMacVmStat(macVm.replace("Pages free: 100.", "Pages free: -100."))).toBeNull();
    expect(
      parseMacVmStat(macVm.replace("Pages speculative: 20.", "Pages speculative: oops.")),
    ).toBeNull();
  });

  test("swap distinguishes an empty swap file from malformed or inconsistent counters", () => {
    expect(parseMacSwapUsage("total = 2048 used = 1024")).toEqual({ total: 2048, used: 1024 });
    expect(parseMacSwapUsage("total = 0.00M used = 0.00M free = 0.00M")).toEqual({
      total: 0,
      used: 0,
    });
    expect(parseMacSwapUsage("total = 2G used = 512M")).toEqual({
      total: 2 * 1_024 ** 3,
      used: 512 * 1_024 ** 2,
    });
    for (const malformed of [
      "",
      "total = oopsM used = 1M",
      "total = 1M used = 2M",
      "total = -1M used = 0M",
    ]) {
      expect(parseMacSwapUsage(malformed)).toBeNull();
    }
  });
});

describe("Windows host resources for WSL", () => {
  test("background collection returns pending immediately and shares one in-flight probe", async () => {
    const collect = createWindowsHostBackgroundCollector();
    let calls = 0;
    let finish!: (value: string) => void;
    const command = () => {
      calls++;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    };
    const pending = collect({ command, nowMs: 1_000 });
    expect(pending.reason).toBe("windows_host_query_pending");
    expect(pending.machine).toBeNull();
    expect(calls).toBe(0);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(collect({ command, nowMs: 60_000 })).toBe(pending);
    expect(calls).toBe(1);
    finish(windowsFixture());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sampled = collect({ command, nowMs: 2_000 });
    expect(sampled.state).toBe("supported");
    expect(sampled.machine?.cpu_percent).toBe(50);
    expect(collect({ command, nowMs: 15_999 })).toBe(sampled);
    expect(calls).toBe(1);
    collect({ command, nowMs: 16_000 });
    await Promise.resolve();
    expect(calls).toBe(2);
    finish(windowsFixture());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("background failures remain cached and do not become unhandled rejections", async () => {
    const collect = createWindowsHostBackgroundCollector();
    let calls = 0;
    const command = async () => {
      calls++;
      throw new Error("query denied");
    };
    collect({ command, nowMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = collect({ command, nowMs: 2_000 });
    expect(failed.state).toBe("error");
    expect(failed.reason).toBe("windows_host_query_failed");
    expect(collect({ command, nowMs: 14_999 })).toBe(failed);
    expect(calls).toBe(1);
  });

  test("labels the independently timestamped host and weights CPU across logical processor counts", () => {
    const result = parseWindowsResourceOutput(windowsFixture(), 1_000);
    expect(result.platform).toBe("win32");
    expect(result.sampled_at).toBe("2026-09-03T06:00:00.000Z");
    expect(result.state).toBe("supported");
    expect(result.machine?.cpu_percent).toBe(50);
    expect(result.machine?.cpu_logical_count).toBe(16);
    expect(result.machine?.memory_percent).toBe(75);
    expect(result.machine?.swap_used_bytes).toBe(1_024 ** 3);
    expect(result.disks).toEqual([
      {
        path: "C:\\",
        state: "supported",
        total_bytes: 1_000_000_000,
        available_bytes: 250_000_000,
        used_percent: 75,
      },
    ]);
  });

  test("accepts PowerShell BOM, numeric strings and an explicitly empty pagefile list", () => {
    const result = parseWindowsResourceOutput(`\uFEFF${windowsFixture({ pagefiles: [] })}`);
    expect(result.state).toBe("supported");
    expect(result.machine?.swap_total_bytes).toBe(0);
  });

  test("rejects malformed required data without converting null or garbage into free memory", () => {
    for (const output of [
      "",
      "[]",
      "null",
      "{}",
      "warning\n{}",
      windowsFixture({ memory_available_kib: null }),
      windowsFixture({ memory_available_kib: "" }),
      windowsFixture({ memory_available_kib: "20000000" }),
      windowsFixture({ memory_total_kib: 0 }),
    ]) {
      const result = parseWindowsResourceOutput(output, 1_000);
      expect(result.state).toBe("error");
      expect(result.machine).toBeNull();
    }
  });

  test("missing or invalid optional providers become partial with null values", () => {
    const result = parseWindowsResourceOutput(
      windowsFixture({
        processors: [{ NumberOfLogicalProcessors: 8, LoadPercentage: null }],
        pagefiles: null,
        process_count: null,
        disks: [{ DeviceID: "D:", Size: 100, FreeSpace: 200 }],
      }),
    );
    expect(result.state).toBe("partial");
    expect(result.machine?.cpu_percent).toBeNull();
    expect(result.machine?.cpu_logical_count).toBe(8);
    expect(result.machine?.process_count).toBeNull();
    expect(result.machine?.swap_total_bytes).toBeNull();
    expect(result.disks[0]?.state).toBe("error");
    expect(result.disks[0]?.available_bytes).toBeNull();
  });

  test("caches success and errors for 15 seconds including clock regression recovery", () => {
    const collect = createWindowsHostCollector();
    let calls = 0;
    const command = (file: string, args: readonly string[]) => {
      calls++;
      expect(file).toBe("powershell.exe");
      expect(args).toContain("-NonInteractive");
      expect(args).toContain("-NoProfile");
      expect(args).toContain("-EncodedCommand");
      expect(Buffer.from(args.at(-1)!, "base64").toString("utf16le")).toContain(
        "Get-CimInstance Win32_OperatingSystem",
      );
      return calls === 1 ? windowsFixture() : null;
    };
    const first = collect({ command, nowMs: 1_000 });
    expect(collect({ command, nowMs: 15_999 })).toBe(first);
    expect(calls).toBe(1);
    const failed = collect({ command, nowMs: 16_000 });
    expect(failed.state).toBe("error");
    expect(collect({ command, nowMs: 30_999 })).toBe(failed);
    expect(calls).toBe(2);
    collect({ command, nowMs: 500 });
    expect(calls).toBe(3);
  });

  test("caches thrown command failures and malformed output without launch storms", () => {
    for (const malformed of [true, false]) {
      const collect = createWindowsHostCollector();
      let calls = 0;
      const command = () => {
        calls++;
        if (malformed) return "malformed";
        throw new Error("unavailable");
      };
      const first = collect({ command, nowMs: 0 });
      expect(first.state).toBe("error");
      expect(collect({ command, nowMs: 2_000 })).toBe(first);
      expect(calls).toBe(1);
    }
  });
});
