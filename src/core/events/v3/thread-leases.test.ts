import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { threadId, Worker } from "node:worker_threads";
import { eventV3Fixture, fixtureObject } from "../../../../tests/helpers/event-v3.ts";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import type { EventV3 } from "./contract.ts";
import { releaseEventV3LeasesHeldByExitedThreadV3 } from "./thread-leases.ts";
import { acquireEventV3AppendLeaseV3, eventV3Paths, writeEventV3 } from "./writer.ts";

const roots: string[] = [];
const workers: Worker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.terminate();
  for (const root of roots.splice(0)) removeDir(root);
});

describe("event ledger leases left held inside a living process", () => {
  test("an append lease this thread dropped without release is reclaimed after expiry", async () => {
    const root = temporaryRoot();
    const start = Date.now();
    dropAppendLease(root, start);
    await collectDroppedHandles();

    const result = writeEventV3(root, event(1) as unknown as EventV3, {
      now: () => start + 10_000,
    });
    expect(result.state).toBe("committed");
    expect(existsSync(currentAppendOwner(root))).toBe(false);
  });

  test("an append lease this thread still holds keeps refusing after expiry", () => {
    const root = temporaryRoot();
    const start = Date.now();
    const held = acquireEventV3AppendLeaseV3(root, { now: () => start });

    const result = writeEventV3(root, event(1) as unknown as EventV3, {
      now: () => start + 60_000,
    });
    expect(result).toMatchObject({ state: "ready", diagnostic_code: "wal_drain_failed" });
    expect(readOwner(root).owner_id).toBe(held.owner.owner_id);
    held.release();
    expect(writeEventV3(root, event(2) as unknown as EventV3).state).toBe("committed");
  });

  test("the parent releases the append lease of a worker terminated while holding it", async () => {
    const root = temporaryRoot();
    const holder = await startHolder(root, false);
    const holderThread = holder.worker.threadId;
    expect(readOwner(root).thread_id).toBe(holderThread);
    await holder.worker.terminate();

    // Without the release, every later append in this process fails.
    const blocked = writeEventV3(root, event(1) as unknown as EventV3, {
      now: () => Date.now() + 60_000,
    });
    expect(blocked).toMatchObject({ state: "ready", diagnostic_code: "wal_drain_failed" });

    expect(releaseEventV3LeasesHeldByExitedThreadV3(root, holderThread)).toEqual({
      released: ["event-v3-append"],
      failed: [],
    });
    expect(writeEventV3(root, event(2) as unknown as EventV3).state).toBe("committed");
    expect(activeEventIds(root)).toHaveLength(2);
    expect(releaseEventV3LeasesHeldByExitedThreadV3(root, holderThread)).toEqual({
      released: [],
      failed: [],
    });
  });

  test("the parent releases every ledger lease a terminated worker held", async () => {
    const root = temporaryRoot();
    const holder = await startHolder(root, true);
    const holderThread = holder.worker.threadId;
    await holder.worker.terminate();

    // A stuck publication lease makes every later write in this process throw.
    expect(() => writeEventV3(root, event(1) as unknown as EventV3)).toThrow(
      /event-v3-publication is held by a live or unexpired owner/,
    );

    expect(releaseEventV3LeasesHeldByExitedThreadV3(root, holderThread)).toEqual({
      released: ["event-v3-append", "event-v3-publication"],
      failed: [],
    });
    expect(writeEventV3(root, event(2) as unknown as EventV3).state).toBe("committed");
  });

  test("a lease held by another live thread is never reclaimed", async () => {
    const root = temporaryRoot();
    const holder = await startHolder(root, false);
    const owner = readOwner(root);
    expect(owner.thread_id).toBe(holder.worker.threadId);

    const contended = writeEventV3(root, event(1) as unknown as EventV3, {
      now: () => Date.now() + 60_000,
    });
    expect(contended).toMatchObject({ state: "ready", diagnostic_code: "wal_drain_failed" });
    expect(releaseEventV3LeasesHeldByExitedThreadV3(root, holder.worker.threadId + 1_000)).toEqual({
      released: [],
      failed: [],
    });
    expect(readOwner(root).owner_id).toBe(owner.owner_id);

    const exited = new Promise((resolve) => holder.worker.once("exit", resolve));
    Atomics.store(holder.cell, 0, 1);
    Atomics.notify(holder.cell, 0);
    await holder.released;
    await exited;
    expect(existsSync(currentAppendOwner(root))).toBe(false);
  });

  test("F5: a lease folder that exists but cannot be read is reported as failed, not clean", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = temporaryRoot();
    const ledger = dirname(eventV3Paths(root).active);
    const adapterDir = join(ledger, "private-producers", "openclaw");
    mkdirSync(adapterDir, { recursive: true });
    chmodSync(adapterDir, 0o000);
    try {
      const result = releaseEventV3LeasesHeldByExitedThreadV3(root, threadId + 1000);
      expect(result.failed).toContain("event-v3-lease-scan");
    } finally {
      chmodSync(adapterDir, 0o700);
    }
    const clean = releaseEventV3LeasesHeldByExitedThreadV3(root, threadId + 1000);
    expect(clean.failed).toEqual([]);
  });

  test("F6: an exited worker's lease that cannot be checked is reported as failed, then released once readable", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = temporaryRoot();
    const holder = await startHolder(root, false);
    const holderThread = holder.worker.threadId;
    await holder.worker.terminate();
    const privateDir = join(root, ".harnery", "private");
    chmodSync(privateDir, 0o000);
    let hidden: ReturnType<typeof releaseEventV3LeasesHeldByExitedThreadV3>;
    try {
      hidden = releaseEventV3LeasesHeldByExitedThreadV3(root, holderThread);
    } finally {
      chmodSync(privateDir, 0o700);
    }
    expect(hidden.failed).toContain("event-v3-append");
    expect(readOwner(root).thread_id).toBe(holderThread);

    const retried = releaseEventV3LeasesHeldByExitedThreadV3(root, holderThread);
    expect(retried.failed).toEqual([]);
    expect(retried.released).toContain("event-v3-append");
    expect(writeEventV3(root, event(1) as unknown as EventV3).state).toBe("committed");
  });

  test("F5: a lease folder that does not exist counts as nothing to release", () => {
    const root = temporaryRoot();
    const result = releaseEventV3LeasesHeldByExitedThreadV3(root, threadId + 1000);
    expect(result).toEqual({ released: [], failed: [] });
  });

  test("the current thread cannot release its own leases as exited", () => {
    const root = temporaryRoot();
    expect(() => releaseEventV3LeasesHeldByExitedThreadV3(root, threadId)).toThrow(
      /current thread/,
    );
  });
});

