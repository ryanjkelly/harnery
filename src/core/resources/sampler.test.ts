import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLinuxProcessStat, redactCommand, sampleResources } from "./sampler.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resource sampler", () => {
  test("parses proc stat when the command name contains spaces and parentheses", () => {
    const fields = Array.from({ length: 22 }, () => "0");
    fields[0] = "S";
    fields[1] = "7";
    fields[11] = "12";
    fields[12] = "8";
    fields[19] = "300";
    fields[21] = "42";
    expect(parseLinuxProcessStat(`123 (node (worker)) ${fields.join(" ")}`)).toEqual({
      pid: 123,
      name: "node (worker)",
      state: "S",
      ppid: 7,
      ticks: 20,
      startTicks: 300,
      rssPages: 42,
    });
  });

  test("redacts secret arguments and URL credentials before persistence", () => {
    const command = redactCommand([
      "runner",
      "--token",
      "sensitive-token",
      "--api-key=also-sensitive",
      "https://user:password@example.test/path",
    ]);
    expect(command).not.toContain("sensitive-token");
    expect(command).not.toContain("also-sensitive");
    expect(command).not.toContain("password");
    expect(command).toContain("--token <redacted>");
    expect(command).toContain("--api-key=<redacted>");
    expect(command).toContain("https://<redacted>@example.test/path");
  });

  test("computes machine and process CPU from consecutive samples", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-resources-"));
    roots.push(root);
    const procRoot = join(root, "proc");
    mkdirSync(join(procRoot, "123"), { recursive: true });
    writeProcSnapshot(procRoot, { total: 1_000, idle: 500, processTicks: 20 });
    const first = sampleResources(root, undefined, {
      procRoot,
      nowMs: 1_000,
      clockTicks: 100,
      pageSize: 4_096,
      service: { pid: 999, id: "supervisor" },
      unattributedRssFloor: 0,
    });
    expect(first.snapshot.machine.cpu_percent).toBeNull();
    writeProcSnapshot(procRoot, { total: 1_200, idle: 550, processTicks: 40 });
    const second = sampleResources(root, first.state, {
      procRoot,
      nowMs: 3_000,
      clockTicks: 100,
      pageSize: 4_096,
      service: { pid: 999, id: "supervisor" },
      unattributedRssFloor: 0,
    });
    expect(second.snapshot.machine.cpu_percent).toBe(75);
    expect(second.snapshot.interval_ms).toBe(2_000);
    expect(second.snapshot.processes).toHaveLength(1);
    expect(second.snapshot.processes[0]?.cpu_percent).toBeGreaterThan(0);
    expect(second.snapshot.processes[0]?.rss_bytes).toBe(40_960);
  });
});

function writeProcSnapshot(
  procRoot: string,
  values: { total: number; idle: number; processTicks: number },
): void {
  const system = Math.max(0, values.total - values.idle - 100);
  writeFileSync(join(procRoot, "stat"), `cpu 100 ${system} 0 ${values.idle} 0 0 0 0 0 0\n`);
  writeFileSync(
    join(procRoot, "meminfo"),
    "MemTotal:       1000000 kB\nMemAvailable:    500000 kB\nSwapTotal:       100000 kB\nSwapFree:         75000 kB\n",
  );
  writeFileSync(join(procRoot, "uptime"), "1000.00 0.00\n");
  const fields = Array.from({ length: 22 }, () => "0");
  fields[0] = "S";
  fields[1] = "1";
  fields[11] = String(values.processTicks);
  fields[12] = "0";
  fields[19] = "100";
  fields[21] = "10";
  writeFileSync(join(procRoot, "123", "stat"), `123 (node worker) ${fields.join(" ")}\n`);
  writeFileSync(join(procRoot, "123", "cmdline"), "node\0worker.js\0");
}
