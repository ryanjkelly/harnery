import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEventV2 } from "./builder.ts";
import { readEventV2Catalog, recoverEventV2Catalog, rotateEventLedgerV2 } from "./catalog.ts";
import type { EventV2 } from "./contract.ts";
import { attestationIdV2, eventIdV2, generationIdV2 } from "./ids.ts";
import { readLedgerV2 } from "./reader.ts";
import { ensureEventV2Layout, eventV2Paths, writeEventV2 } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V2 catalog and rotation", () => {
  test("seals canonical segments and reads cataloged history plus the active tail", () => {
    const root = temporaryRoot("event-v2-rotation");
    const first = minimalStartedEvent(1);
    const second = minimalStartedEvent(2);
    expect(writeEventV2(root, first).state).toBe("committed");

    const rotation = rotateEventLedgerV2(root);
    expect(rotation.rotated).toBe(true);
    expect(rotation.manifest?.row_count).toBe(1);
    expect(rotation.catalog.segments).toHaveLength(1);
    expect(writeEventV2(root, second).state).toBe("committed");

    const read = readLedgerV2(root);
    expect(read.complete).toBe(true);
    expect(read.events.map(({ event }) => event.event_id)).toEqual([
      first.event_id,
      second.event_id,
    ]);
    expect(read.events.map(({ position }) => position.segment_ordinal)).toEqual([1, 2]);
  });

  test("reconciles a segment orphaned between active rename and metadata publication", () => {
    const root = temporaryRoot("event-v2-orphan");
    const event = minimalStartedEvent(1);
    expect(writeEventV2(root, event).state).toBe("committed");
    const paths = ensureEventV2Layout(root);
    const orphan = join(paths.segments, "000000000001.ndjson");
    renameSync(paths.active, orphan);
    closeSync(openSync(paths.active, "wx", 0o600));

    const catalog = recoverEventV2Catalog(root);
    expect(catalog.segments).toHaveLength(1);
    expect(readEventV2Catalog(root)).toEqual(catalog);
    expect(readLedgerV2(root).events[0]?.event.event_id).toBe(event.event_id);
  });

  test("reports sealed-byte tampering and active-file replacement instead of following it", () => {
    const root = temporaryRoot("event-v2-tamper");
    expect(writeEventV2(root, minimalStartedEvent(1)).state).toBe("committed");
    rotateEventLedgerV2(root);
    const paths = eventV2Paths(root);
    appendFileSync(join(paths.segments, "000000000001.ndjson"), "{}\n", "utf8");
    expect(readLedgerV2(root).diagnostics[0]?.code).toBe("segment_digest_mismatch");

    const cleanRoot = temporaryRoot("event-v2-active-replaced");
    expect(writeEventV2(cleanRoot, minimalStartedEvent(1)).state).toBe("committed");
    recoverEventV2Catalog(cleanRoot);
    const cleanPaths = eventV2Paths(cleanRoot);
    unlinkSync(cleanPaths.active);
    closeSync(openSync(cleanPaths.active, "wx", 0o600));
    expect(readLedgerV2(cleanRoot).diagnostics[0]?.code).toBe("active_replaced");
  });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}

function minimalStartedEvent(sequence: number): EventV2 {
  const generationId = generationIdV2();
  const attestationId = attestationIdV2();
  const eventId = eventIdV2();
  return buildEventV2("session.started", {
    event_id: eventId,
    producer: {
      producer_id: "prd_catalog-fixture",
      boot_id: "boot_fixture",
      sequence,
      component: "agent-hook",
      build_id: "build_fixture",
      platform: "linux",
    },
    scope: {
      root_id: "root_fixture",
      instance_id: "inst_fixture",
      session_id: `sid_${"b".repeat(64)}`,
      generation_id: generationId,
    },
    attestation_id: attestationId,
    links: { caused_by: [] },
    provenance: {
      source_event: "fixture.session_start",
      attestation: "native",
      confidence: "exact",
      attribution: { method: "native_payload", state: "verified" },
    },
    payload: {
      runtime_attestation: {
        attestation_id: attestationId,
        generation_id: generationId,
        adapter: { state: "unsupported", capability: "adapter_identity" },
        harness: { state: "unsupported", capability: "harness_identity" },
        model: { state: "unsupported", capability: "model_identity" },
        capability_profile: `cap_${"c".repeat(64)}`,
        declared_by_event_id: eventId,
      },
      resume: { state: "not_applicable" },
    },
  }) as EventV2;
}
