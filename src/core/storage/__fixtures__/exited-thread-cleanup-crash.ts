// Run by no-clobber-lease.test.ts in a child process. It leaves the residue of
// an exited-thread release that stopped part-way, then this process exits, so
// the parent can recover it as a later process with a different pid.
//
// argv: <lease path> <fault: a recovery step, or "release">
import { linkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { threadId } from "node:worker_threads";
import { acquireNoClobberLease, reclaimNoClobberLeaseOfExitedThread } from "../no-clobber-lease.ts";

const [path, fault] = process.argv.slice(2) as [string, string];
const held = acquireNoClobberLease({
  path,
  scope: "binding",
  authoritySha256: "a".repeat(64),
  staleAfterMs: 5_000,
});
held.release();
// Publish the owner again as if a worker thread of this process held it.
const exited = threadId + 1_000;
const ownerPath = join(path, held.owner.owner_file);
writeFileSync(ownerPath, `${JSON.stringify({ ...held.owner, thread_id: exited })}\n`);
linkSync(ownerPath, join(path, "current"));

try {
  reclaimNoClobberLeaseOfExitedThread({
    path,
    scope: "binding",
    threadId: exited,
    onRecoveryStep: (step) => {
      // A crash: the process stops here and runs no further code.
      if (step === fault) process.exit(0);
    },
    onRelease: () => {
      if (fault === "release") throw new Error("release interrupted");
    },
  });
} catch (error) {
  if ((error as Error).message !== "release interrupted") throw error;
  process.exit(0);
}
process.exit(2);
