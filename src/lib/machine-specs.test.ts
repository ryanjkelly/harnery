import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import type { SpawnResult } from "./computer/driver-support.ts";
import {
  diskKindFor,
  MACHINE_SPECS_FILE,
  MACHINE_SPECS_SCHEMA_VERSION,
  type MachineSpecsDeps,
  measureLive,
  parseCpuinfo,
  parseLspci,
  parseMacDf,
  parseMacDisplaysProfile,
  parseMacSysctl,
  parseMeminfo,
  parseNvidiaSmi,
  parseOsRelease,
  parseProcMounts,
  parseSwVers,
  parseWindowsCim,
  probeMachineSpecs,
  readMachineSpecs,
  sameBoot,
  selectLocalMounts,
  WINDOWS_SPECS_SCRIPT,
} from "./machine-specs.ts";

// Fixtures: real output captured on a WSL2 guest and its Windows host, trimmed.
const CPUINFO = [0, 1, 2, 3]
  .map(
    (n) => `processor\t: ${n}
vendor_id\t: GenuineIntel
model name\t: 13th Gen Intel(R) Core(TM) i9-13900K
physical id\t: 0
core id\t\t: ${Math.floor(n / 2)}
cpu cores\t: 2
`,
  )
  .join("\n");

const MEMINFO =
  "MemTotal:       24608404 kB\nMemFree:         2279560 kB\nMemAvailable:   13398276 kB\n";

const OS_RELEASE = `PRETTY_NAME="Ubuntu 22.04.5 LTS"
NAME="Ubuntu"
VERSION_ID="22.04"
VERSION="22.04.5 LTS (Jammy Jellyfish)"
ID=ubuntu
`;

const MOUNTS = `none /usr/lib/modules/6.18.33.2-microsoft-standard-WSL2 overlay rw 0 0
drivers /usr/lib/wsl/drivers 9p ro,aname=drivers 0 0
/dev/sdd / ext4 rw,relatime 0 0
none /mnt/wslg tmpfs rw 0 0
/dev/sdd /mnt/wslg/distro ext4 ro,relatime 0 0
C:\\134 /mnt/c 9p rw,aname=drvfs;path=C:\\ 0 0
/dev/sdd /snap ext4 rw,relatime 0 0
/dev/loop0 /mnt/wsl/docker-desktop/cli-tools iso9660 ro 0 0
snapfuse /snap/core22/2437 fuse.snapfuse ro 0 0
C:\\134Program\\040Files\\134Tool /Tool/host 9p rw 0 0
/dev/sde /home/someone/data ext4 rw 0 0
`;

const NVIDIA_SMI = "NVIDIA GeForce RTX 4090, 24564\n";

const LSPCI = `1d65:00:00.0 "3D controller" "Microsoft Corporation" "Device 008e" "" ""
5582:00:00.0 "SCSI storage controller" "Red Hat, Inc." "Virtio console" -r01 "Red Hat, Inc." "Virtio console"
01:00.0 "VGA compatible controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Navi 31" -rc8 "" ""
`;

const WINDOWS_JSON = `HARNERY_SPECS_JSON:${JSON.stringify({
  disks: [{ id: "C:", size: 1999273717760, fs: "NTFS" }],
  cpu: [
    {
      arch: 9,
      logical: 32,
      name: "13th Gen Intel(R) Core(TM) i9-13900K",
      cores: 24,
      vendor: "GenuineIntel",
    },
  ],
  memory: { total: 68477964288, UserName: "EXAMPLE\\someone" },
  os: {
    display_version: "26H2",
    version: "10.0.26300",
    ubr: 9974,
    build: "26300",
    caption: "Microsoft Windows 11 Pro",
    CSName: "SECRET-HOSTNAME",
    SerialNumber: "00000-SERIAL",
  },
  gpus: [
    { name: "Intel(R) UHD Graphics 770", ram: 2147479552, vendor: "Intel Corporation" },
    { name: "NVIDIA GeForce RTX 4090", ram: 4293918720, vendor: "NVIDIA" },
  ],
  vram: [{ name: "NVIDIA GeForce RTX 4090", bytes: 25757220864 }],
})}\r\n`;

