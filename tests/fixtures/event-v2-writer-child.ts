import { buildEventV2 } from "../../src/core/events/v2/builder.ts";
import { attestationIdV2, eventIdV2, generationIdV2 } from "../../src/core/events/v2/ids.ts";
import { writeEventV2 } from "../../src/core/events/v2/writer.ts";

const coordRoot = Bun.argv[2];
const index = Number(Bun.argv[3]);
if (!coordRoot || !Number.isSafeInteger(index) || index < 0) {
  throw new Error("writer concurrency fixture requires a root and non-negative index");
}
const generationId = generationIdV2();
const attestationId = attestationIdV2();
const eventId = eventIdV2();
const event = buildEventV2("session.started", {
  event_id: eventId,
  producer: {
    producer_id: `prd_stress-${index}`,
    boot_id: `boot_stress-${index}`,
    sequence: 1,
    component: "agent-hook",
    build_id: "build_stress-fixture",
    platform: "linux",
  },
  scope: {
    root_id: "root_stress",
    instance_id: `inst_stress-${index}`,
    session_id: `sid_${index.toString(16).padStart(64, "0")}`,
    generation_id: generationId,
  },
  attestation_id: attestationId,
  links: { caused_by: [] },
  provenance: {
    source_event: "fixture.concurrent_writer",
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
      capability_profile: `cap_${"a".repeat(64)}`,
      declared_by_event_id: eventId,
    },
    resume: { state: "not_applicable" },
  },
});

writeEventV2(coordRoot, event);
