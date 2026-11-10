import { expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run by leases.test.ts in a child `bun test` process, because mock.module
// replaces node:fs for the whole process.
//
// A contender's rename lands on `recovery` the moment the winner empties it.
// Renaming a directory onto an empty one replaces it, so the winner must never
// empty its claim under the shared name.
const realUnlink = realFs.unlinkSync;
let plant: ((path: string) => void) | undefined;
mock.module("node:fs", () => ({
  ...realFs,
  unlinkSync: (path: realFs.PathLike) => {
    realUnlink(path);
    plant?.(String(path));
  },
}));
const { acquireNoClobberLease } = await import("../leases.ts");

test("a contender's claim landing on an emptied recovery directory cannot strand the winner", () => {
  const path = join(mkdtempSync(join(tmpdir(), "workspace-lease-race-")), "operation.lease");
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const input = { path, scope: "repository", authoritySha256: "a".repeat(64), staleAfterMs: 1_000 };
  acquireNoClobberLease({ ...input, now: () => now, pid: 2_000_000_000 });

  const recovery = join(path, "recovery");
  plant = (unlinked) => {
    if (unlinked !== join(recovery, "claim.json")) return;
    plant = undefined;
    const late = join(path, "recovery-claim-late");
    realFs.mkdirSync(late);
    realFs.writeFileSync(join(late, "claim.json"), "{}\n");
    realFs.renameSync(late, recovery);
  };

  const lease = acquireNoClobberLease({ ...input, now: () => now + 2_000 });
  plant = undefined;
  expect(JSON.parse(realFs.readFileSync(join(path, "current"), "utf8")).owner_id).toBe(
    lease.owner.owner_id,
  );
  lease.release();
});