const SW_VERS = "ProductName:\t\tmacOS\nProductVersion:\t\t15.1\nBuildVersion:\t\t24B83\n";
const MAC_SYSCTL = "Apple M2 Pro\n10\n10\n34359738368\n";
const MAC_PROFILE = JSON.stringify({
  SPDisplaysDataType: [
    { _name: "Apple M2 Pro", sppci_model: "Apple M2 Pro", spdisplays_vendor: "sppci_vendor_Apple" },
  ],
});
const MAC_DF = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   482797652  10272308 224321552     5%    /
devfs                  205       205         0   100%    /dev
/dev/disk3s6     482797652   2097196 224321552     1%    /System/Volumes/VM
/dev/disk5s1     976490576 100000000 876490576    11%    /Volumes/Backup
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harn-machine-specs-"));
});
afterEach(() => removeDir(dir));

function spawnFake(table: Record<string, Partial<SpawnResult>>) {
  const calls: string[] = [];
  const fn = (command: string, args: string[]): SpawnResult => {
    const key = `${command.split("/").pop()} ${args[0] ?? ""}`.trim();
    calls.push(key);
    const hit = Object.entries(table).find(([k]) => key.startsWith(k))?.[1];
    if (!hit) return { status: null, stdout: "", stderr: "", error: new Error("ENOENT") };
    return { status: 0, stdout: "", stderr: "", ...hit };
  };
  return { fn, calls };
}

const BOOT_ID = "826f3100-069d-4099-80dd-76b39493e854";

function wslDeps(
  overrides: Partial<MachineSpecsDeps> = {},
  files: Record<string, string> = {},
): MachineSpecsDeps {
  const fileMap: Record<string, string> = {
    "/proc/cpuinfo": CPUINFO,
    "/proc/meminfo": MEMINFO,
    "/etc/os-release": OS_RELEASE,
    "/proc/mounts": MOUNTS,
    "/proc/sys/kernel/random/boot_id": `${BOOT_ID}\n`,
    "/sys/block/sdd/queue/rotational": "1\n",
    ...files,
  };
  const spawn = spawnFake({
    "nvidia-smi": { stdout: NVIDIA_SMI },
    "powershell.exe -NoProfile": { stdout: WINDOWS_JSON },
    "bun --version": { stdout: "1.4.4\n" },
    "node --version": { stdout: "v24.22.1\n" },
  });
  return {
    platform: "linux",
    arch: "x64",
    env: { WSL_DISTRO_NAME: "Ubuntu-22.04" },
    isWsl: () => true,
    now: () => Date.parse("2026-11-14T12:00:00Z"),
    readFile: (path) => {
      if (path.startsWith(dir)) {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return undefined;
        }
      }
      return fileMap[path];
    },
    exists: () => false,
    statfs: (path) =>
      ({
        "/": { total_bytes: 810546814976, free_bytes: 277788839936 },
        "/mnt/c": { total_bytes: 1999273717760, free_bytes: 676592054272 },
      })[path],
    spawnSync: spawn.fn,
    kernelRelease: () => "6.18.33.2-microsoft-standard-WSL2",
    logicalCpus: () => 4,
    totalMemory: () => 25199005696,
    freeMemory: () => 1,
    uptime: () => 1000,
    machineLabel: () => "desk",
    harneryVersion: () => "1.2.3",
    host: () => ({ kind: "wsl" }),
    probeDisplays: () => ({
      displays: [
        {
          id: "DISPLAY1",
          primary: true,
          bounds: { x: 0, y: 0, width: 5120, height: 2160 },
          scale: 1.5,
        },
      ],
    }),
    dir,
    ...overrides,
  };
}

