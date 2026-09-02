import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { readHookProducerStateV3 } from "./producers/recorder.ts";
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

    const producerDirectory = join(
      root,
      ".harnery",
      "ledgers",
      "v3",
      "private-producers",
      "claude-code",
    );
    const producerFile = readdirSync(producerDirectory).find((name) => name.endsWith(".json"));
    expect(producerFile).toBeDefined();
    const archivedStateCopy = join(freshRoot(), "stale-producer-state.json");
    copyFileSync(join(producerDirectory, producerFile!), archivedStateCopy);

    const rotated = rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 });
    expect(rotated.state).toBe("rotated");

    // Reproduce the post-rotation republish race: a hook that read its state
    // before rotation writes that state back into the successor's directory.
    mkdirSync(producerDirectory, { recursive: true, mode: 0o700 });
    copyFileSync(archivedStateCopy, join(producerDirectory, producerFile!));

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
      // The stale authority was never adopted: the session re-onboarded into
      // a fresh generation whose sequences and causal links are epoch-local.
      expect(resumed.event.scope.generation_id).not.toBe(startedGeneration);
    }

    const ledger = readLedgerV3(root);
    expect(ledger).toMatchObject({ complete: true, diagnostics: [] });
    const archivedLedger = readFileSync(join(rotated.archived_epoch!, "active.ndjson"), "utf8");
    expect(archivedLedger).toContain("session.started");
  });
  test("a mid-turn rotation re-onboards the live session with an open, visible turn", () => {
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

    // The next hook is a tool signal with a deferred drain, exactly as the
    // adapter delivers it: not a user prompt, and nothing else drains for it.
    const afterRotation = record(
      "pre-tool-use",
      { turn_id: "turn-one", tool_use_id: "tool-2", tool_name: "Bash" },
      { defer_drain: true },
    );
    expect(afterRotation.state).toBe("recorded");

    const state = readHookProducerStateV3(root, "claude-code", nativeSession);
    expect(state?.current_turn_id).toBeDefined();
    expect(state?.current_turn_span).toBeDefined();

    // Onboarding committed eagerly: the successor ledger already holds the
    // derived session.started and turn.started, while the tool request itself
    // still waits in the spool as the deferring hook asked.
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
    expect(turnStarted?.event.provenance.source_event).toBe("claude-code.recovery");
    expect(readdirSync(eventV3Paths(root).spool).filter((n) => n.endsWith(".ready"))).toHaveLength(
      1,
    );

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
