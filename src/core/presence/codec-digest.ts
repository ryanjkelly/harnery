import type { EventV3 } from "../events/v3/contract.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";

export type PresenceCodecCategory =
  | "research"
  | "diagnostic"
  | "build"
  | "edit"
  | "test"
  | "coordinate"
  | "other";

export interface PresenceCodecAction {
  category: PresenceCodecCategory;
  outcome: "ok" | "error" | "unknown";
  event_id: string;
  observed_at: string;
}

export interface PresenceCodecDigest {
  schema_version: 1;
  observed_at: string;
  operation?: {
    category: PresenceCodecCategory;
    label: string;
    event_id: string;
    observed_at: string;
  };
  context?: {
    used_percent: number;
    confidence: "exact" | "reported" | "estimated";
    event_id: string;
    observed_at: string;
  };
  recent_actions: PresenceCodecAction[];
}

interface Slot {
  observedAt?: string;
  open: Map<string, NonNullable<PresenceCodecDigest["operation"]>>;
  context?: PresenceCodecDigest["context"];
  actions: PresenceCodecAction[];
}

const MAX_LEDGER_ROWS = 5_000;
const MAX_ACTIONS = 3;

/** Build a strict, content-free per-instance digest for encrypted presence. */
export function buildPresenceCodecDigests(coordRoot: string): Map<string, PresenceCodecDigest> {
  const read = readLedgerV3(coordRoot);
  if (!read.complete) return new Map();
  return projectPresenceCodecDigests(read.events.slice(-MAX_LEDGER_ROWS).map((row) => row.event));
}

export function projectPresenceCodecDigests(
  events: readonly EventV3[],
): Map<string, PresenceCodecDigest> {
  const slots = new Map<string, Slot>();
  const get = (instanceId: string) => {
    let slot = slots.get(instanceId);
    if (!slot) {
      slot = { open: new Map(), actions: [] };
      slots.set(instanceId, slot);
    }
    return slot;
  };

  for (const event of events) {
    if (!("instance_id" in event.scope)) continue;
    const slot = get(event.scope.instance_id);
    slot.observedAt = event.time.observed_at;
    const spanId = (event.links as { span_id?: string }).span_id;
    switch (event.event_type) {
      case "tool.requested":
        if (spanId) {
          slot.open.set(spanId, {
            category: categorize(event.payload.tool.namespace, event.payload.tool.name),
            label: operationLabel(event.payload.tool.namespace, event.payload.tool.name),
            event_id: event.event_id,
            observed_at: event.time.observed_at,
          });
        }
        break;
      case "command.started":
        if (spanId) {
          slot.open.set(spanId, {
            category: "diagnostic",
            label: "Running a command",
            event_id: event.event_id,
            observed_at: event.time.observed_at,
          });
        }
        break;
      case "wait.started":
        slot.open.set(event.payload.wait_id, {
          category: "coordinate",
          label: "Waiting",
          event_id: event.event_id,
          observed_at: event.time.observed_at,
        });
        break;
      case "tool.completed":
      case "command.completed":
        if (spanId) slot.open.delete(spanId);
        pushAction(slot, {
          category:
            event.event_type === "tool.completed"
              ? categorize(event.payload.tool.namespace, event.payload.tool.name)
              : "diagnostic",
          outcome: outcome(event.payload.outcome),
          event_id: event.event_id,
          observed_at: event.time.observed_at,
        });
        break;
      case "wait.ended":
        slot.open.delete(event.payload.wait_id);
        pushAction(slot, {
          category: "coordinate",
          outcome: outcome(event.payload.outcome),
          event_id: event.event_id,
          observed_at: event.time.observed_at,
        });
        break;
      case "progress.observed":
        pushAction(slot, {
          category: progressCategory(event.payload.kind),
          outcome: "ok",
          event_id: event.event_id,
          observed_at: event.time.observed_at,
        });
        break;
      case "context.observed": {
        const measurement = event.payload.measurement;
        if (measurement.state === "observed" && measurement.value.limit_tokens > 0) {
          slot.context = {
            used_percent: Math.min(
              100,
              Math.max(
                0,
                Math.round((measurement.value.used_tokens / measurement.value.limit_tokens) * 100),
              ),
            ),
            confidence: measurement.confidence === "exact" ? "exact" : "reported",
            event_id: event.event_id,
            observed_at: event.time.observed_at,
          };
        }
        break;
      }
      case "turn.completed":
      case "session.ended":
      case "agent.completed":
        slot.open.clear();
        break;
      default:
        break;
    }
  }

  const digests = new Map<string, PresenceCodecDigest>();
  for (const [instanceId, slot] of slots) {
    if (!slot.observedAt) continue;
    const operation = [...slot.open.values()].at(-1);
    digests.set(instanceId, {
      schema_version: 1,
      observed_at: slot.observedAt,
      ...(operation ? { operation } : {}),
      ...(slot.context ? { context: slot.context } : {}),
      recent_actions: slot.actions,
    });
  }
  return digests;
}

function pushAction(slot: Slot, action: PresenceCodecAction): void {
  slot.actions.push(action);
  if (slot.actions.length > MAX_ACTIONS) slot.actions.shift();
}

function outcome(value: string): PresenceCodecAction["outcome"] {
  return value === "succeeded" ? "ok" : value === "failed" ? "error" : "unknown";
}

function categorize(namespace: string, name: string): PresenceCodecCategory {
  const key = `${namespace}/${name}`.toLowerCase();
  if (/agent|message|plan|workflow|council|decide/.test(key)) return "coordinate";
  if (/patch|edit|write|create/.test(key)) return "edit";
  if (/test|playwright|vitest|jest/.test(key)) return "test";
  if (/publish|deploy|image|document|spreadsheet|presentation/.test(key)) return "build";
  if (/search|read|grep|glob|fetch|browser|view/.test(key)) return "research";
  if (/exec|command|shell|bash|terminal/.test(key)) return "diagnostic";
  return "other";
}

function operationLabel(namespace: string, name: string): string {
  const category = categorize(namespace, name);
  return {
    research: "Researching",
    diagnostic: "Running a command",
    build: "Building",
    edit: "Editing files",
    test: "Testing",
    coordinate: "Coordinating",
    other: "Working",
  }[category];
}

function progressCategory(kind: string): PresenceCodecCategory {
  if (kind === "write") return "edit";
  if (kind === "test") return "test";
  if (kind === "commit" || kind === "deploy" || kind === "publication") return "build";
  if (kind === "review") return "coordinate";
  if (kind === "artifact") return "build";
  return "other";
}
