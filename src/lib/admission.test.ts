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

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
