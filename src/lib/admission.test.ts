import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdmissionConfig,
  AdmissionTimeoutError,
  acquireAdmission,
  admissionBaseDir,
  admissionStatus,
  listAdmissionResources,
  pidAlive,
} from "./admission.ts";
import {
  readAdmissionHistory,
  resolveAdmissionHistoryDir,
  summarizeAdmissionHistory,
} from "./admission-history.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-history`, { recursive: true, force: true });
  }
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-admission-"));
  roots.push(root);
  return root;
}

function config(dir: string, capacity = 1, extra: Partial<AdmissionConfig> = {}): AdmissionConfig {
  return { dir, resource: "res", capacity, pollMs: 25, ...extra };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Hand-write a queue entry file the way acquireAdmission lays them out. */
function seedEntry(
  dir: string,
  bucket: "held" | "tickets",
  opts: { pid: number; label: string; createdAt: string; stampMs?: number; raw?: string },
): string {
  const target = join(dir, "res", bucket);
  mkdirSync(join(dir, "res", "held"), { recursive: true });
  mkdirSync(join(dir, "res", "tickets"), { recursive: true });
  const stamp = String(opts.stampMs ?? Date.now()).padStart(13, "0");
  const name = `${stamp}-${opts.pid}-abcd1234.json`;
  const body =
    opts.raw ?? JSON.stringify({ pid: opts.pid, label: opts.label, created_at: opts.createdAt });
  writeFileSync(join(target, name), body);
  return join(target, name);
}

describe("acquireAdmission", () => {
  test("capacity 1: first admits immediately, second waits for release", async () => {
    const dir = fixture();
    const first = await acquireAdmission(config(dir), { label: "first" });
    let secondAdmitted = false;
    const second = acquireAdmission(config(dir), { label: "second" }).then((handle) => {
      secondAdmitted = true;
      return handle;
    });
    await sleep(120);
    expect(secondAdmitted).toBe(false);
    first.release();
    const secondHandle = await second;
    expect(secondAdmitted).toBe(true);
    secondHandle.release();
  });

  test("FIFO: earlier waiter admits before a later one", async () => {
    const dir = fixture();
    const holder = await acquireAdmission(config(dir), { label: "holder" });
    const order: string[] = [];
    const waiterA = acquireAdmission(config(dir), { label: "A" }).then((handle) => {
      order.push("A");
      return handle;
    });
    await sleep(15); // distinct enqueue timestamps
    const waiterB = acquireAdmission(config(dir), { label: "B" }).then((handle) => {
      order.push("B");
      return handle;
    });
    await sleep(80); // both queued
    holder.release();
    const handleA = await waiterA;
    expect(order).toEqual(["A"]);
    handleA.release();
    const handleB = await waiterB;
    expect(order).toEqual(["A", "B"]);
    handleB.release();
  });

  test("capacity 2 admits two concurrently; the third waits", async () => {
    const dir = fixture();
    const first = await acquireAdmission(config(dir, 2), { label: "one" });
    const second = await acquireAdmission(config(dir, 2), { label: "two" });
    let thirdAdmitted = false;
    const third = acquireAdmission(config(dir, 2), { label: "three" }).then((handle) => {
      thirdAdmitted = true;
      return handle;
    });
    await sleep(120);
    expect(thirdAdmitted).toBe(false);
    first.release();
    const thirdHandle = await third;
    expect(thirdAdmitted).toBe(true);
    thirdHandle.release();
    second.release();
  });

  test("timeout rejects with AdmissionTimeoutError naming the holder and cleans its ticket", async () => {
    const dir = fixture();
    const holder = await acquireAdmission(config(dir), { label: "the-holder" });
    let caught: unknown;
    try {
      await acquireAdmission(config(dir), { label: "waiter", timeoutMs: 100 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdmissionTimeoutError);
    const timeout = caught as AdmissionTimeoutError;
    expect(timeout.message).toContain("the-holder");
    expect(timeout.holders.map((entry) => entry.label)).toContain("the-holder");
    const tickets = readdirSync(join(dir, "res", "tickets")).filter((name) =>
      name.endsWith(".json"),
    );
    expect(tickets).toHaveLength(0);
    holder.release();
  });

  test("dead-PID holder is pruned so a new acquire admits immediately", async () => {
    const dir = fixture();
    const spawned = spawnSync("/bin/true");
    const deadPid = spawned.pid;
    expect(deadPid).toBeGreaterThan(1);
    expect(pidAlive(deadPid)).toBe(false);
    const path = seedEntry(dir, "held", {
      pid: deadPid,
      label: "dead holder",
      createdAt: new Date().toISOString(),
    });
    const handle = await acquireAdmission(config(dir), { label: "live", timeoutMs: 2000 });
    expect(existsSync(path)).toBe(false);
    handle.release();
  });

  test("TTL-expired holder with a live pid is pruned", async () => {
    const dir = fixture();
    const path = seedEntry(dir, "held", {
      pid: process.pid,
      label: "expired",
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      stampMs: Date.now() - 10_000,
    });
    const handle = await acquireAdmission(config(dir, 1, { ttlMs: 1000 }), {
      label: "fresh",
      timeoutMs: 2000,
    });
    expect(existsSync(path)).toBe(false);
    handle.release();
  });

  test("acquire reports waitedMs >= 0 and entry names an existing held file", async () => {
    const dir = fixture();
    const handle = await acquireAdmission(config(dir), { label: "probe" });
    expect(handle.waitedMs).toBeGreaterThanOrEqual(0);
    expect(existsSync(join(dir, "res", "held", handle.entry))).toBe(true);
    handle.release();
  });

  test("release is idempotent", async () => {
    const dir = fixture();
    const handle = await acquireAdmission(config(dir), { label: "twice" });
    handle.release();
    expect(() => handle.release()).not.toThrow();
  });
});

describe("admission history", () => {
  test("a released slot records wait, hold, exit code, and who it waited behind", async () => {
    const dir = fixture();
    const first = await acquireAdmission(config(dir), { label: "first" });
    const second = acquireAdmission(config(dir), { label: "second" });
    await sleep(120);
    first.release({ exitCode: 0 });
    const handle = await second;
    handle.release({ exitCode: 2, signal: null });
    const records = readAdmissionHistory(`${dir}-history`, { resource: "res" });
    expect(records.map((record) => record.label)).toEqual(["first", "second"]);
    const waited = records[1];
    expect(waited?.outcome).toBe("released");
    expect(waited?.exit_code).toBe(2);
    expect(waited?.waited_behind).toEqual(["first"]);
    expect(waited?.wait_ms ?? 0).toBeGreaterThanOrEqual(100);
    expect(typeof waited?.hold_ms).toBe("number");
    expect(waited?.cwd).toBe(process.cwd());
  });

  test("a second release call records nothing more", async () => {
    const dir = fixture();
    const handle = await acquireAdmission(config(dir), { label: "once" });
    handle.release();
    handle.release();
    expect(readAdmissionHistory(`${dir}-history`)).toHaveLength(1);
  });

  test("a timeout records the wait and the holder", async () => {
    const dir = fixture();
    const holder = await acquireAdmission(config(dir), { label: "holder" });
    await expect(
      acquireAdmission(config(dir), { label: "late", timeoutMs: 80 }),
    ).rejects.toBeInstanceOf(AdmissionTimeoutError);
    holder.release();
    const late = readAdmissionHistory(`${dir}-history`, { labelContains: "LATE" });
    expect(late).toHaveLength(1);
    expect(late[0]?.outcome).toBe("timeout");
    expect(late[0]?.waited_behind).toEqual(["holder"]);
  });

  test("a dead holder pruned by a peer is recorded once as abandoned", async () => {
    const dir = fixture();
    const pid = spawnSync("/bin/true").pid as number;
    const created = new Date(Date.now() - 5_000).toISOString();
    const acquired = new Date(Date.now() - 4_000).toISOString();
    seedEntry(dir, "held", {
      pid,
      label: "killed",
      createdAt: created,
      raw: JSON.stringify({ pid, label: "killed", created_at: created, acquired_at: acquired }),
    });
    admissionStatus({ dir, resource: "res" });
    admissionStatus({ dir, resource: "res" });
    const records = readAdmissionHistory(`${dir}-history`);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "abandoned", label: "killed" });
    expect(records[0]?.wait_ms).toBe(1_000);
    expect(records[0]?.hold_ms ?? 0).toBeGreaterThanOrEqual(4_000);
  });

  test("historyDir null records nothing", async () => {
    const dir = fixture();
    const handle = await acquireAdmission(config(dir, 1, { historyDir: null }), { label: "quiet" });
    handle.release();
    expect(existsSync(`${dir}-history`)).toBe(false);
  });

  test("summary groups by resource and label, most total wait first", () => {
    const base = {
      v: 1 as const,
      resource: "build",
      pid: 1,
      enqueued_at: "2026-01-01T00:00:00.000Z",
      ended_at: "2026-01-01T00:01:00.000Z",
    };
    const groups = summarizeAdmissionHistory([
      { ...base, label: "fast", outcome: "released", wait_ms: 0, hold_ms: 1_000 },
      { ...base, label: "slow", outcome: "released", wait_ms: 90_000, hold_ms: 5_000 },
      { ...base, label: "slow", outcome: "timeout", wait_ms: 120_000 },
    ]);
    expect(groups.map((group) => group.label)).toEqual(["slow", "fast"]);
    expect(groups[0]).toMatchObject({ count: 2, queued: 2, outcomes: { released: 1, timeout: 1 } });
    expect(groups[0]?.hold_ms).toEqual({ p50: 5_000, p90: 5_000, max: 5_000 });
  });

  test("history location: shared queue roots are persistent, others record beside themselves", () => {
    const saved = {
      toggle: process.env.HARNERY_ADMISSION_HISTORY,
      dir: process.env.HARNERY_ADMISSION_HISTORY_DIR,
      state: process.env.XDG_STATE_HOME,
    };
    try {
      delete process.env.HARNERY_ADMISSION_HISTORY;
      delete process.env.HARNERY_ADMISSION_HISTORY_DIR;
      process.env.XDG_STATE_HOME = "/state";
      for (const shared of ["/tmp/harnery-admission", "/tmp/user-1000/harnery-admission"]) {
        expect(resolveAdmissionHistoryDir(shared)).toBe("/state/harnery/admission-history");
      }
      expect(resolveAdmissionHistoryDir("/tmp/harnery-admission-x1")).toBe(
        "/tmp/harnery-admission-x1-history",
      );
      process.env.HARNERY_ADMISSION_HISTORY_DIR = "/elsewhere";
      expect(resolveAdmissionHistoryDir("/tmp/harnery-admission")).toBe("/elsewhere");
      process.env.HARNERY_ADMISSION_HISTORY = "off";
      expect(resolveAdmissionHistoryDir("/tmp/harnery-admission")).toBeNull();
    } finally {
      for (const [key, name] of [
        ["toggle", "HARNERY_ADMISSION_HISTORY"],
        ["dir", "HARNERY_ADMISSION_HISTORY_DIR"],
        ["state", "XDG_STATE_HOME"],
      ] as const) {
        if (saved[key] === undefined) delete process.env[name];
        else process.env[name] = saved[key];
      }
    }
  });
});

describe("admissionStatus", () => {
  test("prunes old torn files on listing but leaves recent ones alone", () => {
    const dir = fixture();
    const oldTorn = seedEntry(dir, "held", {
      pid: 123,
      label: "",
      createdAt: "",
      stampMs: Date.now() - 120_000,
      raw: "{not json",
    });
    const recentTorn = seedEntry(dir, "held", {
      pid: 456,
      label: "",
      createdAt: "",
      raw: "{also not json",
    });
    const status = admissionStatus({ dir, resource: "res" });
    expect(status.holders).toHaveLength(0);
    expect(existsSync(oldTorn)).toBe(false);
    expect(existsSync(recentTorn)).toBe(true);
  });

  test("lists holders and waiters with labels", async () => {
    const dir = fixture();
    const holder = await acquireAdmission(config(dir), { label: "the-holder" });
    const waiter = acquireAdmission(config(dir), { label: "the-waiter" }); // ticket written synchronously
    const status = admissionStatus({ dir, resource: "res" });
    expect(status.resource).toBe("res");
    expect(status.holders.map((entry) => entry.label)).toEqual(["the-holder"]);
    expect(status.waiters.map((entry) => entry.label)).toEqual(["the-waiter"]);
    expect(listAdmissionResources(dir)).toEqual(["res"]);
    holder.release();
    (await waiter).release();
  });
});

describe("admissionBaseDir", () => {
  test("defaults to tmpdir/harnery-admission", () => {
    const prev = process.env.HARNERY_ADMISSION_DIR;
    delete process.env.HARNERY_ADMISSION_DIR;
    try {
      expect(admissionBaseDir()).toBe(join(tmpdir(), "harnery-admission"));
    } finally {
      if (prev === undefined) delete process.env.HARNERY_ADMISSION_DIR;
      else process.env.HARNERY_ADMISSION_DIR = prev;
    }
  });

  test("honors HARNERY_ADMISSION_DIR", () => {
    const prev = process.env.HARNERY_ADMISSION_DIR;
    process.env.HARNERY_ADMISSION_DIR = "/tmp/custom-admission-dir";
    try {
      expect(admissionBaseDir()).toBe("/tmp/custom-admission-dir");
    } finally {
      if (prev === undefined) delete process.env.HARNERY_ADMISSION_DIR;
      else process.env.HARNERY_ADMISSION_DIR = prev;
    }
  });
});
