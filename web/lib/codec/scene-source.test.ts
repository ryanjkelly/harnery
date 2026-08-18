import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEventV2 } from "../../../src/core/events/v2/builder";
import { attestationIdV2, eventIdV2, generationIdV2 } from "../../../src/core/events/v2/ids";
import { readSanitizedTails } from "./scene-source";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codec V2 ledger tail", () => {
  test("reads and sanitizes validated V2 rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "codec-v2-ledger-"));
    roots.push(root);
    const v2Path = join(root, "v2.ndjson");
    const eventId = eventIdV2();
    const generationId = generationIdV2();
    const attestationId = attestationIdV2();
    const v2 = buildEventV2("session.started", {
      event_id: eventId,
      producer: {
        producer_id: "prd_codec-fixture",
        boot_id: "boot_fixture",
        sequence: 1,
        component: "agent-hook",
        build_id: "build_fixture",
        platform: "linux",
      },
      scope: {
        root_id: "root_fixture",
        instance_id: "inst_fixture",
        session_id: `sid_${"a".repeat(64)}`,
        generation_id: generationId,
      },
      attestation_id: attestationId,
      links: { caused_by: [] },
      provenance: {
        source_event: "fixture.codec",
        attestation: "derived",
        confidence: "exact",
        attribution: {
          method: "explicit_argument",
          state: "verified",
          observer_instance_id: "inst_fixture",
          subject_instance_id: "inst_fixture",
        },
      },
      observed_at: "2026-08-16T10:00:01.000Z",
      recorded_at: "2026-08-16T10:00:01.000Z",
      payload: {
        runtime_attestation: {
          attestation_id: attestationId,
          generation_id: generationId,
          adapter: {
            state: "observed",
            value: { id: "claude-code" },
            attestation: "native",
            confidence: "exact",
          },
          harness: {
            state: "observed",
            value: { id: "fixture" },
            attestation: "native",
            confidence: "exact",
          },
          model: { state: "unsupported", capability: "model_identity" },
          capability_profile: `cap_${"b".repeat(64)}`,
          declared_by_event_id: eventId,
        },
        resume: { state: "not_applicable" },
      },
    });
    writeFileSync(v2Path, `${JSON.stringify(v2)}\n`);

    const rows = await readSanitizedTails([v2Path]);
    expect(rows.map((row) => row.event_id)).toEqual([eventId]);
    expect(rows.map((row) => row.event_type)).toEqual(["session.start"]);
  });
});
