import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../tests/helpers/event-v3-runtime.ts";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import * as builder from "../events/v3/builder.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import * as fingerprint from "../events/v3/fingerprint-keys.ts";
import * as custody from "../events/v3/generation-custody.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import { writeProducerDiagnosticV3 } from "../events/v3/producers/intake.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";
import * as writer from "../events/v3/writer.ts";
import {
  recordLiveResumeObservationV3,
  recordLiveSweepObservationV3,
} from "./live-lifecycle-v3.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("sweep observation generation custody", () => {
  test("records the captured generation provisionally and preserves native resume", () => {
    const root = fixtureRoot();
    const input = sweepInput(root);
    const originalCustody = custody.withGenerationCustodyV3;
    const held = spyOn(custody, "withGenerationCustodyV3").mockImplementation(originalCustody);
    try {
      const result = recordLiveSweepObservationV3(input);
      expect(result.event.scope).toMatchObject({ generation_id: input.expectedGenerationId });
      expect(result.event.payload).toMatchObject({ provisional: true, age_ms: 600_000 });
      expect(held).toHaveBeenCalledWith(root, ["inst_observed"], expect.any(Function));
    } finally {
      held.mockRestore();
    }
    expect(recordLiveResumeObservationV3(input).state).toBe("recorded");
    expect(sweepEvents(root)).toHaveLength(1);
  });

  test("rejects an unavailable generation before durable authority preparation", () => {
    const root = fixtureRoot();
    const input = { ...sweepInput(root), expectedGenerationId: null };
    const before = readFileSync(writer.eventV3Paths(root).active);
    const held = spyOn(custody, "withGenerationCustodyV3");
    const written = spyOn(writer, "writeEventV3");
    try {
      expect(() => recordLiveSweepObservationV3(input)).toThrow("hook_generation_not_joinable");
      expect(held).not.toHaveBeenCalled();
      expect(written).not.toHaveBeenCalled();
    } finally {
      held.mockRestore();
      written.mockRestore();
    }
    expect(readFileSync(writer.eventV3Paths(root).active)).toEqual(before);
  });

  test("rejects a stale captured generation before durable authority preparation", () => {
    const root = fixtureRoot();
    const input = sweepInput(root);
    replaceGeneration(root);
    const before = readFileSync(writer.eventV3Paths(root).active);
    const held = spyOn(custody, "withGenerationCustodyV3");
    const written = spyOn(writer, "writeEventV3");
    try {
      expect(() => recordLiveSweepObservationV3(input)).toThrow("expected_generation_changed");
      expect(held).not.toHaveBeenCalled();
      expect(written).not.toHaveBeenCalled();
    } finally {
      held.mockRestore();
      written.mockRestore();
    }
    expect(readFileSync(writer.eventV3Paths(root).active)).toEqual(before);
    expect(sweepEvents(root)).toEqual([]);
  });

  test("rejects a replacement between the initial check and custody acquisition", () => {
    const root = fixtureRoot();
    const input = sweepInput(root);
    const originalCustody = custody.withGenerationCustodyV3;
    let replaced = false;
    const built = spyOn(builder, "buildEventV3");
    const held = spyOn(custody, "withGenerationCustodyV3").mockImplementation((...args) => {
      if (!replaced && args[0] === root) {
        replaced = true;
        replaceGeneration(root);
      }
      return originalCustody(...args);
    });
    try {
      expect(() => recordLiveSweepObservationV3(input)).toThrow("expected_generation_changed");
      expect(
        built.mock.calls.some(([eventType]) => eventType === "lifecycle.sweep_observed"),
      ).toBeFalse();
    } finally {
      held.mockRestore();
      built.mockRestore();
    }
    expect(replaced).toBeTrue();
    expect(sweepInput(root).expectedGenerationId).not.toBe(input.expectedGenerationId);
    expect(sweepEvents(root)).toEqual([]);
  });

  test("rejects reentrant generation replacement before publishing any sweep event", () => {
    const root = fixtureRoot();
    const input = sweepInput(root);
    const originalContext = fingerprint.fingerprintContextV3;
    let replaced = false;
    const context = spyOn(fingerprint, "fingerprintContextV3").mockImplementation((...args) => {
      const result = originalContext(...args);
      if (!replaced && args[0] === root && args[2] === input.expectedGenerationId) {
        replaced = true;
        replaceGeneration(root);
      }
      return result;
    });
    try {
      expect(() => recordLiveSweepObservationV3(input)).toThrow("expected_generation_changed");
    } finally {
      context.mockRestore();
    }
    expect(replaced).toBeTrue();
    expect(sweepInput(root).expectedGenerationId).not.toBe(input.expectedGenerationId);
    expect(sweepEvents(root)).toEqual([]);
  });

  test("leaves terminal-generation audit failure available to the diagnostic fallback", () => {
    const root = fixtureRoot();
    const input = sweepInput(root);
    endGeneration(root);
    expectDiagnosticFallback(root, input);
  });

  test("leaves missing-generation audit failure available to the diagnostic fallback", () => {
    const root = fixtureRoot();
    expectDiagnosticFallback(root, {
      ...sweepInput(root),
      owner: "missing",
      nativeSessionId: "missing",
    });
  });

  test("leaves archived-generation audit failure available without altering either epoch", () => {
    const root = fixtureRoot();
    const input = sweepInput(root);
    const prior = readFileSync(writer.eventV3Paths(root).active);
    const rotated = initializeEventLedgerV3({
      coordRoot: root,
      harneryBuild: "fixture",
      hostBuild: "fixture",
      configDigest: sha256V3("fixture-config"),
      approvalRecordId: "test-archived-sweep-observation",
      forceNewEpoch: true,
    });
    if (!rotated.archived_epoch) throw new Error("fixture epoch was not archived");
    expectDiagnosticFallback(root, input);
    expect(readFileSync(join(rotated.archived_epoch, "active.ndjson"))).toEqual(prior);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-sweep-observation-"));
  roots.push(root);
  initializeV3Fixture(root);
  seedV3Session(root, "observed", { sessionId: "native-session" });
  return root;
}

function sweepInput(root: string) {
  const cache = JSON.parse(readFileSync(join(root, ".harnery/active/observed.json"), "utf8"));
  return {
    coordRoot: root,
    owner: "observed",
    nativeSessionId: "native-session",
    adapter: "codex" as const,
    expectedGenerationId: cache.v3_generation_id as `gen_${string}` | null,
    observation: "stale_heartbeat" as const,
    ageMs: 600_000,
  };
}

function endGeneration(root: string): void {
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error(`fixture_v3_route:${route.reason}`);
  expect(
    recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "session-end",
      adapter: "codex",
      instanceId: "observed",
      payload: { session_id: "native-session", raw: {} },
    }).state,
  ).toBe("recorded");
}

function replaceGeneration(root: string): void {
  endGeneration(root);
  seedV3Session(root, "observed", { sessionId: "native-session" });
}

function sweepEvents(root: string) {
  return readLedgerV3(root).events.filter(
    ({ event }) => event.event_type === "lifecycle.sweep_observed",
  );
}

function expectDiagnosticFallback(root: string, input: ReturnType<typeof sweepInput>): void {
  const before = readFileSync(writer.eventV3Paths(root).active);
  let failure: unknown;
  try {
    recordLiveSweepObservationV3(input);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("hook_generation_not_joinable");
  expect(
    writeProducerDiagnosticV3(root, "heartbeat_sweep_unrecorded", {
      adapter: input.adapter,
      instance_id: input.owner,
      reason: (failure as Error).message,
      state: "cache_cleanup_pending",
    }),
  ).toBeTruthy();
  expect(readFileSync(writer.eventV3Paths(root).active)).toEqual(before);
  expect(sweepEvents(root)).toEqual([]);
}