describe("parsers", () => {
  test("cpuinfo counts unique cores and threads", () => {
    expect(parseCpuinfo(CPUINFO, "x86_64")).toEqual({
      model: "13th Gen Intel(R) Core(TM) i9-13900K",
      vendor: "GenuineIntel",
      physical_cores: 2,
      logical_cores: 4,
      arch: "x86_64",
    });
  });

  test("meminfo, os-release, nvidia-smi and lspci", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ total: 24608404 * 1024, available: 13398276 * 1024 });
    expect(() => parseMeminfo("nothing")).toThrow();
    const rel = parseOsRelease(OS_RELEASE);
    expect(rel.NAME).toBe("Ubuntu");
    expect(rel.VERSION).toBe("22.04.5 LTS (Jammy Jellyfish)");
    expect(parseNvidiaSmi(NVIDIA_SMI)).toEqual([
      { name: "NVIDIA GeForce RTX 4090", vendor: "NVIDIA", vram_bytes: 24564 * 1024 * 1024 },
    ]);
    expect(parseLspci(LSPCI)).toEqual([
      { name: "Navi 31", vendor: "Advanced Micro Devices, Inc. [AMD/ATI]" },
    ]);
  });

  test("mounts keep real local filesystems once each and skip home paths", () => {
    const mounts = parseProcMounts(MOUNTS);
    expect(mounts.find((m) => m.mount === "/mnt/c")?.device).toBe("C:\\");
    expect(mounts.find((m) => m.mount === "/Tool/host")?.device).toBe("C:\\Program Files\\Tool");
    expect(selectLocalMounts(mounts, "wsl").map((m) => m.mount)).toEqual(["/", "/mnt/c"]);
    expect(selectLocalMounts(mounts, "linux").map((m) => m.mount)).toEqual(["/"]);
  });

  test("disk kind follows the rotational flag of the whole disk", () => {
    const files: Record<string, string> = {
      "/sys/block/nvme0n1/queue/rotational": "0\n",
      "/sys/block/sda/queue/rotational": "1\n",
    };
    const read = (p: string) => files[p];
    expect(diskKindFor("/dev/nvme0n1p2", read)).toBe("ssd");
    expect(diskKindFor("/dev/sda1", read)).toBe("hdd");
    expect(diskKindFor("/dev/mapper/vg-root", read)).toBe("unknown");
  });

  test("Windows CIM JSON prefers the registry VRAM over the 32-bit field", () => {
    const win = parseWindowsCim(WINDOWS_JSON);
    expect(win.os).toEqual({
      platform: "win32",
      name: "Microsoft Windows 11 Pro",
      version: "26H2",
      build: "26300.9974",
      kernel: "10.0.26300",
      arch: "x86_64",
    });
    expect(win.cpu).toMatchObject({
      physical_cores: 24,
      logical_cores: 32,
      vendor: "GenuineIntel",
    });
    expect(win.memory).toEqual({ total_bytes: 68477964288 });
    expect(win.gpus?.[1]).toEqual({
      name: "NVIDIA GeForce RTX 4090",
      vendor: "NVIDIA",
      vram_bytes: 25757220864,
    });
    expect(win.gpus?.[0]?.vram_bytes).toBe(2147479552);
    expect(win.disks).toEqual([
      { mount: "C:\\", filesystem: "NTFS", total_bytes: 1999273717760, kind: "unknown" },
    ]);
    expect(() => parseWindowsCim("#< CLIXML\n")).toThrow("no JSON");
    expect(WINDOWS_SPECS_SCRIPT).not.toMatch(/SerialNumber|CSName|UserName|MACAddress/);
  });

  test("macOS parsers (fixtures only; not verified on a Mac here)", () => {
    expect(parseSwVers(SW_VERS, "arm64", "24.1.0")).toEqual({
      platform: "darwin",
      name: "macOS",
      version: "15.1",
      build: "24B83",
      kernel: "24.1.0",
      arch: "arm64",
    });
    expect(parseMacSysctl(MAC_SYSCTL, "arm64")).toEqual({
      cpu: {
        model: "Apple M2 Pro",
        vendor: "Apple",
        physical_cores: 10,
        logical_cores: 10,
        arch: "arm64",
      },
      memory: 34359738368,
    });
    expect(parseMacDisplaysProfile(MAC_PROFILE)).toEqual([
      { name: "Apple M2 Pro", vendor: "Apple" },
    ]);
    expect(parseMacDf(MAC_DF).map((d) => d.mount)).toEqual(["/", "/Volumes/Backup"]);
  });

  test("boot comparison tolerates uptime drift for derived boot times", () => {
    expect(sameBoot(BOOT_ID, BOOT_ID)).toBe(true);
    expect(sameBoot(BOOT_ID, "other")).toBe(false);
    expect(sameBoot("2026-11-11T05:17:50.000Z", "2026-11-11T05:17:52.000Z")).toBe(true);
    expect(sameBoot("2026-11-11T05:17:50.000Z", "2026-11-12T05:17:50.000Z")).toBe(false);
  });
});

