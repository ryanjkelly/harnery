import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tempRoot } from "../../../../tests/workspace-test-helpers.ts";
import { acquireNoClobberLease, type NoClobberLeaseOwner } from "./leases.ts";

const DIGEST = "a".repeat(64);
const DEAD_PID = 2_000_000_000;

describe("no-clobber workspace leases", () => {
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
    const moduleUrl = pathToFileURL(resolve(import.meta.dir, "leases.ts")).href;
    const code = `
      const { acquireNoClobberLease } = await import(${JSON.stringify(moduleUrl)});
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
        await new Promise(resolve => setTimeout(resolve, 300));
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
    const results = await Promise.all(
      children.map(async (child) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
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

function readCurrentOwner(path: string): NoClobberLeaseOwner {
  const current = join(path, "current");
  expect(statSync(current).isFile()).toBe(true);
  return JSON.parse(readFileSync(current, "utf8")) as NoClobberLeaseOwner;
}
