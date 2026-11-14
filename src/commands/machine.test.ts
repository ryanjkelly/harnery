import { expect, test } from "bun:test";
import { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import type { MachineSpecs, MachineSpecsRead } from "../lib/machine-specs.ts";
import { formatBytes, registerMachineCommand } from "./machine.ts";

const SPECS: MachineSpecs = {
  schema_version: 1,
  probed_at: "2026-11-14T10:00:00.000Z",
  boot_id: "boot",
  harnery_version: "1.2.3",
  machine_label: "desk",
  host_kind: "wsl",
  os: {
    platform: "linux",
    name: "Ubuntu",
    version: "22.04.5 LTS",
    kernel: "6.18-wsl",
    arch: "x86_64",
  },
  cpu: { model: "Example CPU", physical_cores: 8, logical_cores: 16, arch: "x86_64" },
  memory: { total_bytes: 24 * 1024 ** 3 },
  gpus: [{ name: "Example GPU", vendor: "NVIDIA", vram_bytes: 24 * 1024 ** 3 }],
  disks: [
    {
      mount: "/",
      device: "/dev/sdd",
      filesystem: "ext4",
      total_bytes: 800 * 1024 ** 3,
      kind: "unknown",
    },
  ],
  displays: [
    {
      id: "DISPLAY1",
      primary: true,
      bounds: { x: 0, y: 0, width: 5120, height: 2160 },
      scale: 1.5,
    },
  ],
  runtimes: { bun: "1.4.4", node: "24.22.1" },
  windows_host: {
    os: {
      platform: "win32",
      name: "Windows 11 Pro",
      version: "26H2",
      build: "26300.9974",
      arch: "x86_64",
    },
    cpu: { model: "Example CPU", physical_cores: 24, logical_cores: 32, arch: "x86_64" },
    memory: { total_bytes: 64 * 1024 ** 3 },
    gpus: [{ name: "Example GPU", vram_bytes: 24 * 1024 ** 3 }],
    wsl: { distro: "Ubuntu-22.04", kernel: "6.18-wsl" },
  },
};

function fakeRead(result: Partial<MachineSpecsRead> = {}) {
  const calls: { maxAgeMs?: number; refresh?: boolean }[] = [];
  const read = (options: { maxAgeMs?: number; refresh?: boolean }) => {
    calls.push({ maxAgeMs: options.maxAgeMs, refresh: options.refresh });
    return {
      specs: SPECS,
      live: {
        measured_at: "2026-11-14T10:30:00.000Z",
        memory_available_bytes: 12 * 1024 ** 3,
        disks: [{ mount: "/", free_bytes: 250 * 1024 ** 3 }],
      },
      refreshed: false,
      ...result,
    };
  };
  return { read, calls };
}

async function run(args: string[], read = fakeRead()) {
  const data: unknown[] = [];
  const text: string[] = [];
  const errors: unknown[] = [];
  let exitCode = 0;
  const emit: EmitContext = {
    config() {},
    data: (v) => {
      data.push(v);
    },
    text: (v) => {
      text.push(v);
    },
    rows() {},
    file() {},
    error(e) {
      errors.push(e);
    },
    log() {},
    setExitCode(n) {
      exitCode = n;
    },
  };
  const program = new Command().name("tool");
  registerMachineCommand(program, emit, undefined, { read: read.read });
  await program.parseAsync(args, { from: "user" });
  return { data, text: text.join("\n"), errors, exitCode, calls: read.calls };
}

test("specs prints a plain summary with the live numbers and a Windows host block", async () => {
  const out = await run(["machine", "specs"]);
  expect(out.text).toContain("Machine: desk (WSL guest)");
  expect(out.text).toContain("CPU: Example CPU, 8 cores, 16 threads available to the guest");
  expect(out.text).toContain("Memory: 24.0 GiB total, 12.0 GiB available now");
  expect(out.text).toContain("  /: 250.0 GiB free of 800.0 GiB (ext4)");
  expect(out.text).toContain("  DISPLAY1: 5120x2160 at 150%, primary");
  expect(out.text).toContain("Windows host:\n  OS: Windows 11 Pro 26H2 (build 26300.9974), x86_64");
  expect(out.text).toContain("  WSL: Ubuntu-22.04, kernel 6.18-wsl");
  expect(out.text).toContain("Probed 30 minutes ago");
  expect(out.text).toContain("Run tool machine specs --refresh");
  expect(out.calls).toEqual([{ maxAgeMs: undefined, refresh: false }]);
});

test("machine with no subcommand prints the same summary", async () => {
  expect((await run(["machine"])).text).toBe((await run(["machine", "specs"])).text);
});

test("--json emits specs, live, refreshed and reason", async () => {
  const out = await run(
    ["machine", "specs", "--json", "--refresh", "--max-age", "5"],
    fakeRead({ refreshed: true, reason: "forced" }),
  );
  expect(out.text).toBe("");
  expect(out.data[0]).toMatchObject({
    specs: { machine_label: "desk" },
    refreshed: true,
    reason: "forced",
  });
  expect((out.data[0] as { live: { disks: unknown[] } }).live.disks).toHaveLength(1);
  expect(out.calls).toEqual([{ maxAgeMs: 300_000, refresh: true }]);
});

test("a refreshed read says why, and errors are listed", async () => {
  const out = await run(
    ["machine", "specs"],
    fakeRead({
      refreshed: true,
      reason: "boot",
      specs: { ...SPECS, errors: ["gpus: lspci exited 1"] },
    }),
  );
  expect(out.text).toContain("Not read: gpus: lspci exited 1");
  expect(out.text).toContain("Probed just now (the machine restarted).");
});

test("an invalid --max-age is refused", async () => {
  const out = await run(["machine", "specs", "--max-age", "soon"]);
  expect(out.exitCode).toBe(2);
  expect(out.calls).toHaveLength(0);
});

test("formatBytes", () => {
  expect(formatBytes(512 * 1024 ** 2)).toBe("512 MiB");
  expect(formatBytes(2 * 1024 ** 4)).toBe("2.0 TiB");
  expect(formatBytes(undefined)).toBe("unknown");
});
