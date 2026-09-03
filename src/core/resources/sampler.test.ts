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
      services: [{ pid: 999, id: "supervisor" }],
      unattributedRssFloor: 0,
    });
    expect(first.snapshot.machine.cpu_percent).toBeNull();
    writeProcSnapshot(procRoot, { total: 1_200, idle: 550, processTicks: 40 });
    const second = sampleResources(root, first.state, {
      procRoot,
      nowMs: 3_000,
      clockTicks: 100,
      pageSize: 4_096,
      services: [{ pid: 999, id: "supervisor" }],
      unattributedRssFloor: 0,
    });
    expect(second.snapshot.machine.cpu_percent).toBe(75);
    expect(second.snapshot.interval_ms).toBe(2_000);
    expect(second.snapshot.processes).toHaveLength(1);
    expect(second.snapshot.processes[0]?.cpu_percent).toBeGreaterThan(0);
    expect(second.snapshot.processes[0]?.rss_bytes).toBe(40_960);
  });

  test("carries kernel reclaim rates onto the snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-resources-vmstat-"));
    roots.push(root);
    const procRoot = join(root, "proc");
    mkdirSync(procRoot, { recursive: true });
    writeProcSnapshot(procRoot, { total: 1_000, idle: 500, processTicks: 20 });
    const options = { procRoot, clockTicks: 100, pageSize: 4_096, unattributedRssFloor: 0 };
    writeFileSync(
      join(procRoot, "vmstat"),
      "pswpin 0\npswpout 100\npgscan_direct 1000\npgmajfault 10\n",
    );
    const first = sampleResources(root, undefined, { ...options, nowMs: 1_000 });
    expect(first.snapshot.schema_version).toBe(2);
    expect(first.snapshot.vmstat).toMatchObject({
      state: "supported",
      swap_out_bytes_per_second: null,
      counters_reset: true,
    });
    writeFileSync(
      join(procRoot, "vmstat"),
      "pswpin 0\npswpout 200\npgscan_direct 3000\npgmajfault 30\n",
    );
    const second = sampleResources(root, first.state, { ...options, nowMs: 3_000 });
    expect(second.snapshot.vmstat).toMatchObject({
      state: "supported",
      swap_in_bytes_per_second: 0,
      swap_out_bytes_per_second: 204_800,
      direct_reclaim_pages_per_second: 1_000,
      major_faults_per_second: 10,
      counters_reset: false,
    });
  });

  test("attributes descendants to the nearest live service anchor", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-resources-service-"));
    roots.push(root);
    const procRoot = join(root, "proc");
    mkdirSync(procRoot, { recursive: true });
    writeSystemFiles(procRoot, { total: 1_000, idle: 500 });
    writeProcess(procRoot, { pid: 200, ppid: 1, startTicks: 100, processTicks: 20 });
    writeProcess(procRoot, { pid: 201, ppid: 200, startTicks: 110, processTicks: 10 });
    const result = sampleResources(root, undefined, {
      procRoot,
      nowMs: 1_000,
      clockTicks: 100,
      pageSize: 4_096,
      services: [{ pid: 200, id: "dashboard" }],
      unattributedRssFloor: 0,
    });
    expect(result.snapshot.processes).toMatchObject([
      {
        pid: 200,
        owner_kind: "service",
        owner_id: "dashboard",
        owner_root_pid: 200,
        owner_source: "service",
      },
      {
        pid: 201,
        owner_kind: "service",
        owner_id: "dashboard",
        owner_root_pid: 200,
        owner_source: "service",
      },
    ]);
    expect(result.snapshot.groups).toMatchObject([
      { kind: "service", id: "dashboard", process_count: 2, root_pids: [200] },
    ]);
  });

  test("attributes a Codex WSL process tree from exact live session identity", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-resources-codex-wsl-"));
    roots.push(root);
    const procRoot = join(root, "proc");
    mkdirSync(procRoot, { recursive: true });
    writeSystemFiles(procRoot, { total: 1_000, idle: 500 });
    const environment = codexWslEnvironment("session-1");
    writeProcess(procRoot, {
      pid: 200,
      ppid: 1,
      startTicks: 100,
      processTicks: 20,
      environment,
    });
    writeProcess(procRoot, {
      pid: 201,
      ppid: 200,
      startTicks: 110,
      processTicks: 10,
      environment,
    });
    writeProcess(procRoot, { pid: 202, ppid: 201, startTicks: 120, processTicks: 5 });

    const result = sampleResources(root, undefined, {
      procRoot,
      nowMs: 1_000,
      clockTicks: 100,
      pageSize: 4_096,
      sessionOwners: [liveCodexOwner()],
      unattributedRssFloor: 0,
    });

    expect(result.snapshot.processes).toMatchObject([
      {
        pid: 200,
        owner_kind: "agent",
        owner_id: "agent-1",
        owner_root_pid: 200,
        owner_source: "session-environment",
      },
      {
        pid: 201,
        owner_kind: "agent",
        owner_id: "agent-1",
        owner_root_pid: 200,
        owner_source: "session-environment",
      },
      {
        pid: 202,
        owner_kind: "agent",
        owner_id: "agent-1",
        owner_root_pid: 200,
        owner_source: "session-environment",
      },
    ]);
    expect(result.state?.process_owners).toEqual(
      new Map([
        ["200:100", { session_id: "session-1", instance_id: "agent-1" }],
        ["201:110", { session_id: "session-1", instance_id: "agent-1" }],
      ]),
    );
  });

  test("rejects incomplete, mismatched, delegated, stale, and ambiguous bridge identity", () => {
    const cases = [
      {
        name: "missing bridge marker",
        environment: codexWslEnvironment("session-1").filter(
          (entry) => !entry.startsWith("HARNERY_AGENT_COORD_BRIDGE="),
        ),
        owners: [liveCodexOwner()],
      },
      {
        name: "mismatched native session",
        environment: codexWslEnvironment("session-1", "session-2"),
        owners: [liveCodexOwner()],
      },
      {
        name: "delegated-only session",
        environment: codexWslEnvironment("session-1"),
        owners: [{ ...liveCodexOwner(), kind: "subagent" }],
      },
      {
        name: "stale session",
        environment: codexWslEnvironment("session-1"),
        owners: [],
      },
      {
        name: "ambiguous session",
        environment: codexWslEnvironment("session-1"),
        owners: [liveCodexOwner(), { ...liveCodexOwner(), instanceId: "agent-2" }],
      },
    ];

    for (const fixture of cases) {
      const root = mkdtempSync(join(tmpdir(), "harnery-resources-rejected-"));
      roots.push(root);
      const procRoot = join(root, "proc");
      mkdirSync(procRoot, { recursive: true });
      writeSystemFiles(procRoot, { total: 1_000, idle: 500 });
      writeProcess(procRoot, {
        pid: 200,
        ppid: 1,
        startTicks: 100,
        processTicks: 20,
        environment: fixture.environment,
      });
      const result = sampleResources(root, undefined, {
        procRoot,
        nowMs: 1_000,
        clockTicks: 100,
        pageSize: 4_096,
        sessionOwners: fixture.owners,
        unattributedRssFloor: 0,
      });
      expect(result.snapshot.processes[0]?.owner_kind, fixture.name).toBe("unattributed");
      expect(result.snapshot.processes[0]?.owner_source, fixture.name).toBeUndefined();
    }
  });

  test("revalidates cached bridge proof against current live coordination", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-resources-cached-owner-"));
    roots.push(root);
    const procRoot = join(root, "proc");
    mkdirSync(procRoot, { recursive: true });
    writeSystemFiles(procRoot, { total: 1_000, idle: 500 });
    writeProcess(procRoot, {
      pid: 200,
      ppid: 1,
      startTicks: 100,
      processTicks: 20,
      environment: codexWslEnvironment("session-1"),
    });
    const first = sampleResources(root, undefined, {
      procRoot,
      nowMs: 1_000,
      clockTicks: 100,
      pageSize: 4_096,
      sessionOwners: [liveCodexOwner()],
      unattributedRssFloor: 0,
    });
    rmSync(join(procRoot, "200", "environ"));
    const cached = sampleResources(root, first.state, {
      procRoot,
      nowMs: 2_000,
      clockTicks: 100,
      pageSize: 4_096,
      sessionOwners: [liveCodexOwner()],
      unattributedRssFloor: 0,
    });
    expect(cached.snapshot.processes[0]?.owner_source).toBe("session-environment");

    const expired = sampleResources(root, cached.state, {
      procRoot,
      nowMs: 3_000,
      clockTicks: 100,
      pageSize: 4_096,
      sessionOwners: [],
      unattributedRssFloor: 0,
    });
    expect(expired.snapshot.processes[0]?.owner_kind).toBe("unattributed");
    expect(expired.state?.process_owners.size).toBe(0);
  });
});

