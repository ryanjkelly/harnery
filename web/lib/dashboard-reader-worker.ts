import { parentPort } from "node:worker_threads";
import { readAgents } from "./coord-reader";
import type { DashboardRequest, DashboardResponse } from "./dashboard-reader-protocol";
import { readEventQuery } from "./event-query-reader";
import { readHomeSnapshot } from "./home-snapshot-reader";
import { buildPaletteCatalog } from "./palette/catalog-reader";

if (!parentPort) throw new Error("dashboard_reader_requires_worker");
const port = parentPort;

// Requests execute serially in this worker. Its module caches survive between
// reads, while filesystem scans and ledger reduction stay off the HTTP thread.
port.on("message", (request: DashboardRequest) => {
  let response: DashboardResponse;
  try {
    switch (request.kind) {
      case "agents":
        response = { id: request.id, ok: true, value: readAgents() };
        break;
      case "palette":
        response = { id: request.id, ok: true, value: buildPaletteCatalog() };
        break;
      case "home":
        response = { id: request.id, ok: true, value: readHomeSnapshot() };
        break;
      case "events":
        response = { id: request.id, ok: true, value: readEventQuery(request.input ?? {}) };
        break;
      default:
        throw new Error("dashboard_reader_unknown_request");
    }
  } catch {
    response = { id: request.id, ok: false, error: "dashboard_reader_failed" };
  }
  port.postMessage(response);
});
