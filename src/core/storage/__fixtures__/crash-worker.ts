import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarneryInboxService } from "../../inbox/service.ts";
import { createStorageCatalog } from "../catalog.ts";
import { appendDurableHistoryRecord } from "../durable-history.ts";
import { encodeLogRecord, type HarneryLogRecordV1 } from "../jsonl.ts";
import {
  HARNERY_MAINTENANCE_PRESSURE_SCHEMA,
  type HarneryMaintenanceProvider,
  runAutomaticMaintenanceSlice,
  writePressureSummary,
} from "../maintenance.ts";
import { FileSegmentSink } from "../segments.ts";

const [mode, root, id = "worker", countText = "1", delayText = "0"] = process.argv.slice(2);
if (!mode || !root) throw new Error("crash worker requires mode and root");

if (mode === "log") await writeLogs(root, id, Number(countText), Number(delayText));
else if (mode === "history-before") await historyBefore(root);
else if (mode === "inbox-before") await inboxBefore(root, id);
else if (mode === "inbox-after") await inboxAfter(root, id);
else if (mode === "maintenance-claim") await maintenanceClaim(root);
else throw new Error(`unknown crash worker mode: ${mode}`);

async function writeLogs(coordRoot: string, writerId: string, count: number, delay: number) {
  const family = createStorageCatalog({ coord_root: coordRoot }).require("agent-hook-debug-log");
  const sink = new FileSegmentSink({
    directory: join(coordRoot, ".harnery", "logs", "agent-hook-debug"),
    family,
    max_segment_bytes: 768,
    lease_timeout_ms: 2_000,
    lease_retry_ms: 2,
    lease_stale_ms: 100,
  });
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const record: HarneryLogRecordV1 = {
      schema: "harnery.log-record/v1",
      kind: "record",
      emitted_at: new Date(sequence * 1_000).toISOString(),
      family_id: family.id,
      policy_version: family.policy.policy_version,
      component_id: "crash-canary",
      level: "info",
      event: "crash_canary.append",
      writer_id: writerId,
      writer_seq: sequence,
      context: {},
      fields: { writer: writerId, sequence },
    };
    await sink.append([encodeLogRecord(record, family)]);
    process.stdout.write(`ACK ${sequence}\n`);
    if (delay > 0) await Bun.sleep(delay);
  }
  process.stdout.write("COMPLETE\n");
}

async function historyBefore(objectDir: string) {
  process.stdout.write("READY\n");
  await Bun.sleep(5_000);
  appendDurableHistoryRecord(
    objectDir,
    { sequence: 2, payload: "killed" },
    { max_record_bytes: 128, max_segment_bytes: 128 },
  );
  process.stdout.write("ACK\n");
}

async function inboxBefore(coordRoot: string, id: string) {
  process.stdout.write("READY\n");
  await Bun.sleep(5_000);
  inbox(coordRoot, id).send(message(`before-${id}`));
  process.stdout.write("ACK\n");
}

async function inboxAfter(coordRoot: string, id: string) {
  const receipt = inbox(coordRoot, id).send(message(`after-${id}`));
  process.stdout.write(`ACK ${receipt.message_id}\n`);
  await Bun.sleep(5_000);
}

async function maintenanceClaim(coordRoot: string) {
  writePressureSummary(coordRoot, {
    schema: HARNERY_MAINTENANCE_PRESSURE_SCHEMA,
    captured_at: "2026-08-29T12:00:00.000Z",
    families: [
      {
        family_id: "storage-maintenance-run-log",
        logical_bytes: 100,
        regular_files: 1,
        needs_maintenance: true,
        observed_at: "2026-08-29T12:00:00.000Z",
      },
    ],
  });
  const provider: HarneryMaintenanceProvider = {
    family_id: "storage-maintenance-run-log",
    plan: async () => {
      writeFileSync(join(coordRoot, "claim.marker"), "claimed\n");
      process.stdout.write("CLAIMED\n");
      await Bun.sleep(5_000);
      return { actions: [] };
    },
    apply: () => ({ outcome: "refused" }),
  };
  await runAutomaticMaintenanceSlice(
    createStorageCatalog({ coord_root: coordRoot, project_root: coordRoot }),
    [provider],
    { now: new Date("2026-08-29T12:00:00.000Z") },
  );
}

function inbox(coordRoot: string, id: string): HarneryInboxService {
  return new HarneryInboxService({
    coord_root: coordRoot,
    limits: {
      max_message_body_bytes: 256,
      max_pending_count: 10,
      max_pending_bytes: 1_024,
      max_history_bytes: 16_384,
      max_history_records: 100,
      warning_pressure_ratio: 0.8,
      max_surface_count: 4,
      max_surface_bytes: 512,
      max_surface_tokens: 128,
      surfaced_grace_ms: 1_000,
      terminal_grace_ms: 5_000,
    },
    id: () => id,
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  });
}

function message(body: string) {
  return {
    sender_instance_id: "sender",
    sender_display_name: "Sender",
    recipient_instance_id: "recipient",
    recipient_display_name: "Recipient",
    body,
  };
}
