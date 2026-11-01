import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopLease, DEFAULT_LEASE_IDLE_MS, desktopLease, leaseDir } from "./lease.ts";
import type { LeaseOwner } from "./types.ts";

const A: LeaseOwner = { id: "agent-a", label: "agent-A", project: "/p/a" };
const B: LeaseOwner = { id: "agent-b", label: "agent-B" };

function freshDir(): string {
  return leaseDir(mkdtempSync(join(tmpdir(), "desktop-lease-")));
}

function clock(start = Date.parse("2026-11-01T12:00:00Z")) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("desktop lease", () => {
  test("leaseDir joins computer", () => {
    expect(leaseDir("/x/harnery")).toBe(join("/x/harnery", "computer"));
  });

  test("fresh acquire takes generation 1 and creates the dir", async () => {
    const dir = freshDir();
    const c = clock();
    const r = await desktopLease.acquire(A, { dir, now: c.now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fresh).toBe(true);
    expect(r.lease.generation).toBe(1);
    expect(r.lease.owner_id).toBe("agent-a");
    expect(r.lease.owner_label).toBe("agent-A");
    expect(r.lease.project).toBe("/p/a");
    expect(Date.parse(r.lease.expires_at) - c.now()).toBe(DEFAULT_LEASE_IDLE_MS);
    expect(desktopLease.read({ dir, now: c.now })?.owner_id).toBe("agent-a");
    expect(existsSync(join(dir, "lease.lock"))).toBe(false);
  });

  test("same-owner refresh keeps generation and extends expiry", async () => {
    const dir = freshDir();
    const c = clock();
    const first = await desktopLease.acquire(A, { dir, now: c.now, idleMs: 1000 });
    c.advance(600);
    const second = await desktopLease.acquire(A, { dir, now: c.now, idleMs: 1000 });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.fresh).toBe(false);
    expect(second.lease.generation).toBe(1);
    expect(second.lease.acquired_at).toBe(first.lease.acquired_at);
    expect(Date.parse(second.lease.expires_at)).toBe(c.now() + 1000);
    expect(Date.parse(second.lease.refreshed_at)).toBe(c.now());
  });

  test("another owner is refused with the holder when waitMs is 0", async () => {
    const dir = freshDir();
    const c = clock();
    await desktopLease.acquire(A, { dir, now: c.now });
    const r = await desktopLease.acquire(B, { dir, now: c.now });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.holder.owner_id).toBe("agent-a");
    expect(r.waitedMs).toBe(0);
  });

  test("another owner waits, then succeeds after the holder releases", async () => {
    const dir = freshDir();
    const c = clock();
    const sleeps: number[] = [];
    const lease = createDesktopLease({
      sleep: async (ms) => {
        sleeps.push(ms);
        c.advance(ms);
        if (sleeps.length === 3) expect(lease.release(A, { dir, now: c.now })).toBe(true);
      },
    });
    await lease.acquire(A, { dir, now: c.now });
    const r = await lease.acquire(B, { dir, now: c.now, waitMs: 5000, pollMs: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fresh).toBe(true);
    expect(r.lease.owner_id).toBe("agent-b");
    expect(r.lease.generation).toBe(2); // release expires the record, so the count continues
    expect(sleeps).toEqual([200, 200, 200]);
  });

  test("waiting is bounded and reports waitedMs", async () => {
    const dir = freshDir();
    const c = clock();
    const lease = createDesktopLease({ sleep: async (ms) => c.advance(ms) });
    await lease.acquire(A, { dir, now: c.now });
    const r = await lease.acquire(B, { dir, now: c.now, waitMs: 1000, pollMs: 300 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.waitedMs).toBe(1000);
  });

  test("waiting stays bounded with a frozen clock", async () => {
    const dir = freshDir();
    const frozen = () => Date.parse("2026-11-01T12:00:00Z");
    let calls = 0;
    const lease = createDesktopLease({
      sleep: async () => {
        calls++;
      },
    });
    await lease.acquire(A, { dir, now: frozen });
    const r = await lease.acquire(B, { dir, now: frozen, waitMs: 1000, pollMs: 250 });
    expect(r.ok).toBe(false);
    expect(calls).toBe(4);
  });

  test("real short timers: waiter gets the lease after release", async () => {
    const dir = freshDir();
    await desktopLease.acquire(A, { dir });
    setTimeout(() => desktopLease.release(A, { dir }), 100);
    const r = await desktopLease.acquire(B, { dir, waitMs: 1000, pollMs: 25 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lease.owner_id).toBe("agent-b");
  });

  test("an expired lease is taken by another owner and the generation increments", async () => {
    const dir = freshDir();
    const c = clock();
    await desktopLease.acquire(A, { dir, now: c.now, idleMs: 1000 });
    c.advance(1000);
    expect(desktopLease.read({ dir, now: c.now })).toBeNull();
    const r = await desktopLease.acquire(B, { dir, now: c.now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fresh).toBe(true);
    expect(r.lease.generation).toBe(2);
    expect(r.lease.owner_id).toBe("agent-b");
  });

  test("an owner re-taking its own expired lease also increments the generation", async () => {
    const dir = freshDir();
    const c = clock();
    await desktopLease.acquire(A, { dir, now: c.now, idleMs: 1000 });
    c.advance(5000);
    const r = await desktopLease.acquire(A, { dir, now: c.now, idleMs: 1000 });
    expect(r.ok && r.fresh && r.lease.generation).toBe(2);
  });

  test("release by a non-owner returns false and keeps the file", async () => {
    const dir = freshDir();
    await desktopLease.acquire(A, { dir });
    expect(desktopLease.release(B, { dir })).toBe(false);
    expect(existsSync(join(dir, "desktop-lease.json"))).toBe(true);
    expect(desktopLease.read({ dir })?.owner_id).toBe("agent-a");
    expect(desktopLease.release(A, { dir })).toBe(true);
    expect(desktopLease.read({ dir })).toBeNull();
    expect(desktopLease.release(A, { dir })).toBe(false);
  });

  test("read and release tolerate a missing directory", () => {
    const dir = join(freshDir(), "nope");
    expect(desktopLease.read({ dir })).toBeNull();
    expect(desktopLease.release(A, { dir })).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  test("a corrupt lease file counts as free and acquire overwrites it", async () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "desktop-lease.json"), "{not json");
    expect(desktopLease.read({ dir })).toBeNull();
    expect(desktopLease.release(A, { dir })).toBe(false);
    const r = await desktopLease.acquire(B, { dir });
    expect(r.ok && r.fresh && r.lease.generation).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "desktop-lease.json"), "utf8")).owner_id).toBe(
      "agent-b",
    );
  });

  test("a stale lock directory is broken", async () => {
    const dir = freshDir();
    const lock = join(dir, "lease.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: 999999, at: new Date(Date.now() - 60_000).toISOString() }),
    );
    const r = await desktopLease.acquire(A, { dir });
    expect(r.ok).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("concurrent in-process acquires by different owners yield exactly one winner", async () => {
    const dir = freshDir();
    const owners = Array.from({ length: 8 }, (_, i) => ({ id: `agent-${i}`, label: `agent-${i}` }));
    const results = await Promise.all(owners.map((o) => desktopLease.acquire(o, { dir })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  test("three racing processes yield exactly one winner", async () => {
    const dir = freshDir();
    const script = join(mkdtempSync(join(tmpdir(), "lease-race-")), "race.ts");
    const leaseModule = join(import.meta.dir, "lease.ts");
    writeFileSync(
      script,
      `import { desktopLease } from ${JSON.stringify(leaseModule)};
const id = process.argv[2];
const r = await desktopLease.acquire({ id, label: id }, { dir: process.argv[3] });
process.stdout.write(JSON.stringify({ ok: r.ok }));
`,
    );
    const procs = [0, 1, 2].map((i) =>
      Bun.spawn([process.execPath, script, `proc-${i}`, dir], { stdout: "pipe", stderr: "pipe" }),
    );
    const outs = await Promise.all(
      procs.map(async (p) => {
        const out = await new Response(p.stdout).text();
        expect(await p.exited).toBe(0);
        return JSON.parse(out) as { ok: boolean };
      }),
    );
    expect(outs.filter((o) => o.ok)).toHaveLength(1);
    const holder = desktopLease.read({ dir });
    expect(holder?.generation).toBe(1);
  }, 15_000);

  test("release expires the record so the next owner's generation keeps counting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lease-gen-"));
    const first = await desktopLease.acquire(A, { dir });
    expect(first.ok && first.lease.generation).toBe(1);
    expect(desktopLease.release(A, { dir })).toBe(true);
    const second = await desktopLease.acquire(B, { dir });
    expect(second.ok && second.lease.generation).toBe(2);
    expect(desktopLease.release(A, { dir })).toBe(false);
  });
});
