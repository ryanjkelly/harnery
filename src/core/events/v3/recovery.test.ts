import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EventV3Fixture,
  eventV3Fixture,
  fixtureObject,
} from "../../../../tests/helpers/event-v3.ts";
import { initializeEventLedgerV3 } from "./bootstrap.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import type { EventV3 } from "./contract.ts";
import { readEventV3ControlState } from "./control.ts";
import { readLedgerV3 } from "./reader.ts";
import { recoverInvalidEventLedgerV3 } from "./recovery.ts";
import { eventV3RecoveryRecordsRoot } from "./recovery-record.ts";
import { assertEventV3 } from "./validate.ts";
import { eventV3Paths, writeEventV3 } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V3 invalid-authority recovery", () => {
  test("quarantines the recorded 1ms regression and starts one clean authority", () => {
    const root = freshRoot();
    initializeEventLedgerV3({
      coordRoot: root,
      harneryBuild: "fixture-before",
      hostBuild: "fixture-host",
      configDigest: sha256V3("config"),
      approvalRecordId: "fixture-initial",
      now: () => new Date("2026-08-19T19:30:00.000Z"),
    });

    const session = producerEvent("session.started", 1, "2026-08-19T19:33:27.976Z", "1");
    const sessionScope = fixtureObject(session.scope);
    const runtimeAttestation = fixtureObject(fixtureObject(session.payload).runtime_attestation);
    runtimeAttestation.attestation_id = session.attestation_id;
    runtimeAttestation.generation_id = sessionScope.generation_id;
    runtimeAttestation.declared_by_event_id = session.event_id;

    const tool = producerEvent("tool.completed", 2, "2026-08-19T19:39:36.078Z", "2");
    alignWithSession(tool, session);
    const turn = producerEvent("turn.completed", 3, "2026-08-19T19:39:36.077Z", "3");
    alignWithSession(turn, session);
    const later = producerEvent("session.ended", 4, "2026-08-19T19:39:36.080Z", "4");
    alignWithSession(later, session);
    for (const event of [session, tool, turn, later]) assertEventV3(event);

    const appended = [session, tool, turn, later]
      .map((event) => `${canonicalJsonV3(event)}\n`)
      .join("");
    const activePath = eventV3Paths(root).active;
    appendFileSync(activePath, appended, "utf8");
    const failedBytes = readFileSync(activePath);
    const invalidOffset = failedBytes.indexOf(Buffer.from(`${canonicalJsonV3(turn)}\n`, "utf8"));
    expect(invalidOffset).toBeGreaterThan(0);

    const failed = readLedgerV3(root, { authority: "active" });
    expect(failed.complete).toBe(false);
    expect(failed.diagnostics[0]).toMatchObject({
      code: "wall_clock_regression_unmarked",
      byte_offset: invalidOffset,
      event_id: turn.event_id,
    });
    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "ledger_integrity_failure",
    });

    const recovered = recover(root);
    expect(recovered.state).toBe("recovered");
    expect(recovered.receipt.failure).toMatchObject({
      active_digest: sha256V3(failedBytes),
      active_bytes: failedBytes.length,
      validated_prefix_digest: sha256V3(failedBytes.subarray(0, invalidOffset)),
      validated_prefix_bytes: invalidOffset,
      diagnostic: {
        code: "wall_clock_regression_unmarked",
        byte_offset: invalidOffset,
        event_id: turn.event_id,
      },
    });

    const archive = join(
      root,
      ".harnery",
      "ledgers",
      "v3-archives",
      recovered.receipt.archive_directory,
    );
    const archivedActive = join(archive, "active.ndjson");
    expect(readFileSync(archivedActive)).toEqual(failedBytes);
    expect(readFileSync(archivedActive, "utf8")).toContain(String(later.event_id));

    const current = readLedgerV3(root, { authority: "active" });
    expect(current.complete).toBe(true);
    expect(current.failed_epochs).toEqual([recovered.receipt]);
    expect(current.events.map(({ event }) => event.event_id)).not.toContain(later.event_id);
    expect(current.events.map(({ event }) => event.event_type)).toEqual([
      "ledger.genesis",
      "ledger.activated",
    ]);

    const receiptPath = join(
      eventV3RecoveryRecordsRoot(root),
      `${recovered.receipt.recovery_id}.committed.json`,
    );
    const receiptText = readFileSync(receiptPath, "utf8");
    expect(receiptText).not.toContain('"event_type"');
    expect(receiptText).not.toContain('"payload"');
    expect(readdirSync(eventV3RecoveryRecordsRoot(root))).toEqual([
      `${recovered.receipt.recovery_id}.committed.json`,
    ]);

    const next = eventV3Fixture("ledger.comparability_advanced", 1);
    writeEventV3(root, next as unknown as EventV3);
    expect(readFileSync(archivedActive)).toEqual(failedBytes);
    expect(readLedgerV3(root, { authority: "active" }).events.at(-1)?.event.event_id).toBe(
      String(next.event_id),
    );

    const repeated = recover(root);
    expect(repeated).toEqual({ state: "already_recovered", receipt: recovered.receipt });
    expect(readdirSync(join(root, ".harnery", "ledgers", "v3-archives"))).toEqual([
      recovered.receipt.archive_directory,
    ]);

    writeFileSync(
      join(eventV3RecoveryRecordsRoot(root), `rcv_${"f".repeat(32)}.committed.json`),
      "{}\n",
      "utf8",
    );
    const corruptReceipt = readLedgerV3(root, { authority: "active" });
    expect(corruptReceipt.complete).toBe(false);
    expect(corruptReceipt.diagnostics.map(({ code }) => code)).toContain("recovery_record_invalid");
  });
});

function recover(root: string) {
  return recoverInvalidEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture-after",
    hostBuild: "fixture-host",
    configDigest: sha256V3("config"),
    approvalRecordId: "fixture-invalid-authority-recovery",
    now: () => new Date("2026-08-19T20:00:00.000Z"),
  });
}

function producerEvent(
  eventType: "session.started" | "tool.completed" | "turn.completed" | "session.ended",
  sequence: number,
  observedAt: string,
  monotonicNs: string,
): EventV3Fixture {
  const event = eventV3Fixture(eventType, sequence + 10);
  const producer = fixtureObject(event.producer);
  producer.producer_id = "prd_agent-hook";
  producer.boot_id = "boot_recorded-regression";
  producer.sequence = sequence;
  const time = fixtureObject(event.time);
  time.clock_id = "clk_00000000-0000-7000-8000-000000000099";
  time.observed_at = observedAt;
  time.recorded_at = observedAt;
  time.monotonic_ns = monotonicNs;
  time.skew = "normal";
  return event;
}

function alignWithSession(event: EventV3Fixture, session: EventV3Fixture): void {
  const eventScope = fixtureObject(event.scope);
  const sessionScope = fixtureObject(session.scope);
  eventScope.root_id = sessionScope.root_id;
  eventScope.instance_id = sessionScope.instance_id;
  eventScope.generation_id = sessionScope.generation_id;
  if ("attestation_id" in event) event.attestation_id = session.attestation_id;
}

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-recovery-"));
  roots.push(root);
  return root;
}
