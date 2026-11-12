import { parentPort, workerData } from "node:worker_threads";
import {
  createRecordWorkerProcessor,
  type RecordWorkerOutcome,
  rejectionReason,
} from "./record-worker-runtime.ts";
import type {
  RecordWorkerData,
  RecordWorkerMessage,
  RecordWorkerReply,
} from "./worker-protocol.ts";

if (!parentPort) throw new Error("record_worker_requires_parent_port");
const port = parentPort;

const processor = createRecordWorkerProcessor(workerData as RecordWorkerData);

port.on("message", (message: RecordWorkerMessage) => {
  let outcome: RecordWorkerOutcome;
  try {
    outcome = processor.processDetailed(message);
  } catch (error) {
    outcome = { ok: false, reason: rejectionReason(error) };
  }
  const reply: RecordWorkerReply = outcome.ok
    ? { id: message.id, kind: message.kind, ok: true }
    : { id: message.id, kind: message.kind, ok: false, reason: outcome.reason };
  port.postMessage(reply);
  if (message.kind === "shutdown") port.close();
});