describe("probe", () => {
  test("WSL guest plus Windows host, with privacy", () => {
    const specs = probeMachineSpecs(wslDeps());
    expect(specs).toMatchObject({
      schema_version: MACHINE_SPECS_SCHEMA_VERSION,
      boot_id: BOOT_ID,
      harnery_version: "1.2.3",
      machine_label: "desk",
      host_kind: "wsl",
      os: { name: "Ubuntu", kernel: "6.18.33.2-microsoft-standard-WSL2", arch: "x86_64" },
      cpu: { physical_cores: 2, logical_cores: 4 },
      memory: { total_bytes: 24608404 * 1024 },
      runtimes: { bun: "1.4.4", node: "24.22.1" },
      windows_host: {
        os: { name: "Microsoft Windows 11 Pro" },
        memory: { total_bytes: 68477964288 },
        wsl: { distro: "Ubuntu-22.04", kernel: "6.18.33.2-microsoft-standard-WSL2" },
      },
    });
    expect(specs.disks).toEqual([
      {
        mount: "/",
        device: "/dev/sdd",
        filesystem: "ext4",
        total_bytes: 810546814976,
        kind: "unknown",
      },
      {
        mount: "/mnt/c",
        device: "C:\\",
        filesystem: "9p",
        total_bytes: 1999273717760,
        kind: "unknown",
      },
    ]);
    expect(specs.gpus[0]?.name).toBe("NVIDIA GeForce RTX 4090");
    expect(specs.displays).toHaveLength(1);
    expect(specs.errors).toBeUndefined();
    expect((specs.windows_host as unknown as Record<string, unknown>).disks).toBeUndefined();
    const text = JSON.stringify(specs);
    for (const secret of ["SECRET-HOSTNAME", "SERIAL", "someone", "/home/"])
      expect(text).not.toContain(secret);
  });

  test("a failed section lands in errors and the rest still probes", () => {
    const specs = probeMachineSpecs(
      wslDeps(
        {
          probeDisplays: () => {
            throw new Error("displays: not implemented");
          },
          spawnSync: spawnFake({ "bun --version": { stdout: "1.4.4\n" } }).fn,
        },
        { "/proc/cpuinfo": undefined as unknown as string },
      ),
    );
    expect(specs.errors).toEqual([
      "cpu: /proc/cpuinfo unreadable",
      "windows_host: PowerShell failed to start: ENOENT",
      "displays: displays: not implemented",
    ]);
    expect(specs.cpu).toEqual({ model: "unknown", logical_cores: 4, arch: "x86_64" });
    expect(specs.windows_host).toEqual({
      wsl: { distro: "Ubuntu-22.04", kernel: "6.18.33.2-microsoft-standard-WSL2" },
    });
    expect(specs.displays).toBeUndefined();
    expect(specs.memory.total_bytes).toBe(24608404 * 1024);
  });

  test("native Windows uses the one PowerShell call", () => {
    const spawn = spawnFake({ "powershell.exe -NoProfile": { stdout: WINDOWS_JSON } });
    const specs = probeMachineSpecs(
      wslDeps({ platform: "win32", isWsl: () => false, spawnSync: spawn.fn, uptime: () => 3600 }),
    );
    expect(specs.host_kind).toBe("windows");
    expect(specs.os.build).toBe("26300.9974");
    expect(specs.disks[0]?.mount).toBe("C:\\");
    expect(specs.windows_host).toBeUndefined();
    expect(specs.boot_id).toBe("2026-11-14T11:00:00.000Z");
    expect(spawn.calls.filter((c) => c.startsWith("powershell"))).toHaveLength(1);
  });

  test("macOS with fakes", () => {
    const spawn = spawnFake({
      sw_vers: { stdout: SW_VERS },
      "sysctl -n": { stdout: MAC_SYSCTL },
      "system_profiler SPDisplaysDataType": { stdout: MAC_PROFILE },
      "df -kP": { stdout: MAC_DF },
    });
    const specs = probeMachineSpecs(
      wslDeps({
        platform: "darwin",
        arch: "arm64",
        isWsl: () => false,
        spawnSync: spawn.fn,
        statfs: () => undefined,
      }),
    );
    expect(specs.host_kind).toBe("macos");
    expect(specs.cpu.model).toBe("Apple M2 Pro");
    expect(specs.memory.total_bytes).toBe(34359738368);
    expect(specs.disks).toHaveLength(2);
  });
});