describe("an interrupted exited-thread release in a supervising thread", () => {
  // The supervisor is this test's main thread; the recorder is a real worker.
  const FAULTS = [
    "claim_created",
    "stale_pinned",
    "current_removed",
    "new_current_linked",
    "recovery_retired",
    "release",
  ] as const;
  /**
   * What a release that fails at each point leaves. The release never links a
   * replacement owner, so it never passes `new_current_linked` or `release`.
   */
  const RESIDUE: Record<
    (typeof FAULTS)[number],
    { failed: boolean; current: boolean; recovery: boolean }
  > = {
    claim_created: { failed: true, current: true, recovery: true },
    stale_pinned: { failed: true, current: true, recovery: true },
    current_removed: { failed: true, current: false, recovery: true },
    new_current_linked: { failed: false, current: false, recovery: false },
    recovery_retired: { failed: true, current: false, recovery: false },
    release: { failed: false, current: false, recovery: false },
  };

  for (const fault of FAULTS) {
    test(`F4: after a release fails at ${fault}, the supervisor's retry frees the lease for later threads and processes`, async () => {
      const root = temporaryRoot();
      const holder = await startHolder(root, false);
      const exited = holder.worker.threadId;
      await holder.worker.terminate();

      const failing = releaseEventV3LeasesHeldByExitedThreadV3(root, exited, faultAt(fault));
      const expected = RESIDUE[fault];
      expect(failing.failed).toEqual(expected.failed ? ["event-v3-append"] : []);
      expect(existsSync(currentAppendOwner(root))).toBe(expected.current);
      // The supervisor never publishes itself as the lease owner.
      if (expected.current) expect(readOwner(root).thread_id).toBe(exited);
      expect(existsSync(join(eventV3Paths(root).lease, "recovery"))).toBe(expected.recovery);
      if (expected.current || expected.recovery) {
        expect(await writeFromWorker(root, 1)).toMatchObject({
          state: "ready",
          diagnostic_code: "wal_drain_failed",
        });
        expect(await takeAppendLeaseInProcess(root)).toBe(3);
      }

      // (a) The supervisor's retry clears everything the failed attempt left.
      expect(releaseEventV3LeasesHeldByExitedThreadV3(root, exited).failed).toEqual([]);
      expect(readdirSync(eventV3Paths(root).lease)).toEqual([]);
      // (b) A new recorder thread writes.
      expect(await writeFromWorker(root, 2)).toMatchObject({ state: "committed" });
      // (c) Another process takes the lease.
      expect(await takeAppendLeaseInProcess(root)).toBe(0);
    });
  }

  test("F4: the retried release never displaces a live holder in another thread", async () => {
    const root = temporaryRoot();
    const first = await startHolder(root, false);
    const exited = first.worker.threadId;
    await first.worker.terminate();
    const failing = releaseEventV3LeasesHeldByExitedThreadV3(
      root,
      exited,
      faultAt("recovery_retired"),
    );
    expect(failing.failed).toEqual(["event-v3-append"]);

    const live = await startHolder(root, false);
    const owner = readOwner(root);
    expect(owner.thread_id).toBe(live.worker.threadId);
    expect(releaseEventV3LeasesHeldByExitedThreadV3(root, exited).failed).toEqual([]);
    expect(releaseEventV3LeasesHeldByExitedThreadV3(root, exited).failed).toEqual([]);
    expect(readOwner(root).owner_id).toBe(owner.owner_id);
    expect(await takeAppendLeaseInProcess(root)).toBe(3);

    const liveExited = new Promise((done) => live.worker.once("exit", done));
    Atomics.store(live.cell, 0, 1);
    Atomics.notify(live.cell, 0);
    await live.released;
    await liveExited;
    expect(existsSync(currentAppendOwner(root))).toBe(false);
  });

  test("F4: the release leaves a lease the supervising thread itself holds", () => {
    const root = temporaryRoot();
    const held = acquireEventV3AppendLeaseV3(root);
    expect(releaseEventV3LeasesHeldByExitedThreadV3(root, threadId + 1_000)).toEqual({
      released: [],
      failed: [],
    });
    expect(readOwner(root).owner_id).toBe(held.owner.owner_id);
    held.release();
  });
});

