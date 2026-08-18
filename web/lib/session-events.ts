/** Privacy-safe V2 command projection consumed by the `/live` viewer. */
import path from "node:path";
import { readLiveCoordinationRows } from "../../src/core/agents/state/live-coordination-view";
import type { EventV2 } from "../../src/core/events/v2/contract";
import { readEventV2ControlState } from "../../src/core/events/v2/control";
import { readLedgerV2 } from "../../src/core/events/v2/reader";
import { harneryDir } from "./coord-reader";

export interface SessionEvent {
  ts: string;
  type:
    | "command.started"
    | "command.output_observed"
    | "command.completed"
    | "tool.requested"
    | "tool.completed";
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
      const root = path.dirname(harneryDir());
      for (const row of readLiveCoordinationRows(root)) {
        if (row.instance_id && row.name) map.set(row.instance_id, row.name);
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
        type: "command.started",
        cmd_id: eventSpanId(event),
        cmd: event.payload.executable,
        intent: event.payload.intent_kind,
      };
    case "command.output_observed":
      return {
        ...base,
        type: "command.output_observed",
        cmd_id: eventSpanId(event),
        stream: event.payload.stream === "combined" ? "stdout" : event.payload.stream,
        line: `[${event.payload.stream}: ${event.payload.bytes} bytes recorded structurally]`,
      };
    case "command.completed":
      return {
        ...base,
        type: "command.completed",
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
        type: "tool.requested",
        cmd_id: eventSpanId(event),
        cmd: `${event.payload.tool.namespace}.${event.payload.tool.name}`,
      };
    case "tool.completed":
      return {
        ...base,
        type: "tool.completed",
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
  const ledger = readLedgerV2(root);
  if (!ledger.complete) return [];
  return ledger.events
    .map(({ event }) => projectSessionEventV2(event))
    .filter((event): event is SessionEvent => event !== null);
}
