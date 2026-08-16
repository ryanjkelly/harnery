import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEventV2 } from "./builder.ts";
import { type FingerprintContextV2, fingerprintV2, normalizeNativeIdV2 } from "./canonical.ts";
import type { EventV2, RuntimeAttestationV2 } from "./contract.ts";
import { attestationIdV2, eventIdV2, generationIdV2, spanIdV2 } from "./ids.ts";
import { readActiveLedgerV2 } from "./reader.ts";
import { eventV2Paths, writeEventV2 } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V2 vertical slice", () => {
  test("records and validates a privacy-safe Claude Code start/tool/end observation", () => {
    const root = temporaryRoot();
    const generationId = generationIdV2();
    const attestationId = attestationIdV2();
    const sessionStartedId = eventIdV2();
    const spanId = spanIdV2();
    const fingerprintContext: FingerprintContextV2 = {
      epochId: "pep_fixture",
      epochKey: Buffer.alloc(32, 0x37),
      rootId: "root_fixture",
      generationId,
    };
    const sessionId = asNativeId(
      "sid",
      normalizeNativeIdV2(fingerprintContext, "claude-session", "native-session-secret"),
    );
    const turnId = asNativeId(
      "tid",
      normalizeNativeIdV2(fingerprintContext, "claude-turn", "native-turn-secret"),
    );
    const producer = {
      producer_id: "prd_claude-hook",
      boot_id: "boot_fixture",
      component: "agent-hook" as const,
      build_id: "build_fixture",
      platform: "linux" as const,
    };
    const scope = {
      root_id: "root_fixture",
      instance_id: "inst_fixture-agent",
      session_id: sessionId,
      generation_id: generationId,
      turn_id: turnId,
    };
    const provenance = {
      source_event: "claude.session_start",
      attestation: "native" as const,
      confidence: "exact" as const,
      attribution: {
        method: "native_payload" as const,
        state: "verified" as const,
        subject_instance_id: "inst_fixture-agent",
      },
    };
    const runtimeAttestation: RuntimeAttestationV2 = {
      attestation_id: attestationId,
      generation_id: generationId,
      adapter: {
        state: "observed",
        value: { id: "claude-code", version: "1.0.0" },
        attestation: "native",
        confidence: "exact",
      },
      harness: {
        state: "observed",
        value: { id: "claude-code", version: "1.0.0" },
        attestation: "native",
        confidence: "exact",
      },
      model: { state: "unknown", reason: "not_reported" },
      capability_profile: `cap_${"a".repeat(64)}`,
      declared_by_event_id: sessionStartedId,
    };
    const started = buildEventV2("session.started", {
      event_id: sessionStartedId,
      producer: { ...producer, sequence: 1 },
      scope,
      attestation_id: attestationId,
      links: { caused_by: [] },
      provenance,
      payload: {
        runtime_attestation: runtimeAttestation,
        resume: { state: "not_applicable" },
      },
    });
    const rawToolInput = {
      command: "deploy",
      token: "API_SECRET_12345",
      target: "/home/private/account.json",
    };
    const requested = buildEventV2("tool.requested", {
      producer: { ...producer, sequence: 2 },
      scope,
      attestation_id: attestationId,
      links: { caused_by: [started.event_id], span_id: spanId },
      provenance: { ...provenance, source_event: "claude.pre_tool_use" },
      payload: {
        tool: { namespace: "claude", name: "Bash" },
        input: {
          storage: "omitted",
          media_type: "application/json",
          bytes: Buffer.byteLength(JSON.stringify(rawToolInput)),
        },
        exact_input: fingerprintV2(fingerprintContext, "exact-input", rawToolInput),
        targets: [
          {
            kind: "external_path",
            access: "write",
            fingerprint: fingerprintV2(fingerprintContext, "semantic-target", rawToolInput.target),
            extractor_version: "claude-bash-v1",
          },
        ],
      },
    });
    const completed = buildEventV2("tool.completed", {
      producer: { ...producer, sequence: 3 },
      scope,
      attestation_id: attestationId,
      links: { caused_by: [requested.event_id], span_id: spanId },
      provenance: { ...provenance, source_event: "claude.post_tool_use" },
      payload: {
        tool: { namespace: "claude", name: "Bash" },
        outcome: "succeeded",
        duration_ms: {
          state: "observed",
          value: 42,
          attestation: "derived",
          confidence: "exact",
        },
        result: {
          storage: "omitted",
          media_type: "text/plain",
          bytes: 19,
          lines: 1,
        },
      },
    });
    const ended = buildEventV2("session.ended", {
      producer: { ...producer, sequence: 4 },
      scope,
      attestation_id: attestationId,
      links: { caused_by: [completed.event_id] },
      provenance: { ...provenance, source_event: "claude.session_end" },
      payload: {
        outcome: "succeeded",
        authority: "native",
        reason: "native_clean_exit",
        completeness: {
          state: "observed",
          value: {
            expected: ["session_end", "tool_result"],
            observed: ["session_end", "tool_result"],
            missing: [],
          },
          attestation: "native",
          confidence: "exact",
        },
      },
    });

    for (const event of [started, requested, completed, ended]) {
      expect(writeEventV2(root, event as EventV2).state).toBe("committed");
    }

    const read = readActiveLedgerV2(root);
    expect(read.complete).toBe(true);
    expect(read.diagnostics).toEqual([]);
    expect(read.events.map(({ event }) => event.event_type)).toEqual([
      "session.started",
      "tool.requested",
      "tool.completed",
      "session.ended",
    ]);
    const durableBytes = readFileSync(eventV2Paths(root).active, "utf8");
    expect(durableBytes).not.toContain("API_SECRET_12345");
    expect(durableBytes).not.toContain("native-session-secret");
    expect(durableBytes).not.toContain("/home/private");
    expect(statSync(eventV2Paths(root).active).mode & 0o777).toBe(0o600);
    expect(statSync(eventV2Paths(root).spool).mode & 0o777).toBe(0o700);
  });

  test("rejects a forbidden payload field before it reaches the WAL", () => {
    const root = temporaryRoot();
    const event = minimalStartedEvent();
    (event.payload as Record<string, unknown>).prompt = "must-not-persist";
    expect(() => writeEventV2(root, event)).toThrow("V2 contract validation");
    expect(readActiveLedgerV2(root).events).toEqual([]);
  });

  test("rejects V1 and malformed rows instead of projecting them", () => {
    const root = temporaryRoot();
    const active = eventV2Paths(root).active;
    mkdirSync(join(root, ".harnery/ledgers/v2"), { recursive: true });
    writeFileSync(active, '{"schema_version":1}\n{"broken":', "utf8");
    const read = readActiveLedgerV2(root);
    expect(read.events).toEqual([]);
    expect(read.complete).toBe(false);
    expect(read.diagnostics.map(({ code }) => code)).toEqual([
      "unsupported_major",
      "partial_final_frame",
    ]);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-event-v2-"));
  roots.push(root);
  return root;
}

function asNativeId(prefix: "sid" | "tid", id: `hid_${string}`): `sid_${string}` | `tid_${string}` {
  return `${prefix}_${id.slice(4)}` as `sid_${string}` | `tid_${string}`;
}

function minimalStartedEvent(): EventV2 {
  const generationId = generationIdV2();
  const attestationId = attestationIdV2();
  const eventId = eventIdV2();
  return buildEventV2("session.started", {
    event_id: eventId,
    producer: {
      producer_id: "prd_fixture",
      boot_id: "boot_fixture",
      sequence: 1,
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
      source_event: "claude.session_start",
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
