import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildEventV2 } from "./builder.ts";
import { type FingerprintContextV2, fingerprintV2 } from "./canonical.ts";
import type { EventV2 } from "./contract.ts";
import { attestationIdV2, eventIdV2, generationIdV2, spanIdV2 } from "./ids.ts";
import { readActiveLedgerV2 } from "./reader.ts";
import { drainReadyEventsV2, type EventV2WriteStep, eventV2Paths, writeEventV2 } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V2 WAL recovery", () => {
  test("rejects direct UNC and WSL-mounted Windows roots before creating storage", () => {
    const event = minimalStartedEvent(1);
    for (const root of [
      String.raw`\\wsl.localhost\Ubuntu-22.04\home\project`,
      "//wsl.localhost/Ubuntu-22.04/home/project",
      "/mnt/c/Users/operator/project",
    ]) {
      expect(() => writeEventV2(root, event)).toThrow(
        "refuses direct UNC or cross-boundary coordination roots",
      );
    }
  });

  test(
    "serializes 32 independent writer processes without loss or corruption",
    async () => {
      const root = temporaryRoot("event-v2-concurrency");
      const childPath = resolve(
        import.meta.dir,
        "../../../../tests/fixtures/event-v2-writer-child.ts",
      );
      const children = Array.from({ length: 32 }, (_, index) =>
        Bun.spawn([process.execPath, childPath, root, String(index)], {
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const exitCodes = await Promise.all(children.map(({ exited }) => exited));
      if (exitCodes.some((code) => code !== 0)) {
        const errors = await Promise.all(
          children.map(({ stderr }) =>
            stderr ? new Response(stderr).text() : Promise.resolve(""),
          ),
        );
        throw new Error(`concurrent writer failed:${exitCodes.join(",")}:${errors.join("|")}`);
      }

      drainReadyEventsV2(root);
      const read = readActiveLedgerV2(root);
      expect(read.complete).toBe(true);
      expect(read.diagnostics).toEqual([]);
      expect(read.events).toHaveLength(32);
      expect(new Set(read.events.map(({ event }) => event.event_id)).size).toBe(32);
      expect(readdirSync(eventV2Paths(root).spool)).toEqual([]);
    },
    { timeout: 30_000 },
  );

  test("converges without residue after every writer kill point", () => {
    const killPoints: EventV2WriteStep[] = [
      "ready_temp_flushed",
      "ready_published",
      "active_row_appended",
      "active_row_flushed",
      "receipt_committed",
      "receipt_removed",
    ];
    for (const killPoint of killPoints) {
      const root = temporaryRoot(`event-v2-kill-${killPoint}`);
      const event = minimalStartedEvent(1);
      try {
        writeEventV2(root, event, {
          onStep: (step) => {
            if (step === killPoint) throw new Error(`simulated kill:${killPoint}`);
          },
        });
      } catch (error) {
        expect((error as Error).message).toBe(`simulated kill:${killPoint}`);
      }

      if (killPoint === "ready_temp_flushed") {
        expect(writeEventV2(root, event).state).toBe("committed");
      } else {
        drainReadyEventsV2(root);
      }
      const read = readActiveLedgerV2(root);
      expect(read.complete).toBe(true);
      expect(read.diagnostics).toEqual([]);
      expect(read.events.map(({ event: row }) => row.event_id)).toEqual([event.event_id]);
      expect(readdirSync(eventV2Paths(root).spool)).toEqual([]);
    }
  });

  test("deduplicates the exact replay left by a crash after the active row flush", () => {
    const root = temporaryRoot("event-v2-replay");
    const event = minimalStartedEvent(1);
    const first = writeEventV2(root, event, {
      onStep: (step) => {
        if (step === "active_row_flushed") throw new Error("simulated kill");
      },
    });

    expect(first.state).toBe("ready");
    expect(drainReadyEventsV2(root)).toBe(1);
    const physicalRows = readFileSync(eventV2Paths(root).active, "utf8").trim().split("\n");
    expect(physicalRows).toHaveLength(2);
    const read = readActiveLedgerV2(root);
    expect(read.events.map(({ event: row }) => row.event_id)).toEqual([event.event_id]);
    expect(read.diagnostics).toEqual([]);
    expect(read.complete).toBe(true);
  });

  test("truncates only an unterminated tail before replaying the durable ready row", () => {
    const root = temporaryRoot("event-v2-partial");
    const first = minimalStartedEvent(1);
    const delayed = minimalStartedEvent(2);
    expect(writeEventV2(root, first).state).toBe("committed");
    expect(() =>
      writeEventV2(root, delayed, {
        onStep: (step) => {
          if (step === "ready_published") throw new Error("simulated producer kill");
        },
      }),
    ).toThrow("simulated producer kill");

    const readyName = readdirSync(eventV2Paths(root).spool).find((name) => name.endsWith(".ready"));
    expect(readyName).toBeDefined();
    const readyRow = readFileSync(join(eventV2Paths(root).spool, readyName ?? ""), "utf8");
    appendFileSync(eventV2Paths(root).active, readyRow.slice(0, 17), "utf8");
    const steps: string[] = [];

    expect(
      drainReadyEventsV2(root, {
        onStep: (step) => steps.push(step),
      }),
    ).toBe(1);
    expect(steps).toContain("active_tail_repaired");
    const read = readActiveLedgerV2(root);
    expect(read.complete).toBe(true);
    expect(read.events.map(({ event }) => event.event_id)).toEqual([
      first.event_id,
      delayed.event_id,
    ]);
  });

  test("rejects a valid event above the 16 KiB row ceiling before creating a WAL", () => {
    const root = temporaryRoot("event-v2-oversize");
    const generationId = generationIdV2();
    const attestationId = attestationIdV2();
    const fingerprintContext: FingerprintContextV2 = {
      epochId: "pep_fixture",
      epochKey: Buffer.alloc(32, 0x55),
      rootId: "root_fixture",
      generationId,
    };
    const event = buildEventV2("tool.requested", {
      producer: {
        producer_id: "prd_size-fixture",
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
        turn_id: `tid_${"d".repeat(64)}`,
      },
      attestation_id: attestationId,
      links: { caused_by: [], span_id: spanIdV2() },
      provenance: {
        source_event: "fixture.tool_request",
        attestation: "native",
        confidence: "exact",
        attribution: { method: "native_payload", state: "verified" },
      },
      payload: {
        tool: { namespace: "fixture", name: "Read" },
        input: { storage: "omitted", media_type: "application/json", bytes: 1 },
        exact_input: fingerprintV2(fingerprintContext, "exact-input", null),
        targets: Array.from({ length: 64 }, (_, index) => ({
          kind: "workspace_path" as const,
          access: "read" as const,
          display: `${index}-${"x".repeat(230)}`,
          fingerprint: fingerprintV2(fingerprintContext, `target-${index}`, index),
          extractor_version: "fixture-v1",
        })),
      },
    });

    expect(() => writeEventV2(root, event)).toThrow("16384-byte row limit");
    expect(readActiveLedgerV2(root).events).toEqual([]);
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
      producer_id: "prd_recovery-fixture",
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
