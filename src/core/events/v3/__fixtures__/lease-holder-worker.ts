// Worker thread that takes event ledger leases and blocks while holding them,
// so the parent can terminate it mid-operation or observe a live holder.
import { parentPort, workerData } from "node:worker_threads";
import { withEventV3LedgerLease, withEventV3PublicationLease } from "../writer.ts";

const { root, nested, cell } = workerData as {
  root: string;
  nested: boolean;
  cell: SharedArrayBuffer;
};
const port = parentPort;
if (!port) throw new Error("lease holder fixture requires a parent port");

const hold = (): void => {
  port.postMessage("holding");
  Atomics.wait(new Int32Array(cell), 0, 0);
};
if (nested) withEventV3PublicationLease(root, () => withEventV3LedgerLease(root, {}, hold));
else withEventV3LedgerLease(root, {}, hold);
port.postMessage("released");
