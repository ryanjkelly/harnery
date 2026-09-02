import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { eventV3Fixture } from "../../../../tests/helpers/event-v3.ts";
import { initializeEventLedgerV3, rotateOversizedEventLedgerV3 } from "./bootstrap.ts";
import { sha256V3 } from "./canonical.ts";
import type { EventV3 } from "./contract.ts";
import { liveGenesisIdV3 } from "./control.ts";
import { readCoordinationViewV3 } from "./coordination-view.ts";
import {
  liveInstanceIdV3,
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "./live-routing.ts";
import { recordCommandSignalV3 } from "./producers/command-recorder.ts";
import { readHookProducerStateV3, recordHookSignalV3 } from "./producers/recorder.ts";
import { readLedgerV3 } from "./reader.ts";
import { drainReadyEventsV3, eventV3Paths, writeEventV3 } from "./writer.ts";

const roots: string[] = [];
const savedThresholdEnv = process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedThresholdEnv === undefined) {
    delete process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES;
  } else {
    process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES = savedThresholdEnv;
  }
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-rotation-"));
  roots.push(root);
  return root;
}

function activeRoot(): string {
  const root = freshRoot();
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture-host",
    configDigest: sha256V3("config"),
    approvalRecordId: "fixture-initial",
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  });
  return root;
}

