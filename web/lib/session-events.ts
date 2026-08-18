/** Privacy-safe V2 command projection consumed by the `/live` viewer. */
import fs from "node:fs";
import path from "node:path";
import type { EventV2 } from "../../src/core/events/v2/contract";
import { readEventV2ControlState } from "../../src/core/events/v2/control";
import { readActiveLedgerV2, readLedgerV2 } from "../../src/core/events/v2/reader";
import { harneryDir } from "./coord-reader";

export interface SessionEvent {
  ts: string;
  type:
    | "command_start"
    | "output"
    | "command_end"
    | "end_of_turn"
    | "hook_event"
    | "set_task"
    | "file_claim"
    | "file_release"
    | "peer_change"
    | "narration";
  agent_name: string;
  agent_id?: string;
  instance_id?: string;
  cmd_id?: string;
  intent?: string;
  cmd?: string;
  line?: string;
  stream?: "stdout" | "stderr";
  exit?: number | null;
  signal?: string | null;
  duration_ms?: number;
  message?: string;
}

let nameCache: { at: number; map: Map<string, string> } | null = null;
const NAME_TTL_MS = 5000;

function resolveAgentName(instanceId: string | undefined): string {
  if (!instanceId) return "";
  const now = Date.now();
  if (!nameCache || now - nameCache.at > NAME_TTL_MS) {
    const map = new Map<string, string>();
    try {
      const activeDir = path.join(harneryDir(), "active");
      for (const file of fs.readdirSync(activeDir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const row = JSON.parse(fs.readFileSync(path.join(activeDir, file), "utf8")) as {
            instance_id?: string;
            name?: string;
          };
          if (row.instance_id && row.name) map.set(row.instance_id, row.name);
        } catch {
          // One disposable cache row must not hide the ledger.
        }
      }
    } catch {
      // Names are optional presentation metadata.
    }
    nameCache = { at: now, map };
  }
  return nameCache.map.get(instanceId) ?? "";
}

export function projectSessionEventV2(event: EventV2): SessionEvent | null {
  const instanceId = event.scope.instance_id;
  const base = {
    ts: event.time.recorded_at,
    instance_id: instanceId,
    agent_name: resolveAgentName(instanceId),
  };
  switch (event.event_type) {
    case "command.started":
      return {
        ...base,
        type: "command_start",
        cmd_id: eventSpanId(event),
        cmd: event.payload.executable,
        intent: event.payload.intent_kind,
      };
    case "command.output_observed":
      return {
        ...base,
        type: "output",
        cmd_id: eventSpanId(event),
        stream: event.payload.stream === "combined" ? "stdout" : event.payload.stream,
        line: `[${event.payload.stream}: ${event.payload.bytes} bytes recorded structurally]`,
      };
    case "command.completed":
      return {
        ...base,
        type: "command_end",
        cmd_id: eventSpanId(event),
        exit:
          event.payload.exit_code ??
          (event.payload.outcome === "succeeded"
            ? 0
            : event.payload.outcome === "unknown"
              ? null
              : 1),
        signal: event.payload.signal,
        duration_ms: event.payload.duration_ms,
      };
    case "tool.requested":
      return {
        ...base,
        type: "command_start",
        cmd_id: eventSpanId(event),
        cmd: `${event.payload.tool.namespace}.${event.payload.tool.name}`,
      };
    case "tool.completed":
      return {
        ...base,
        type: "command_end",
        cmd_id: eventSpanId(event),
        exit:
          event.payload.outcome === "succeeded"
            ? 0
            : event.payload.outcome === "unknown"
              ? null
              : 1,
        duration_ms:
          event.payload.duration_ms.state === "observed"
            ? event.payload.duration_ms.value
            : undefined,
      };
    default:
      return null;
  }
}

function eventSpanId(event: EventV2): string | undefined {
  const links = event.links as { span_id?: unknown };
  return typeof links.span_id === "string" ? links.span_id : undefined;
}

export async function readSessionEventsTail(
  opts: { lines?: number; agent?: string } = {},
): Promise<SessionEvent[]> {
  const { lines = 200, agent } = opts;
  const events = readV2CommandEvents();
  const selected = agent ? events.filter((event) => event.agent_name === agent) : events;
  return selected.length > lines ? selected.slice(-lines) : selected;
}

function readV2CommandEvents(): SessionEvent[] {
  const root = path.dirname(harneryDir());
  const control = readEventV2ControlState(root);
  if (control.state !== "candidate" && control.state !== "active") return [];
  const catalog = path.join(root, ".harnery", "ledgers", "v2", "catalog.json");
  const ledger = fs.existsSync(catalog) ? readLedgerV2(root) : readActiveLedgerV2(root);
  if (!ledger.complete) return [];
  return ledger.events
    .map(({ event }) => projectSessionEventV2(event))
    .filter((event): event is SessionEvent => event !== null);
}