describe("refresh on read", () => {
  test("missing, then current, then each stale reason", () => {
    const deps = wslDeps();
    const first = readMachineSpecs(deps);
    expect(first).toMatchObject({ refreshed: true, reason: "missing" });
    expect(existsSync(join(dir, MACHINE_SPECS_FILE))).toBe(true);

    expect(readMachineSpecs(deps)).toMatchObject({ refreshed: false });
    expect(readMachineSpecs(deps).reason).toBeUndefined();
    expect(readMachineSpecs({ ...deps, refresh: true })).toMatchObject({
      refreshed: true,
      reason: "forced",
    });

    expect(readMachineSpecs({ ...deps, harneryVersion: () => "9.9.9" }).reason).toBe("version");
    const rebooted = wslDeps(
      { harneryVersion: () => "9.9.9" },
      { "/proc/sys/kernel/random/boot_id": "new-boot\n" },
    );
    expect(readMachineSpecs(rebooted).reason).toBe("boot");

    const later = wslDeps(
      { harneryVersion: () => "9.9.9", now: () => Date.parse("2026-11-15T12:00:01Z") },
      {
        "/proc/sys/kernel/random/boot_id": "new-boot\n",
      },
    );
    expect(readMachineSpecs(later).reason).toBe("age");
    expect(readMachineSpecs({ ...later, maxAgeMs: 10 }).refreshed).toBe(false);

    const path = join(dir, MACHINE_SPECS_FILE);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...stored, schema_version: 0 }));
    expect(readMachineSpecs(later).reason).toBe("schema");
    writeFileSync(path, "{not json");
    expect(readMachineSpecs(later).reason).toBe("schema");
  });

  test("an unknown boot id skips the boot test", () => {
    const deps = wslDeps({}, { "/proc/sys/kernel/random/boot_id": "" });
    readMachineSpecs(deps);
    const other = wslDeps({}, { "/proc/sys/kernel/random/boot_id": "" });
    expect(readMachineSpecs(other).refreshed).toBe(false);
  });

  test("the live block is measured now and never stored", () => {
    const result = readMachineSpecs(wslDeps());
    expect(result.live).toEqual({
      measured_at: "2026-11-14T12:00:00.000Z",
      memory_available_bytes: 13398276 * 1024,
      disks: [
        { mount: "/", free_bytes: 277788839936 },
        { mount: "/mnt/c", free_bytes: 676592054272 },
      ],
    });
    expect(readFileSync(join(dir, MACHINE_SPECS_FILE), "utf8")).not.toContain("free_bytes");
    const mac = measureLive(
      result.specs,
      wslDeps({ platform: "darwin", freeMemory: () => 42, statfs: () => undefined }),
    );
    expect(mac).toEqual({
      measured_at: "2026-11-14T12:00:00.000Z",
      memory_available_bytes: 42,
      disks: [],
    });
  });
});