function liveCodexOwner(): {
  nativeSessionId: string;
  instanceId: string;
  platform: string;
  kind: string;
} {
  return {
    nativeSessionId: "session-1",
    instanceId: "agent-1",
    platform: "codex",
    kind: "session",
  };
}

function codexWslEnvironment(sessionId: string, codexThreadId = sessionId): string[] {
  return [
    "HARNERY_AGENT_COORD_BRIDGE=codex-wsl",
    "HARNERY_AGENT_COORD_PLATFORM=codex",
    `HARNERY_AGENT_COORD_SESSION_ID=${sessionId}`,
    `CODEX_THREAD_ID=${codexThreadId}`,
    "UNRELATED_SECRET=must-not-be-retained",
  ];
}

function writeProcSnapshot(
  procRoot: string,
  values: { total: number; idle: number; processTicks: number },
): void {
  writeSystemFiles(procRoot, values);
  writeProcess(procRoot, {
    pid: 123,
    ppid: 1,
    startTicks: 100,
    processTicks: values.processTicks,
  });
}

function writeSystemFiles(procRoot: string, values: { total: number; idle: number }): void {
  const system = Math.max(0, values.total - values.idle - 100);
  writeFileSync(join(procRoot, "stat"), `cpu 100 ${system} 0 ${values.idle} 0 0 0 0 0 0\n`);
  writeFileSync(
    join(procRoot, "meminfo"),
    "MemTotal:       1000000 kB\nMemAvailable:    500000 kB\nSwapTotal:       100000 kB\nSwapFree:         75000 kB\n",
  );
  writeFileSync(join(procRoot, "uptime"), "1000.00 0.00\n");
}

function writeProcess(
  procRoot: string,
  values: {
    pid: number;
    ppid: number;
    startTicks: number;
    processTicks: number;
    environment?: readonly string[];
  },
): void {
  mkdirSync(join(procRoot, String(values.pid)), { recursive: true });
  const fields = Array.from({ length: 22 }, () => "0");
  fields[0] = "S";
  fields[1] = String(values.ppid);
  fields[11] = String(values.processTicks);
  fields[12] = "0";
  fields[19] = String(values.startTicks);
  fields[21] = "10";
  writeFileSync(
    join(procRoot, String(values.pid), "stat"),
    `${values.pid} (node worker) ${fields.join(" ")}\n`,
  );
  writeFileSync(join(procRoot, String(values.pid), "cmdline"), "node\0worker.js\0");
  if (values.environment) {
    writeFileSync(
      join(procRoot, String(values.pid), "environ"),
      `${values.environment.join("\0")}\0`,
    );
  }
}
