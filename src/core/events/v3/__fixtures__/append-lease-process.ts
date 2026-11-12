// Run in a separate process: take the ledger append lease once and release it.
// Exits 0 when the lease was taken, 3 when it was refused.
//
// argv: <coordination root>
import { acquireEventV3AppendLeaseV3 } from "../writer.ts";

const [root] = process.argv.slice(2) as [string];
try {
  acquireEventV3AppendLeaseV3(root).release();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(3);
}
process.exit(0);
