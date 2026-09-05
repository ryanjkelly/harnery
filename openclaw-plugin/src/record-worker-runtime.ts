import { ensureEventLedgerV3 } from "../../src/core/events/v3/bootstrap.ts";
import {
  type RecordHookSignalV3Input,
  type RecordHookSignalV3Result,
  recordHookSignalV3,
} from "../../src/core/events/v3/producers/recorder.ts";
import { appendJsonLine, writeBootRow } from "./log.ts";
import type { OpenClawHookName, OpenClawTranslation } from "./types.ts";
import type { RecordWorkerData, RecordWorkerMessage } from "./worker-protocol.ts";

type RecordSignal = (input: RecordHookSignalV3Input) => RecordHookSignalV3Result;
type EnsureLedger = (coordRoot: string, approvalRecordId?: string) => unknown;

export interface RecordWorkerRuntimeDependencies {
  recordSignal?: RecordSignal;
  ensureLedger?: EnsureLedger;
  appendDebug?: (row: Record<string, unknown>) => void;
  appendBoot?: (row: Record<string, unknown>) => void;
}

export interface RecordWorkerProcessor {
  process(message: RecordWorkerMessage): boolean;
}

/**
 * Sentinel raised when the canonical recorder reports `busy`: the memory-only
 * intake queue overflowed and this signal was dropped. Its fixed `name` lets a
 * redacted `record_failure` row distinguish dropped evidence from a crash.
 */
export class RecorderBusyError extends Error {
  constructor() {
    super("openclaw_recorder_busy");
    this.name = "RecorderBusyError";
  }
}

/** Sentinel for the `recorderFault` test/debug switch that fails the recorder open. */
export class RecorderFaultInjectedError extends Error {
  constructor() {
    super("recorder_fault_injected");
    this.name = "RecorderFaultInjectedError";
  }
}

export function createRecordWorkerProcessor(
  data: RecordWorkerData,
  dependencies: RecordWorkerRuntimeDependencies = {},
): RecordWorkerProcessor {
  const recordSignal = dependencies.recordSignal ?? recordHookSignalV3;
  const ensureLedger = dependencies.ensureLedger ?? ensureEventLedgerV3;
  const debugPath = `${data.config.logRoot}/debug.jsonl`;
  const bootPath = `${data.config.logRoot}/boot.jsonl`;
  const appendDebug =
    dependencies.appendDebug ?? ((row: Record<string, unknown>) => appendJsonLine(debugPath, row));
  const appendBoot =
    dependencies.appendBoot ?? ((row: Record<string, unknown>) => writeBootRow(row, bootPath));
  let initialized = false;

  const log = (event: string, detail: Record<string, unknown> = {}): void => {
    if (!data.config.debug) return;
    appendDebug({ observed_at: new Date().toISOString(), event, ...detail });
  };

  const record = (hook: OpenClawHookName, translation: OpenClawTranslation): boolean => {
    try {
      if (data.config.recorderFault) throw new RecorderFaultInjectedError();
      if (!initialized) {
        ensureLedger(data.config.ledgerRoot, "openclaw-plugin-v3");
        initialized = true;
      }
      const result = recordSignal({
        coordRoot: data.config.ledgerRoot,
        mode: "active",
        signal: translation.signal,
        payload: translation.payload,
        adapter: "openclaw",
        instance_id: data.instanceId as `inst_${string}`,
        producer_id: "prd_openclaw-plugin",
        build_id: `build_${safeBuildId(data.packageVersion)}`,
        platform: eventPlatform(),
        adapterVersion: data.packageVersion,
        harnessVersion: data.packageVersion,
        hook_name: hook,
        intake: "memory_only",
      });
      if (result.state === "busy") {
        throw new RecorderBusyError();
      }
      log("record_result", {
        hook,
        signal: translation.signal,
        state: result.state,
        ...(result.state === "gate_closed" || result.state === "unpairable_tool"
          ? { reason: result.reason }
          : {}),
      });
      return true;
    } catch (error) {
      log("record_failure", {
        hook,
        signal: translation.signal,
        error_name: error instanceof Error ? error.name : "unknown",
      });
      return false;
    }
  };

  return {
    process(message) {
      switch (message.kind) {
        case "record":
          return record(message.hook, message.translation);
        case "capture":
          log("capture", { hook: message.hook, skeleton: message.skeleton });
          return true;
        case "log":
          log(message.event, message.detail);
          return true;
        case "boot":
          appendBoot(message.row);
          return true;
        case "flush":
        case "shutdown":
          return true;
      }
    },
  };
}

export function eventPlatform(
  platform: NodeJS.Platform = process.platform,
): RecordHookSignalV3Input["platform"] {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "unknown";
}

function safeBuildId(version: string): string {
  return version.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}
