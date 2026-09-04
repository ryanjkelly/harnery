import { parentPort, workerData } from "node:worker_threads";
import { createRecordWorkerProcessor } from "./record-worker-runtime.ts";
import type {
  RecordWorkerData,
  RecordWorkerMessage,
  RecordWorkerReply,
} from "./worker-protocol.ts";

if (!parentPort) throw new Error("record_worker_requires_parent_port");
const port = parentPort;

const processor = createRecordWorkerProcessor(workerData as RecordWorkerData);

port.on("message", (message: RecordWorkerMessage) => {
  let ok = false;
  try {
    ok = processor.process(message);
  } catch {
    ok = false;
  }
  const reply: RecordWorkerReply = { id: message.id, kind: message.kind, ok };
  port.postMessage(reply);
  if (message.kind === "shutdown") port.close();
});