function archives(root: string): string[] {
  const directory = join(root, ".harnery", "ledgers", "v3-archives");
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

describe("event ledger V3 size rotation", () => {
  test("archives an oversized valid epoch intact and starts a complete successor", () => {
    const root = activeRoot();
    const genesisBefore = liveGenesisIdV3(root);
    const fixture = eventV3Fixture("ledger.comparability_advanced", 1) as unknown as EventV3;
    expect(writeEventV3(root, fixture).state).toBe("committed");
    const activeBytesBefore = readFileSync(eventV3Paths(root).active);

    const rotated = rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 });
    expect(rotated.state).toBe("rotated");
    expect(rotated.archived_epoch).toBeDefined();
    expect(rotated.control?.state).toBe("active");

    const archivedActive = join(rotated.archived_epoch!, "active.ndjson");
    expect(readFileSync(archivedActive)).toEqual(activeBytesBefore);

    const genesisAfter = liveGenesisIdV3(root);
    expect(genesisAfter).toBeDefined();
    expect(genesisAfter).not.toBe(genesisBefore);

    const ledger = readLedgerV3(root);
    expect(ledger).toMatchObject({ complete: true, diagnostics: [] });
    expect(ledger.events.map(({ event }) => event.event_type)).toEqual([
      "ledger.genesis",
      "ledger.activated",
    ]);
  });

  test("reports not_oversized and disabled without touching the epoch", () => {
    const root = activeRoot();
    const genesis = liveGenesisIdV3(root);
    expect(rotateOversizedEventLedgerV3(root, { thresholdBytes: 1024 * 1024 }).state).toBe(
      "not_oversized",
    );
    expect(rotateOversizedEventLedgerV3(root, { thresholdBytes: 0 }).state).toBe("disabled");
    expect(liveGenesisIdV3(root)).toBe(genesis!);
    expect(archives(root)).toEqual([]);
  });

  test("rotation drains the durable spool into the epoch that produced it", () => {
    const root = activeRoot();
    const fixture = eventV3Fixture("ledger.comparability_advanced", 1) as unknown as EventV3;
    expect(writeEventV3(root, fixture, { deferDrain: true }).state).toBe("ready");

    const rotated = rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 });
    expect(rotated.state).toBe("rotated");
    const archivedActive = readFileSync(join(rotated.archived_epoch!, "active.ndjson"), "utf8");
    expect(archivedActive).toContain(String(fixture.event_id));
    expect(readdirSync(join(rotated.archived_epoch!, "spool"))).toEqual([]);
  });

  test("the writer fence refuses an event produced for a replaced epoch", () => {
    const root = activeRoot();
    const staleGenesis = liveGenesisIdV3(root)!;
    expect(rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 }).state).toBe("rotated");

    const fixture = eventV3Fixture("ledger.comparability_advanced", 1) as unknown as EventV3;
    const refused = writeEventV3(root, fixture, { expectedGenesisId: staleGenesis });
    expect(refused.state).toBe("epoch_replaced");

    const ledger = readLedgerV3(root);
    expect(ledger).toMatchObject({ complete: true, diagnostics: [] });
    expect(ledger.events.map(({ event }) => event.event_id)).not.toContain(
      String(fixture.event_id),
    );
    expect(readdirSync(eventV3Paths(root).spool)).toEqual([]);
  });

  test("the drain quarantines a spooled row tagged with a replaced epoch", () => {
    const root = activeRoot();
    const staleGenesis = liveGenesisIdV3(root)!;
    const fixture = eventV3Fixture("ledger.comparability_advanced", 1) as unknown as EventV3;
    const spooled = writeEventV3(root, fixture, {
      deferDrain: true,
      expectedGenesisId: staleGenesis,
    });
    expect(spooled.state).toBe("ready");
    const spooledName = basename(spooled.ready_path!);
    expect(spooledName).toContain(staleGenesis);
    const spooledRow = readFileSync(spooled.ready_path!);

    const rotated = rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 });
    expect(rotated.state).toBe("rotated");

    // Reproduce the in-flight race: a writer that passed the fence just
    // before rotation lands its tagged row in the successor epoch's spool.
    const paths = eventV3Paths(root);
    const racedPath = join(paths.spool, spooledName);
    writeFileSync(racedPath, spooledRow, { mode: 0o600 });

    expect(drainReadyEventsV3(root)).toBe(0);
    expect(existsSync(racedPath)).toBeFalse();
    expect(existsSync(`${racedPath.slice(0, -".ready".length)}.epoch-replaced`)).toBeTrue();

    const ledger = readLedgerV3(root);
    expect(ledger).toMatchObject({ complete: true, diagnostics: [] });
    expect(ledger.events.map(({ event }) => event.event_id)).not.toContain(
      String(fixture.event_id),
    );
  });

  test("route resolution rotates automatically at the configured threshold", () => {
    const root = activeRoot();
    const genesisBefore = liveGenesisIdV3(root)!;

    process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES = "1";
    const route = resolveLiveEventLedgerRouteV3(root);
    expect(route.state).toBe("v3");
    expect(archives(root)).toHaveLength(1);
    if (route.state === "v3") expect(route.genesis_id).not.toBe(genesisBefore);

    process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES = "0";
    expect(resolveLiveEventLedgerRouteV3(root).state).toBe("v3");
    expect(archives(root)).toHaveLength(1);
  });

  test("a live session survives rotation without poisoning the successor epoch", () => {
    const root = activeRoot();
    process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES = "0";

    const routeBefore = resolveLiveEventLedgerRouteV3(root);
    expect(routeBefore.state).toBe("v3");
    if (routeBefore.state !== "v3") throw new Error("expected V3 route");
    const started = recordLiveHookSignalV3({
      coordRoot: root,
      route: routeBefore,
      eventName: "session-start",
      payload: { session_id: "native-session", raw: {} },
      adapter: "claude-code",
      instanceId: "agent-Rotation",
    });
    expect(started.state).toBe("recorded");
    const startedGeneration =
      started.state === "recorded" && "generation_id" in started.event.scope
        ? started.event.scope.generation_id
        : undefined;

    const rotated = rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 });
    expect(rotated.state).toBe("rotated");
    const reanchored = readHookProducerStateV3(root, "claude-code", "native-session");
    expect(reanchored?.generation_id).toBeDefined();
    if (!reanchored) throw new Error("expected rotation-reanchored producer state");
    expect(reanchored?.generation_id).not.toBe(startedGeneration);
    expect(reanchored?.current_turn_id).toBeUndefined();

    const afterRotation = readLedgerV3(root);
    expect(afterRotation).toMatchObject({ complete: true, diagnostics: [] });
    expect(afterRotation.events.map(({ event }) => event.event_type)).toEqual([
      "ledger.genesis",
      "ledger.activated",
      "session.started",
    ]);

    const routeAfter = resolveLiveEventLedgerRouteV3(root);
    expect(routeAfter.state).toBe("v3");
    if (routeAfter.state !== "v3") throw new Error("expected V3 route");
    const resumed = recordLiveHookSignalV3({
      coordRoot: root,
      route: routeAfter,
      eventName: "user-prompt-submit",
      payload: { session_id: "native-session", prompt: "continue", raw: {} },
      adapter: "claude-code",
      instanceId: "agent-Rotation",
    });
    expect(resumed.state).toBe("recorded");
    if (resumed.state === "recorded" && "generation_id" in resumed.event.scope) {
      expect(resumed.event.scope.generation_id).toBe(reanchored.generation_id);
    }

    const ledger = readLedgerV3(root);
    expect(ledger).toMatchObject({ complete: true, diagnostics: [] });
    const archivedLedger = readFileSync(join(rotated.archived_epoch!, "active.ndjson"), "utf8");
    expect(archivedLedger).toContain("session.started");
  });
  test("a late old-epoch hook cannot overwrite rotation-reanchored state", () => {
    const root = activeRoot();
    process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES = "0";
    const instanceId = liveInstanceIdV3("agent-RacingRotation");
    const nativeSession = "native-racing-rotation";
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 route");
    const base = {
      coordRoot: root,
      mode: route.mode,
      adapter: "claude-code" as const,
      instance_id: instanceId,
      producer_id: "prd_agent-hook" as const,
      build_id: route.build_id,
      platform: "linux" as const,
    };
    expect(
      recordHookSignalV3({
        ...base,
        signal: "session-start",
        payload: { session_id: nativeSession, raw: {} },
      }).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV3({
        ...base,
        signal: "user-prompt-submit",
        payload: { session_id: nativeSession, turn_id: "turn-one", raw: {} },
      }).state,
    ).toBe("recorded");
    const generationBefore = readHookProducerStateV3(
      root,
      "claude-code",
      nativeSession,
    )?.generation_id;
    let rotationObserved = false;

    const raced = recordHookSignalV3({
      ...base,
      signal: "pre-tool-use",
      payload: {
        session_id: nativeSession,
        turn_id: "turn-one",
        tool_use_id: "tool-at-boundary",
        tool_name: "Bash",
        raw: {},
      },
      writerOptions: {
        onStep: (step) => {
          if (step !== "ready_published" || rotationObserved) return;
          rotationObserved = true;
          expect(rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 }).state).toBe("rotated");
        },
      },
    });
    expect(raced.state).toBe("recorded");
    expect(rotationObserved).toBeTrue();

    const reanchored = readHookProducerStateV3(root, "claude-code", nativeSession);
    expect(reanchored?.generation_id).toBeDefined();
    expect(reanchored?.generation_id).not.toBe(generationBefore);
    expect(reanchored?.epoch_genesis_id).toBe(liveGenesisIdV3(root));
    expect(reanchored?.current_turn_id).toBeDefined();
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
  });

  test("a mid-turn rotation reanchors the live session with an open, visible turn", () => {
    const root = activeRoot();
    process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES = "0";
    const instanceId = "agent-MidTurn";
    const nativeSession = "native-mid-turn";
    const record = (
      eventName: string,
      payload: Record<string, unknown>,
      options: { defer_drain?: boolean } = {},
    ) => {
      const route = resolveLiveEventLedgerRouteV3(root);
      if (route.state !== "v3") throw new Error("expected V3 route");
      return recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName,
        payload: { session_id: nativeSession, raw: {}, ...payload },
        adapter: "claude-code",
        instanceId,
        ...options,
      });
    };

    expect(record("session-start", {}).state).toBe("recorded");
    expect(record("user-prompt-submit", { turn_id: "turn-one", prompt: "go" }).state).toBe(
      "recorded",
    );
    expect(
      record(
        "pre-tool-use",
        { turn_id: "turn-one", tool_use_id: "tool-1", tool_name: "Bash" },
        { defer_drain: true },
      ).state,
    ).toBe("recorded");

    // The active segment crosses the threshold while the turn is still running.
    const rotated = rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 });
    expect(rotated.state).toBe("rotated");

    // Rotation itself has already re-anchored the session and open turn.
    // Nothing below relies on another adapter hook arriving first.
    const state = readHookProducerStateV3(root, "claude-code", nativeSession);
    expect(state?.current_turn_id).toBeDefined();
    expect(state?.current_turn_span).toBeDefined();

    const ledger = readLedgerV3(root);
    expect(ledger).toMatchObject({ complete: true, diagnostics: [] });
    const types = ledger.events.map(({ event }) => event.event_type);
    expect(types).toEqual([
      "ledger.genesis",
      "ledger.activated",
      "session.started",
      "turn.started",
    ]);
    const turnStarted = ledger.events.find(({ event }) => event.event_type === "turn.started");
    expect(turnStarted?.event.provenance.attestation).toBe("derived");
    expect(turnStarted?.event.provenance.source_event).toBe("claude-code.epoch-rotation-reanchor");
    expect(readdirSync(eventV3Paths(root).spool).filter((n) => n.endsWith(".ready"))).toEqual([]);

    // Authority commands can see the session again without a new prompt.
    const view = readCoordinationViewV3(root);
    expect(view.authority_safe).toBeTrue();
    expect(view.instances[liveInstanceIdV3(instanceId)]?.authority_eligible).toBeTrue();

    // Command telemetry joins the open turn instead of refusing turn_not_started.
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 route");
    const command = recordCommandSignalV3({
      coordRoot: root,
      mode: route.mode,
      signal: "command.started",
      observation: {
        native_command_id: "cmd-after-rotation",
        argv: ["toolkit", "agents", "status", "--end-turn"],
        intent: "close the turn",
        executable: "toolkit",
        intent_kind: "status",
        sensitive_argument_count: 0,
      },
      adapter: "claude-code",
      instance_id: liveInstanceIdV3(instanceId),
      producer_id: "prd_session-tee",
      build_id: route.build_id,
      platform: "linux",
    });
    expect(command.state).toBe("recorded");

    // A later tool hook keeps using the carried-forward generation. Its
    // deferred event may wait in the spool without affecting command joins.
    const afterRotation = record(
      "pre-tool-use",
      { turn_id: "turn-one", tool_use_id: "tool-2", tool_name: "Bash" },
      { defer_drain: true },
    );
    expect(afterRotation.state).toBe("recorded");
    expect(readHookProducerStateV3(root, "claude-code", nativeSession)?.generation_id).toBe(
      state?.generation_id,
    );

    // The next native prompt closes the derived turn and opens its own.
    expect(record("user-prompt-submit", { turn_id: "turn-two", prompt: "next" }).state).toBe(
      "recorded",
    );
    const settled = readLedgerV3(root);
    expect(settled).toMatchObject({ complete: true, diagnostics: [] });
    const settledTypes = settled.events.map(({ event }) => event.event_type);
    expect(settledTypes.filter((type) => type === "turn.started")).toHaveLength(2);
    expect(settledTypes).toContain("turn.completed");
    expect(readHookProducerStateV3(root, "claude-code", nativeSession)?.turn_ordinal).toBe(2);
  });
});
