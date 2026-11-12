import { describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { threadId } from "node:worker_threads";
import {
  acquireNoClobberLease,
  type NoClobberLease,
  type NoClobberLeaseOwner,
  reclaimNoClobberLeaseOfExitedThread,
} from "./no-clobber-lease.ts";

const DIGEST = "a".repeat(64);
const TEMP_BASE = realpathSync(tmpdir());

function tempRoot(label: string): string {
  return mkdtempSync(join(TEMP_BASE, `${label}-`));
}

const DEAD_PID = 2_000_000_000;

describe("no-clobber leases", () => {
  test("an expired foreign owner cannot be recovered from elapsed time alone", () => {
    const path = join(tempRoot("workspace-lease-foreign"), "operation.lease");
    acquireNoClobberLease({
      path,
      scope: "binding",
      authoritySha256: DIGEST,
      staleAfterMs: 1_000,
      now: () => 1_000,
      host: "another-host",
      pid: DEAD_PID,
    });
    const before = readFileSync(join(path, "current"), "utf8");
    expect(() =>
      acquireNoClobberLease({
        path,
        scope: "binding",
        authoritySha256: DIGEST,
        staleAfterMs: 1_000,
        now: () => 10_000,
      }),
    ).toThrow(/liveness is unknown/);
    expect(readFileSync(join(path, "current"), "utf8")).toBe(before);
    expect(existsSync(join(path, "recovery"))).toBe(false);
  });

  for (const code of ["EIO", "EPERM", undefined]) {
    test(`an expired owner with ${code ?? "unclassified"} process-probe failure cannot be recovered`, () => {
      const path = join(tempRoot("workspace-lease-unknown"), "operation.lease");
      acquireNoClobberLease({
        path,
        scope: "binding",
        authoritySha256: DIGEST,
        staleAfterMs: 1_000,
        now: () => 1_000,
        pid: DEAD_PID,
      });
      const before = readFileSync(join(path, "current"), "utf8");
      expect(() =>
        acquireNoClobberLease({
          path,
          scope: "binding",
          authoritySha256: DIGEST,
          staleAfterMs: 1_000,
          now: () => 10_000,
          probePid: () => {
            throw Object.assign(new Error("probe failed"), { code });
          },
        }),
      ).toThrow(/liveness is unknown/);
      expect(readFileSync(join(path, "current"), "utf8")).toBe(before);
      expect(existsSync(join(path, "recovery"))).toBe(false);
    });
  }
  test("refuses a live owner and releases only the exact owner inode", () => {
    const path = join(tempRoot("workspace-lease-live"), "operation.lease");
    const first = acquireNoClobberLease({
      path,
      scope: "binding",
      authoritySha256: DIGEST,
      staleAfterMs: 60_000,
    });
    expect(() =>
      acquireNoClobberLease({
        path,
        scope: "binding",
        authoritySha256: DIGEST,
        staleAfterMs: 60_000,
      }),
    ).toThrow(/live or unexpired/);
    first.release();
    expect(existsSync(join(path, "current"))).toBe(false);
  });

  test("retries when a contended owner releases before inspection", () => {
    const path = join(tempRoot("workspace-lease-release-race"), "operation.lease");
    const first = acquireNoClobberLease({
      path,
      scope: "binding",
      authoritySha256: DIGEST,
      staleAfterMs: 60_000,
    });
    let contentions = 0;
    const second = acquireNoClobberLease({
      path,
      scope: "binding",
      authoritySha256: DIGEST,
      staleAfterMs: 60_000,
      onContention: () => {
        contentions += 1;
        first.release();
      },
    });

    expect(contentions).toBe(1);
    expect(readCurrentOwner(path).owner_id).toBe(second.owner.owner_id);
    second.release();
    expect(readdirSync(path).filter((entry) => entry.startsWith("owner-"))).toEqual([]);
  });

  test("accepts a lease directory created by a concurrent contender", () => {
    const path = join(tempRoot("workspace-lease-directory-race"), "operation.lease");
    const lease = acquireNoClobberLease({
      path,
      scope: "binding",
      authoritySha256: DIGEST,
      staleAfterMs: 60_000,
      onLeaseDirectoryCreate: () => mkdirSync(path, { mode: 0o700 }),
    });

    expect(readCurrentOwner(path).owner_id).toBe(lease.owner.owner_id);
    lease.release();
  });

  test("recovers an exact stale owner through one recovery claimant", () => {
    const path = join(tempRoot("workspace-lease-stale"), "operation.lease");
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    acquireNoClobberLease({
      path,
      scope: "cleanup",
      authoritySha256: DIGEST,
      staleAfterMs: 1_000,
      now: () => now,
      pid: DEAD_PID,
    });
    now += 2_000;
    const recovered = acquireNoClobberLease({
      path,
      scope: "cleanup",
      authoritySha256: DIGEST,
      staleAfterMs: 1_000,
      now: () => now,
      validateStaleOwner: (owner) => owner.authority_sha256 === DIGEST,
    });
    expect(recovered.recovered_owner?.authority_sha256).toBe(DIGEST);
    expect(existsSync(join(path, "recovery"))).toBe(false);
    recovered.release();
  });

  test("allows exactly one separate-process stale contender and leaves a releasable lease", async () => {
    const path = join(tempRoot("workspace-lease-concurrent"), "operation.lease");
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    acquireNoClobberLease({
      path,
      scope: "repository",
      authoritySha256: DIGEST,
      staleAfterMs: 1_000,
      now: () => now,
      pid: DEAD_PID,
    });
    const contenderNow = now + 2_000;
    const moduleUrl = pathToFileURL(resolve(import.meta.dir, "no-clobber-lease.ts")).href;
    // The winner holds the lease until every other contender has finished. A
    // fixed hold let a contender whose process started late (slow on a loaded
    // Windows machine) find the lease already released and win it again.
    const releaseSignal = `${path}.release`;
    const code = `
      const { acquireNoClobberLease } = await import(${JSON.stringify(moduleUrl)});
      const { existsSync } = await import("node:fs");
      try {
        const lease = acquireNoClobberLease({
          path: ${JSON.stringify(path)},
          scope: "repository",
          authoritySha256: ${JSON.stringify(DIGEST)},
          staleAfterMs: 1000,
          now: () => ${contenderNow},
          validateStaleOwner: owner => owner.authority_sha256 === ${JSON.stringify(DIGEST)}
        });
        process.stdout.write("won:" + process.pid + "\\n");
        const deadline = Date.now() + 20000;
        while (!existsSync(${JSON.stringify(releaseSignal)}) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        lease.release();
      } catch (error) {
        process.stdout.write("lost:" + error.message + "\\n");
      }
    `;
    const children = Array.from({ length: 6 }, () =>
      Bun.spawn({
        cmd: [process.execPath, "-e", code],
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    let finished = 0;
    const results = await Promise.all(
      children.map(async (child) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        // Every contender but the winner has finished: let the winner release.
        finished += 1;
        if (finished === children.length - 1) writeFileSync(releaseSignal, "");
        return { exitCode, stdout, stderr };
      }),
    );
    expect(
      results.every((result) => result.exitCode === 0),
      JSON.stringify(results),
    ).toBe(true);
    const winners = results.filter((result) => result.stdout.startsWith("won:"));
    expect(winners, JSON.stringify(results)).toHaveLength(1);
    expect(results.filter((result) => result.stdout.startsWith("lost:"))).toHaveLength(5);
    expect(existsSync(join(path, "current"))).toBe(false);
    expect(readdirSync(path).filter((entry) => entry.startsWith("owner-"))).toEqual([]);
    expect(readdirSync(path).filter((entry) => entry.startsWith("recovery"))).toEqual([]);
  });

  test("abandons its recovery claim when current changes after stale observation", () => {
    const path = join(tempRoot("workspace-lease-recovery-race"), "operation.lease");
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    acquireNoClobberLease({
      path,
      scope: "repository",
      authoritySha256: DIGEST,
      staleAfterMs: 1_000,
      now: () => now,
      pid: DEAD_PID,
    });

    const racerId = "racer";
    const racerFile = `owner-${racerId}.json`;
    const racer: NoClobberLeaseOwner = {
      schema_version: 1,
      owner_id: racerId,
      owner_file: racerFile,
      scope: "repository",
      authority_sha256: DIGEST,
      pid: process.pid,
      host: "test-host",
      created_at: new Date(now + 2_000).toISOString(),
      expires_at: new Date(now + 3_000).toISOString(),
    };
    writeFileSync(join(path, racerFile), `${JSON.stringify(racer)}\n`);

    expect(() =>
      acquireNoClobberLease({
        path,
        scope: "repository",
        authoritySha256: DIGEST,
        staleAfterMs: 1_000,
        now: () => now + 2_000,
        validateStaleOwner: (owner) => owner.authority_sha256 === DIGEST,
        onRecoveryStep: (step) => {
          if (step !== "claim_created") return;
          unlinkSync(join(path, "current"));
          linkSync(join(path, racerFile), join(path, "current"));
        },
      }),
    ).toThrow(/recovery raced with another contender/);

    expect(readdirSync(path).filter((entry) => entry.startsWith("recovery"))).toEqual([]);
    expect(readCurrentOwner(path).owner_id).toBe(racerId);
    expect(readdirSync(path).filter((entry) => entry.startsWith("owner-"))).toHaveLength(2);
  });

  test("a contender's claim landing on an emptied recovery directory cannot strand the winner", () => {
    const fixture = resolve(import.meta.dir, "__fixtures__/no-clobber-lease-race.ts");
    const run = Bun.spawnSync([process.execPath, "test", fixture], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(`${run.stdout}${run.stderr}`).toContain(" 1 pass");
    expect(run.exitCode).toBe(0);
  });

  test("finishes its recovery when a contender's claim lands after the claim is retired", () => {
    const path = join(tempRoot("workspace-lease-late-claim"), "operation.lease");
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    acquireNoClobberLease({
      path,
      scope: "repository",
      authoritySha256: DIGEST,
      staleAfterMs: 1_000,
      now: () => now,
      pid: DEAD_PID,
    });
    const recovery = join(path, "recovery");
    const late = join(path, "recovery-claim-late");

    const lease = acquireNoClobberLease({
      path,
      scope: "repository",
      authoritySha256: DIGEST,
      staleAfterMs: 1_000,
      now: () => now + 2_000,
      validateStaleOwner: (owner) => owner.authority_sha256 === DIGEST,
      onRecoveryStep: (step) => {
        if (step !== "recovery_retired") return;
        // A contender's rename succeeds once the shared name is free.
        mkdirSync(late);
        writeFileSync(join(late, "claim.json"), "{}\n");
        renameSync(late, recovery);
      },
    });

    expect(readCurrentOwner(path).owner_id).toBe(lease.owner.owner_id);
    expect(existsSync(join(recovery, "claim.json"))).toBe(true);
    expect(readdirSync(path).filter((entry) => entry.startsWith("recovery-retired-"))).toEqual([]);
    lease.release();
  });

  for (const boundary of [
    "claim_created",
    "stale_pinned",
    "current_removed",
    "new_current_linked",
  ] as const) {
    test(`reconciles a crash after recovery ${boundary.replaceAll("_", " ")}`, () => {
      const path = join(tempRoot(`workspace-lease-crash-${boundary}`), "operation.lease");
      let now = Date.parse("2026-01-01T00:00:00.000Z");
      acquireNoClobberLease({
        path,
        scope: "cleanup",
        authoritySha256: DIGEST,
        staleAfterMs: 1_000,
        now: () => now,
        pid: DEAD_PID,
      });
      now += 2_000;
      expect(() =>
        acquireNoClobberLease({
          path,
          scope: "cleanup",
          authoritySha256: DIGEST,
          staleAfterMs: 1_000,
          now: () => now,
          pid: DEAD_PID - 1,
          validateStaleOwner: (owner) => owner.authority_sha256 === DIGEST,
          onRecoveryStep: (step) => {
            if (step === boundary) throw new Error(`crash:${boundary}`);
          },
        }),
      ).toThrow(`crash:${boundary}`);
      expect(existsSync(join(path, "recovery"))).toBe(true);
      expect(() =>
        acquireNoClobberLease({
          path,
          scope: "cleanup",
          authoritySha256: DIGEST,
          staleAfterMs: 1_000,
          now: () => now,
          validateStaleOwner: (owner) => owner.authority_sha256 === DIGEST,
        }),
      ).toThrow(/recovery is already in progress/);

      now += 2_000;
      const recovered = acquireNoClobberLease({
        path,
        scope: "cleanup",
        authoritySha256: DIGEST,
        staleAfterMs: 1_000,
        now: () => now,
        validateStaleOwner: (owner) => owner.authority_sha256 === DIGEST,
      });
      expect(existsSync(join(path, "recovery"))).toBe(false);
      expect(readCurrentOwner(path).owner_id).toBe(recovered.owner.owner_id);
      recovered.release();
      expect(readdirSync(path).filter((entry) => entry.startsWith("owner-"))).toEqual([]);
    });
  }

  test("fails closed on corrupt or mismatched stale ownership", () => {
    const root = tempRoot("workspace-lease-corrupt");
    const corrupt = join(root, "corrupt.lease");
    mkdirSync(corrupt);
    writeFileSync(join(corrupt, "current"), "{}\n");
    expect(() =>
      acquireNoClobberLease({
        path: corrupt,
        scope: "binding",
        authoritySha256: DIGEST,
        staleAfterMs: 1,
      }),
    ).toThrow(/unsupported schema/);

    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const mismatched = join(root, "mismatched.lease");
    acquireNoClobberLease({
      path: mismatched,
      scope: "binding",
      authoritySha256: DIGEST,
      staleAfterMs: 1,
      now: () => now,
      pid: DEAD_PID,
    });
    now += 2;
    expect(() =>
      acquireNoClobberLease({
        path: mismatched,
        scope: "binding",
        authoritySha256: "b".repeat(64),
        staleAfterMs: 1,
        now: () => now,
        validateStaleOwner: (owner) => owner.authority_sha256 === "b".repeat(64),
      }),
    ).toThrow(/mismatched authority/);
  });
});

describe("no-clobber leases held by a thread of this process", () => {
  const start = Date.parse("2026-01-01T00:00:00.000Z");

  function ownThreadLease(path: string, now: () => number, opt = true): NoClobberLease {
    return acquireNoClobberLease({
      path,
      scope: "binding",
      authoritySha256: DIGEST,
      staleAfterMs: 1_000,
      now,
      validateStaleOwner: () => false,
      recoverAbandonedOwnThread: opt,
    });
  }

  function dropWithoutRelease(path: string, now: () => number, opt = true): void {
    ownThreadLease(path, now, opt);
  }

  async function collectDroppedHandles(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
  }

  test("records the holder thread in the owner file", () => {
    const path = join(tempRoot("lease-thread-owner"), "operation.lease");
    const lease = ownThreadLease(path, () => start);
    expect(readCurrentOwner(path).thread_id).toBe(threadId);
    lease.release();
  });

  test("reclaims an expired lease this thread left held after its handle was dropped", async () => {
    const path = join(tempRoot("lease-thread-dropped"), "operation.lease");
    let now = start;
    dropWithoutRelease(path, () => now);
    await collectDroppedHandles();
    now += 2_000;

    const lease = ownThreadLease(path, () => now);
    expect(lease.recovered_owner?.thread_id).toBe(threadId);
    expect(lease.recovered_owner?.pid).toBe(process.pid);
    lease.release();
    expect(readdirSync(path)).toEqual([]);
  });

  test("reclaims an expired lease whose release failed in this thread", () => {
    const path = join(tempRoot("lease-thread-failed-release"), "operation.lease");
    let now = start;
    const held = ownThreadLease(path, () => now);
    const owner = join(path, held.owner.owner_file);
    const parked = `${owner}.parked`;
    renameSync(owner, parked);
    expect(() => held.release()).toThrow();
    renameSync(parked, owner);
    now += 2_000;

    const lease = ownThreadLease(path, () => now);
    expect(lease.recovered_owner?.owner_id).toBe(held.owner.owner_id);
    lease.release();
  });

  test("a nested acquisition of a lease this thread still holds refuses even after expiry", () => {
    const path = join(tempRoot("lease-thread-nested"), "operation.lease");
    let now = start;
    const outer = ownThreadLease(path, () => now);
    now += 60_000;
    expect(() => ownThreadLease(path, () => now)).toThrow(/live or unexpired/);
    expect(readCurrentOwner(path).owner_id).toBe(outer.owner.owner_id);
    outer.release();
  });

  test("an unexpired lease this thread abandoned is not reclaimed", async () => {
    const path = join(tempRoot("lease-thread-unexpired"), "operation.lease");
    const now = start;
    dropWithoutRelease(path, () => now);
    await collectDroppedHandles();
    expect(() => ownThreadLease(path, () => now + 500)).toThrow(/live or unexpired/);
  });

  test("a caller that does not opt in keeps refusing its own process", async () => {
    const path = join(tempRoot("lease-thread-no-opt-in"), "operation.lease");
    let now = start;
    dropWithoutRelease(path, () => now, false);
    await collectDroppedHandles();
    now += 2_000;
    expect(() => ownThreadLease(path, () => now, false)).toThrow(/live or unexpired/);
  });

  test("an owner from another thread of this process is not reclaimed by expiry", () => {
    const path = join(tempRoot("lease-thread-other"), "operation.lease");
    let now = start;
    const held = ownThreadLease(path, () => now);
    held.release();
    forgeCurrentThread(path, held, threadId + 1_000);
    now += 60_000;
    expect(() => ownThreadLease(path, () => now)).toThrow(/live or unexpired/);
  });

  test("an owner record without a thread id is read and never reclaimed in process", () => {
    const path = join(tempRoot("lease-thread-legacy"), "operation.lease");
    let now = start;
    const held = ownThreadLease(path, () => now);
    held.release();
    forgeCurrentThread(path, held, undefined);
    now += 60_000;
    expect(readCurrentOwner(path).thread_id).toBeUndefined();
    expect(() => ownThreadLease(path, () => now)).toThrow(/live or unexpired/);
  });

  test("F1: a symlinked alias cannot reclaim a lease this thread holds through the real path", () => {
    const root = tempRoot("lease-thread-alias");
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    const realPath = join(root, "real", "operation.lease");
    const aliasPath = join(root, "alias", "operation.lease");
    let now = start;
    const outer = ownThreadLease(realPath, () => now);
    now += 60_000;

    expect(() => ownThreadLease(aliasPath, () => now)).toThrow(/live or unexpired/);
    expect(readCurrentOwner(realPath).owner_id).toBe(outer.owner.owner_id);
    expect(existsSync(join(realPath, "recovery"))).toBe(false);
    outer.release();
    expect(readdirSync(realPath)).toEqual([]);
  });

  test("F1: the real path cannot reclaim a lease this thread holds through an alias it created", () => {
    const root = tempRoot("lease-thread-alias-first");
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    const realPath = join(root, "real", "operation.lease");
    const aliasPath = join(root, "alias", "operation.lease");
    let now = start;
    // The alias acquisition creates the lease directory.
    const outer = ownThreadLease(aliasPath, () => now);
    now += 60_000;

    expect(() => ownThreadLease(realPath, () => now)).toThrow(/live or unexpired/);
    expect(readCurrentOwner(realPath).owner_id).toBe(outer.owner.owner_id);
    outer.release();
    // Once released through the alias, the real path acquires normally.
    ownThreadLease(realPath, () => now).release();
  });

  test("F1: an exited thread's lease is reclaimed through an alias of its directory", () => {
    const root = tempRoot("lease-thread-alias-exited");
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    const realPath = join(root, "real", "operation.lease");
    const held = ownThreadLease(realPath, () => start);
    held.release();
    const exited = threadId + 1_000;
    forgeCurrentThread(realPath, held, exited);
    expect(
      reclaimNoClobberLeaseOfExitedThread({
        path: join(root, "alias", "operation.lease"),
        scope: "binding",
        threadId: exited,
      }),
    ).toBe(true);
    expect(readdirSync(realPath)).toEqual([]);
  });

  test("an exited thread's lease is reclaimed only for that thread id", () => {
    const path = join(tempRoot("lease-thread-exited"), "operation.lease");
    const held = ownThreadLease(path, () => start);
    held.release();
    const exited = threadId + 1_000;
    forgeCurrentThread(path, held, exited);

    expect(
      reclaimNoClobberLeaseOfExitedThread({ path, scope: "binding", threadId: exited + 1 }),
    ).toBe(false);
    expect(reclaimNoClobberLeaseOfExitedThread({ path, scope: "other", threadId: exited })).toBe(
      false,
    );
    expect(readCurrentOwner(path).thread_id).toBe(exited);

    expect(reclaimNoClobberLeaseOfExitedThread({ path, scope: "binding", threadId: exited })).toBe(
      true,
    );
    expect(readdirSync(path)).toEqual([]);
    expect(reclaimNoClobberLeaseOfExitedThread({ path, scope: "binding", threadId: exited })).toBe(
      false,
    );
  });

  test("the exited-thread release refuses this thread and another process", () => {
    const path = join(tempRoot("lease-thread-exited-guard"), "operation.lease");
    const held = ownThreadLease(path, () => start);
    expect(() => reclaimNoClobberLeaseOfExitedThread({ path, scope: "binding", threadId })).toThrow(
      /current thread/,
    );
    held.release();
    forgeCurrentThread(path, held, threadId + 1_000, DEAD_PID);
    expect(
      reclaimNoClobberLeaseOfExitedThread({ path, scope: "binding", threadId: threadId + 1_000 }),
    ).toBe(false);
    expect(readCurrentOwner(path).pid).toBe(DEAD_PID);
  });

  test("an exited thread's abandoned recovery claim is reconciled", () => {
    const path = join(tempRoot("lease-thread-exited-recovery"), "operation.lease");
    let now = start;
    acquireNoClobberLease({
      path,
      scope: "binding",
      authoritySha256: DIGEST,
      staleAfterMs: 1_000,
      now: () => now,
      pid: DEAD_PID,
    });
    now += 2_000;
    expect(() =>
      acquireNoClobberLease({
        path,
        scope: "binding",
        authoritySha256: DIGEST,
        staleAfterMs: 1_000,
        now: () => now,
        onRecoveryStep: (step) => {
          if (step === "stale_pinned") throw new Error("thread stopped");
        },
      }),
    ).toThrow("thread stopped");
    const claimPath = join(path, "recovery", "claim.json");
    const claim = JSON.parse(readFileSync(claimPath, "utf8")) as {
      claimant: NoClobberLeaseOwner;
    };
    const exited = threadId + 2_000;
    rewriteClaimantThread(path, exited);
    expect(claim.claimant.thread_id).toBe(threadId);

    expect(reclaimNoClobberLeaseOfExitedThread({ path, scope: "binding", threadId: exited })).toBe(
      true,
    );
    expect(existsSync(join(path, "recovery"))).toBe(false);
    expect(readCurrentOwner(path).pid).toBe(DEAD_PID);
  });
});

describe("residue of an exited-thread release that stopped part-way", () => {
  /** Points the release passes. It never links a replacement owner, so it has no others. */
  const REACHED = ["claim_created", "stale_pinned", "current_removed", "recovery_retired"] as const;
  const NOT_REACHED = ["new_current_linked", "release"] as const;
  /** A failure here leaves a recovery claim or the exited owner, which others must respect. */
  const BLOCKING: ReadonlySet<string> = new Set([
    "claim_created",
    "stale_pinned",
    "current_removed",
  ]);

  /** A ledger caller: its own duration, liveness-only validation, own-thread opt-in. */
  function normalCaller(path: string): NoClobberLease {
    return acquireNoClobberLease({
      path,
      scope: "binding",
      authoritySha256: DIGEST,
      staleAfterMs: 5_000,
      now: () => Date.now() + 60_000,
      validateStaleOwner: (owner) => owner.host === hostname() && !pidMayBeAlive(owner.pid),
      recoverAbandonedOwnThread: true,
    });
  }

  function exitedThreadHolds(path: string): number {
    const held = acquireNoClobberLease({
      path,
      scope: "binding",
      authoritySha256: DIGEST,
      staleAfterMs: 5_000,
    });
    held.release();
    const exited = threadId + 1_000;
    forgeCurrentThread(path, held, exited);
    return exited;
  }

  function releaseStoppingAt(path: string, exited: number, fault?: string): boolean {
    return reclaimNoClobberLeaseOfExitedThread({
      path,
      scope: "binding",
      threadId: exited,
      onRecoveryStep: (step) => {
        if (step === fault) throw new Error("cleanup stopped");
      },
      onRelease: () => {
        if (fault === "release") throw new Error("cleanup stopped");
      },
    });
  }

  function expectClean(path: string): void {
    expect(existsSync(join(path, "current"))).toBe(false);
    expect(readdirSync(path).filter((entry) => entry.startsWith("owner-"))).toEqual([]);
    expect(readdirSync(path).filter((entry) => entry === "recovery")).toEqual([]);
  }

  for (const fault of REACHED) {
    test(`F2: repeating the exited-thread release at once clears what a failure at ${fault} left`, () => {
      const path = join(tempRoot(`lease-exited-repeat-${fault}`), "operation.lease");
      const exited = exitedThreadHolds(path);
      expect(() => releaseStoppingAt(path, exited, fault)).toThrow("cleanup stopped");
      // No supervisor-owned `current` is ever published.
      if (existsSync(join(path, "current"))) expect(readCurrentOwner(path).thread_id).toBe(exited);

      expect(releaseStoppingAt(path, exited)).toBe(true);
      expect(readdirSync(path)).toEqual([]);
      expect(releaseStoppingAt(path, exited)).toBe(false);
    });

    test(`F2: a normal caller in this thread recovers after a failure at ${fault}`, () => {
      const path = join(tempRoot(`lease-exited-residue-${fault}`), "operation.lease");
      const exited = exitedThreadHolds(path);
      expect(() => releaseStoppingAt(path, exited, fault)).toThrow("cleanup stopped");

      const lease = normalCaller(path);
      lease.release();
      expectClean(path);
    });

    test(`F2: a later process recovers after a crash at ${fault}`, async () => {
      const path = join(tempRoot(`lease-exited-restart-${fault}`), "operation.lease");
      const fixture = resolve(import.meta.dir, "__fixtures__", "exited-thread-cleanup-crash.ts");
      const child = Bun.spawn({
        cmd: [process.execPath, fixture, path, fault],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(pidMayBeAlive(child.pid)).toBe(false);
      expect(existsSync(join(path, "current")) || existsSync(join(path, "recovery"))).toBe(
        BLOCKING.has(fault),
      );

      const lease = normalCaller(path);
      lease.release();
      expectClean(path);
    });
  }

  for (const fault of NOT_REACHED) {
    test(`F4: the exited-thread release never reaches ${fault}, so it cannot stop there`, () => {
      const path = join(tempRoot(`lease-exited-unreached-${fault}`), "operation.lease");
      const exited = exitedThreadHolds(path);
      expect(releaseStoppingAt(path, exited, fault)).toBe(true);
      expect(readdirSync(path)).toEqual([]);
    });
  }

  test("F4: a repeated release leaves a lease this thread still holds", () => {
    const path = join(tempRoot("lease-exited-own-held"), "operation.lease");
    const exited = exitedThreadHolds(path);
    expect(releaseStoppingAt(path, exited)).toBe(true);
    const held = normalCaller(path);
    expect(releaseStoppingAt(path, exited)).toBe(false);
    expect(readCurrentOwner(path).owner_id).toBe(held.owner.owner_id);
    held.release();
  });

  test("F4: a nested release does not clear a claim this thread is still making", () => {
    const path = join(tempRoot("lease-exited-nested"), "operation.lease");
    const exited = exitedThreadHolds(path);
    let nested: unknown;
    reclaimNoClobberLeaseOfExitedThread({
      path,
      scope: "binding",
      threadId: exited,
      onRecoveryStep: (step) => {
        if (step !== "stale_pinned") return;
        try {
          releaseStoppingAt(path, exited);
        } catch (error) {
          nested = error;
        }
      },
    });
    expect((nested as Error | undefined)?.message).toMatch(/recovery is already in progress/);
    expect(readdirSync(path)).toEqual([]);
  });
});

/** Publish a released owner record again as if another thread or process held it. */
function forgeCurrentThread(
  path: string,
  held: NoClobberLease,
  thread: number | undefined,
  pid = process.pid,
): void {
  const owner: Record<string, unknown> = { ...held.owner, pid };
  if (thread === undefined) delete owner.thread_id;
  else owner.thread_id = thread;
  const ownerPath = join(path, held.owner.owner_file);
  writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
  linkSync(ownerPath, join(path, "current"));
}

function rewriteClaimantThread(path: string, thread: number): void {
  const claimPath = join(path, "recovery", "claim.json");
  const claim = JSON.parse(readFileSync(claimPath, "utf8")) as {
    claimant: NoClobberLeaseOwner;
  };
  const claimant = { ...claim.claimant, thread_id: thread };
  const updated = { ...claim, claimant };
  unlinkSync(claimPath);
  writeFileSync(claimPath, `${JSON.stringify(updated)}\n`);
  const claimantFile = join(path, claim.claimant.owner_file);
  if (existsSync(claimantFile)) {
    unlinkSync(claimantFile);
    writeFileSync(claimantFile, `${JSON.stringify(claimant)}\n`);
  }
}

function pidMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readCurrentOwner(path: string): NoClobberLeaseOwner {
  const current = join(path, "current");
  expect(statSync(current).isFile()).toBe(true);
  return JSON.parse(readFileSync(current, "utf8")) as NoClobberLeaseOwner;
}