function faultAt(fault: string) {
  const stop = (scope: string, step: string): void => {
    if (scope === "event-v3-append" && step === fault) throw new Error("cleanup stopped");
  };
  return {
    onRecoveryStep: stop,
    onRelease: (scope: string) => stop(scope, "release"),
  };
}

async function writeFromWorker(
  root: string,
  sequence: number,
): Promise<{ state: string; diagnostic_code?: string; error?: string }> {
  const worker = new Worker(new URL("./__fixtures__/ledger-writer-worker.ts", import.meta.url), {
    workerData: { root, sequence },
  });
  workers.push(worker);
  return new Promise((done, reject) => {
    worker.once("message", done);
    worker.once("error", reject);
  });
}

async function takeAppendLeaseInProcess(root: string): Promise<number> {
  const fixture = resolve(import.meta.dir, "__fixtures__", "append-lease-process.ts");
  const child = Bun.spawn({ cmd: [process.execPath, fixture, root], stderr: "pipe" });
  return child.exited;
}

function dropAppendLease(root: string, start: number): void {
  acquireEventV3AppendLeaseV3(root, { now: () => start });
}

async function collectDroppedHandles(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  Bun.gc(true);
}

async function startHolder(root: string, nested: boolean) {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL("./__fixtures__/lease-holder-worker.ts", import.meta.url), {
    workerData: { root, nested, cell: cell.buffer },
  });
  workers.push(worker);
  let resolveReleased: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    resolveReleased = resolve;
  });
  await new Promise<void>((resolve, reject) => {
    worker.on("message", (message) => {
      if (message === "holding") resolve();
      if (message === "released") resolveReleased();
    });
    worker.once("error", reject);
  });
  return { worker, cell, released };
}

function currentAppendOwner(root: string): string {
  return join(eventV3Paths(root).lease, "current");
}

function readOwner(root: string): { owner_id: string; thread_id?: number } {
  return JSON.parse(readFileSync(currentAppendOwner(root), "utf8"));
}

function activeEventIds(root: string): string[] {
  return readFileSync(eventV3Paths(root).active, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((row) => (JSON.parse(row) as { event_id: string }).event_id);
}

function event(sequence: number) {
  const fixture = eventV3Fixture("tool.requested", sequence);
  const producer = fixtureObject(fixture.producer);
  producer.producer_id = "prd_thread_lease";
  producer.boot_id = "boot_prd_thread_lease";
  producer.sequence = sequence;
  return fixture;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-thread-leases-"));
  roots.push(root);
  return root;
}
