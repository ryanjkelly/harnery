// Worker thread that writes one event to the ledger and reports the outcome,
// so a test can check whether a later recorder thread is able to write.
import { parentPort, workerData } from "node:worker_threads";
import { eventV3Fixture, fixtureObject } from "../../../../../tests/helpers/event-v3.ts";
import type { EventV3 } from "../contract.ts";
import { writeEventV3 } from "../writer.ts";

const { root, sequence } = workerData as { root: string; sequence: number };
const port = parentPort;
if (!port) throw new Error("ledger writer fixture requires a parent port");

const fixture = eventV3Fixture("tool.requested", sequence);
const producer = fixtureObject(fixture.producer);
producer.producer_id = "prd_thread_lease";
producer.boot_id = "boot_prd_thread_lease";
producer.sequence = sequence;
try {
  const result = writeEventV3(root, fixture as unknown as EventV3);
  port.postMessage({ state: result.state, diagnostic_code: result.diagnostic_code });
} catch (error) {
  port.postMessage({ state: "threw", error: (error as Error).message });
}
